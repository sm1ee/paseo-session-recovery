import { randomUUID } from "node:crypto";
import { GOAL_PROMPT, preferences, reasonText, statusInput, type GoalControl, type Preferences, type Reason, type RecoveryRow, type RecoveryStatus, type ResumePreview } from "../shared/contracts";
import { automaticBlock, backoff, busy, emptyState, fingerprint, goalCommandReady, isGoalContinuation, isSelectedGoal, isTransient, OPEN_PHASES, snapshotBlock, time, type Agent, type RecordEntry, type SavedState } from "../shared/model";
import { openLocalHost, type RecoveryHost } from "./host";
import { RecoveryError } from "./store";
import { goalLengthLimit, editGoalInput, type GoalEditorSnapshot } from "../shared/goal-editor";
import { actOnGoalRpc, type GoalAction } from "../shared/goal-actions";

interface HookAgent { id: string; title: string | null; provider: string; workspaceId: string | null; parentAgentId: string | null }
export type RecoveryEvent =
  | { kind: "start"; agent: HookAgent; turnId: string | null }
  | { kind: "end"; agent: HookAgent; turnId: string | null; outcome: { kind: "completed" } | { kind: "canceled"; reason: string } | { kind: "failed"; error: { code?: string } } }
  | { kind: "permission"; agent: HookAgent; requestId: string }
  | { kind: "resolution"; agent: HookAgent; requestId: string; allowed: boolean }
  | { kind: "closed" | "archived"; agent: HookAgent };
interface Ticket { id: string; revision: number; generation: number; expiresAt: number; fingerprint: string; prompt: string }
interface NativeGoalResume { submitted: boolean; starts: number }
interface GoalEditTicket { id: string; generation: number; changed: number; revision: string; expected: Agent; expiresAt: number }
interface GoalActionTicket extends GoalEditTicket { action: GoalAction; source: "codex" | "opencode"; key: string }
function suspendedGoal(r: RecordEntry): boolean {
  return isSelectedGoal(r) && ["review", "stopped"].includes(r.phase) && ["goal_paused", "goal_blocked", "goal_limited", "goal_unknown"].includes(r.reason);
}
export class RecoveryService {
  private host: RecoveryHost | null = null;
  private saved: SavedState = emptyState("");
  private settings = preferences.schema.parse({});
  private generation = 0;
  private changes = new Map<string, number>();
  private goalReadBlocks = new Map<string, number>();
  private tickets = new Map<string, Ticket>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private fatal = false;
  private validSettings = false;
  private error: string | null = null;
  private scanning = false;
  private scanQueued = false;
  private lastScanAt: number | null = null;
  private cursor = 0;
  private controls = new Map<string, { at: number; generation: number; changed: number; preview: boolean; value: GoalControl }>();
  private controlRequests = new Map<string, object>();
  private controlReads = new Map<string, { signature: string; promise: Promise<GoalControl> }>();
  private nativeGoalResumes = new Map<string, NativeGoalResume>();
  private goalEditTickets = new Map<string, GoalEditTicket>();
  private goalActionTickets = new Map<string, GoalActionTicket>();
  private editorReads = new Map<string, Promise<GoalEditorSnapshot>>();
  constructor(private readonly connect = openLocalHost, private readonly now = Date.now, private readonly automaticTimer = true) {}
  private enqueue<T>(work: () => Promise<T>, report = true): Promise<T> {
    const task = this.queue.then(work);
    this.queue = task.catch((e) => { if (report || this.fatal) this.error = e instanceof RecoveryError ? e.message : "The local operation failed. Recovery is paused until the next successful check."; });
    return task;
  }
  private action<T>(work: () => Promise<T>): Promise<T> { return this.enqueue(work, false); }
  private check(generation = this.generation): void {
    if (this.stopped || this.fatal || !this.validSettings || generation !== this.generation) throw new RecoveryError("Recovery was paused or settings changed. Refresh before trying again.");
  }
  private async persist(): Promise<void> {
    if (!this.host) throw new RecoveryError("Recovery has not connected yet.");
    try { await this.host.store.save(this.saved); } catch (e) { this.fatal = true; throw e; }
  }
  private audit(r: RecordEntry, action: SavedState["history"][number]["action"], reason = r.reason): void {
    this.saved.history.push({ at: this.now(), id: r.id, action, reason, attempt: r.attempts + (r.goal?.attempts ?? 0) });
    this.saved.history = this.saved.history.slice(-100);
  }
  private set(r: RecordEntry, phase: RecordEntry["phase"], reason: Reason): void { r.phase = phase; r.reason = reason; r.dueAt = null; r.revision++; }
  private review(r: RecordEntry, reason: Reason): void { this.set(r, "review", reason); this.audit(r, "review"); }
  private scheduled(r: RecordEntry, reason: Reason): void { this.set(r, "scheduled", reason); r.dueAt = this.now() + backoff(this.settings, r.attempts); this.audit(r, "scheduled"); }
  private async ready(): Promise<RecoveryHost> {
    this.check(); if (this.host) return this.host;
    const host = await this.connect(this.settings.daemonHome);
    try {
      const saved = await host.store.load();
      this.check(); this.host = host; this.saved = saved;
      if (saved.lastBoot && saved.lastBoot !== host.bootKey) {
        for (const r of Object.values(saved.records)) {
          if (!OPEN_PHASES.has(r.phase)) continue;
          if (r.phase === "sending" || r.expectingStart) this.review(r, "uncertain_send");
          else if (r.humanRequired || r.phase === "waiting") this.review(r, "input");
          else if ((r.phase === "watching" || r.phase === "interrupted") && r.turnId) this.scheduled(r, "daemon_restart");
          else if (r.phase === "watching" || r.phase === "interrupted") this.review(r, "unknown_state");
          if (r.phase === "scheduled") r.dueAt = this.now() + (r.reason === "goal_active" ? this.settings.goalDelaySeconds * 1000 : backoff(this.settings, r.attempts));
        }
      } else if (saved.lastBoot === host.bootKey) {
        // Reloads leave an observation gap, not proof of a daemon restart.
        for (const r of Object.values(saved.records)) {
          if (r.phase === "sending" || r.expectingStart) this.review(r, "uncertain_send");
          else if (["watching", "waiting", "interrupted"].includes(r.phase)) this.review(r, r.humanRequired ? "input" : "monitor_gap");
        }
      }
      saved.lastBoot = host.bootKey;
      // Older journals contain no explicit selection. Never opt them in during an upgrade.
      for (const r of Object.values(saved.records)) {
        if (r.goal && !r.goal.selectedKey && r.reason.startsWith("goal_") && ["scheduled", "review"].includes(r.phase) && !r.humanRequired && !r.expectingStart) {
          this.set(r, "completed", "goal_unselected");
        }
      }
      await this.persist(); return host;
    } catch (e) { this.host = null; await host.close(); throw e; }
  }
  configure(settings: Preferences): Promise<void> {
    const generation = ++this.generation;
    this.tickets.clear(); this.goalEditTickets.clear(); this.goalActionTickets.clear(); clearTimeout(this.timer);
    return this.enqueue(async () => {
      if (this.stopped || generation !== this.generation) return;
      if (settings.daemonHome !== this.settings.daemonHome && this.host) { await this.host.close(); this.host = null; }
      const enabling = !this.settings.enabled && settings.enabled;
      const enablingGoals = !this.settings.continueGoals && settings.continueGoals;
      this.settings = settings;
      this.validSettings = true;
      if (enabling) for (const r of Object.values(this.saved.records)) if (r.phase === "scheduled") r.dueAt = this.now() + (r.reason === "goal_active" ? settings.goalDelaySeconds * 1000 : backoff(settings, r.attempts));
      for (const r of Object.values(this.saved.records)) {
        if (isSelectedGoal(r) && r.goal?.state === "active" && (enablingGoals && r.reason === "goal_disabled" || settings.continueGoals && r.reason === "goal_limit" && r.goal.attempts < settings.goalMaxAttempts)) this.set(r, "review", "goal_check");
      }
      try { await this.scan(generation); } finally { this.scheduleTimer(); }
    });
  }
  invalidSettings(): Promise<void> {
    this.validSettings = false;
    ++this.generation; clearTimeout(this.timer); this.tickets.clear(); this.goalEditTickets.clear(); this.goalActionTickets.clear();
    return this.enqueue(async () => { this.error = "Settings could not be read. Automatic recovery is paused."; if (this.host) await this.host.close(); this.host = null; });
  }
  private scheduleTimer(): void {
    clearTimeout(this.timer);
    if (this.stopped || !this.automaticTimer || this.fatal) return;
    this.timer = setTimeout(() => { void this.enqueue(async () => { try { await this.scan(this.generation); } finally { this.scheduleTimer(); } }).catch(() => {}); }, 10_000);
  }
  observe(event: RecoveryEvent): Promise<void> {
    const at = this.now();
    this.changes.set(event.agent.id, (this.changes.get(event.agent.id) ?? 0) + 1);
    if (event.kind !== "start" && !(event.kind === "end" && event.outcome.kind === "completed")) this.goalReadBlocks.set(event.agent.id, this.changes.get(event.agent.id)!);
    // Providers can start goal work as the native resume/edit command is handled.
    // Other events and user actions still invalidate the pending operation.
    const resuming = this.nativeGoalResumes.get(event.agent.id);
    if (event.kind === "start" && resuming?.submitted) resuming.starts++;
    return this.enqueue(async () => {
      if (this.stopped || this.fatal) return;
      const host = await this.ready(); const id = event.agent.id;
      let r = this.saved.records[id];
      if (event.kind === "start") {
        const continuing = r && OPEN_PHASES.has(r.phase) && (r.expectingStart || ["watching", "waiting"].includes(r.phase));
        r = { id, title: event.agent.title || `Untitled session (${id.slice(0, 8)})`, provider: event.agent.provider,
          workspaceId: event.agent.workspaceId, parentId: event.agent.parentAgentId, turnId: event.turnId, bootKey: host.bootKey,
          startedAt: at, lastSeenAt: at, phase: "watching", reason: "active", dueAt: null, attempts: continuing ? r!.attempts : 0,
          humanRequired: false, pendingIds: [], messageAt: null, attemptMessageId: continuing ? r!.attemptMessageId : null,
          expectingStart: false, revision: (r?.revision ?? 0) + 1, ...(r?.goal ? { goal: r.goal } : {}) };
        this.saved.records[id] = r;
        const finished = Object.values(this.saved.records).filter((x) => !OPEN_PHASES.has(x.phase)).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
        for (const old of finished.slice(200)) delete this.saved.records[old.id];
        if (Object.keys(this.saved.records).length > 2000) { this.fatal = true; throw new RecoveryError("Too many unresolved sessions are being tracked. Review the recovery queue before reloading."); }
      } else {
        if (!r || !OPEN_PHASES.has(r.phase)) return;
        if (event.kind === "end" && event.turnId && r.turnId && event.turnId !== r.turnId) return;
        r.revision++;
        if (event.kind === "permission") {
          if (!r.pendingIds.includes(event.requestId)) r.pendingIds.push(event.requestId);
          r.humanRequired = true; this.set(r, "waiting", "input");
        } else if (event.kind === "resolution") {
          const knownRequest = r.pendingIds.includes(event.requestId);
          r.pendingIds = r.pendingIds.filter((x) => x !== event.requestId);
          if (knownRequest && event.allowed && !r.pendingIds.length) { r.humanRequired = false; this.set(r, "watching", "active"); }
        } else if (event.kind === "archived") { this.set(r, "stopped", "archived"); r.expectingStart = false; }
        else if (event.kind === "closed") {
          if (["watching", "waiting", "resumed"].includes(r.phase)) {
            if (!r.humanRequired && await host.shuttingDown()) this.set(r, "interrupted", "shutdown");
            else this.review(r, r.humanRequired ? "input" : "runtime_closed");
          }
        } else if (event.kind === "end") {
          r.expectingStart = false;
          if (event.outcome.kind === "completed") {
            r.lastSeenAt = at;
            if ((this.settings.continueGoals || r.goal?.selectedKey) && r.humanRequired) this.review(r, "input");
            else if (this.settings.continueGoals || r.goal?.selectedKey) this.set(r, "review", "goal_check");
            else { this.set(r, "completed", "finished"); this.audit(r, "completed"); }
          }
          else if (event.outcome.kind === "canceled") {
            if (!r.humanRequired && await host.shuttingDown()) this.set(r, "interrupted", "shutdown");
            else { this.set(r, "stopped", "user_stop"); this.audit(r, "stopped"); }
          } else if (r.humanRequired) this.review(r, "input");
          else if (this.settings.retryTransientErrors && isTransient(event.outcome.error.code)) this.scheduled(r, "transient_error");
          else this.review(r, "provider_error");
        }
      }
      await this.persist();
    });
  }
  private async parentBlock(agent: Agent, host: RecoveryHost): Promise<boolean> {
    const seen = new Set([agent.id]); let id = agent.parentId;
    while (id) {
      if (seen.has(id) || seen.size > 20) return true;
      seen.add(id); const parent = await host.fetch(id);
      if (!parent || this.saved.excluded.includes(id) || parent.workspaceId !== agent.workspaceId || parent.archivedAt || parent.internal || busy(parent)) return true;
      id = parent.parentId;
    }
    return false;
  }
  private async verified(r: RecordEntry, host: RecoveryHost): Promise<{ agent: Agent | null; reason: Reason | null }> {
    const agent = await host.fetch(r.id);
    const workspace = agent?.workspaceId ? await host.workspace(agent.workspaceId) : null;
    let reason = snapshotBlock(agent, r, workspace);
    if (!reason && agent && await this.parentBlock(agent, host)) reason = "parent_unavailable";
    return { agent, reason };
  }
  private async inspectGoal(r: RecordEntry, host: RecoveryHost): Promise<void> {
    const reading = await host.goal?.(r.id, { allowTimeline: false }) ?? { state: "unknown" as const, key: null, evidence: false };
    if (!reading.evidence && !r.goal) { this.set(r, "completed", "finished"); this.audit(r, "completed"); return; }
    const previous = r.goal;
    const state = reading.state === "active" && !reading.key ? "unknown" : reading.state;
    const selectedKey = state === "complete" || state === "cleared" ? null : previous?.selectedKey && (!reading.key || previous.selectedKey === reading.key) ? previous.selectedKey : null;
    r.goal = { key: reading.key ?? previous?.key ?? null, state, selectedKey, attempts: !reading.key || previous?.key === reading.key || previous?.selectedKey === reading.key ? previous?.attempts ?? 0 : 0,
      ...(reading.modeId ? { modeId: reading.modeId } : {}) };
    if (state === "active") {
      if (!isSelectedGoal(r)) { this.set(r, "completed", "goal_unselected"); this.audit(r, "completed"); return; }
      if (!this.settings.continueGoals) { this.review(r, "goal_disabled"); return; }
      if (r.phase !== "scheduled" || r.reason !== "goal_active" || previous?.key !== reading.key) {
        this.scheduled(r, "goal_active"); r.dueAt = this.now() + this.settings.goalDelaySeconds * 1000;
      }
    } else if (state === "complete") { this.set(r, "completed", "goal_complete"); this.audit(r, "completed"); }
    else if (state === "paused" || state === "cleared") {
      const reason = state === "paused" ? "goal_paused" : "goal_cleared";
      if (r.phase !== "stopped" || r.reason !== reason) { this.set(r, "stopped", reason); this.audit(r, "stopped"); }
    }
    else {
      const reason = state === "blocked" ? "goal_blocked" : state === "limited" ? "goal_limited" : "goal_unknown";
      if (selectedKey) { if (r.phase !== "review" || r.reason !== reason) this.review(r, reason); }
      else { this.set(r, "completed", reason); this.audit(r, "completed"); }
    }
  }
  private async scan(generation: number): Promise<void> {
    this.scanning = true;
    try {
      this.check(generation); const host = await this.ready();
      const all = Object.values(this.saved.records).filter((r) => (OPEN_PHASES.has(r.phase) || suspendedGoal(r)) && !this.saved.excluded.includes(r.id));
      const due = all.filter((r) => r.phase === "scheduled").sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
      const watch = all.filter((r) => suspendedGoal(r) || ["watching", "waiting", "resumed"].includes(r.phase) || r.phase === "review" && ["monitor_gap", "unknown_end", "runtime_closed", "goal_check"].includes(r.reason));
      const rotating = watch.slice(this.cursor).concat(watch.slice(0, this.cursor));
      const batch = [...due.slice(0, 3), ...rotating.slice(0, 7)]; this.cursor = watch.length ? (this.cursor + 7) % watch.length : 0;
      // Read tracked sessions only. Old idle sessions are never discovered or resumed.
      for (const r of batch) {
        this.check(generation); const changed = this.changes.get(r.id) ?? 0;
        const a = await host.fetch(r.id); this.check(generation);
        if ((this.changes.get(r.id) ?? 0) !== changed) continue;
        if (!a || a.archivedAt) { this.set(r, "stopped", a ? "archived" : "missing"); continue; }
        if (a.pendingPermissions > 0) { r.humanRequired = true; this.set(r, "waiting", "input"); r.lastSeenAt = this.now(); continue; }
        if (a.activeTurn && a.pendingPermissions === 0) {
          if (r.phase !== "watching") this.set(r, "watching", "active");
          r.turnId = a.activeTurn; r.bootKey = host.bootKey; r.lastSeenAt = this.now(); r.messageAt = a.lastUserMessageAt; r.expectingStart = false; continue;
        }
        if (r.expectingStart) {
          if (this.now() - r.lastSeenAt >= 30_000) this.review(r, "uncertain_send");
          continue;
        }
        if (r.reason === "goal_check" || r.reason === "goal_active" || suspendedGoal(r)) {
          if (r.reason !== "goal_active") r.messageAt = a.lastUserMessageAt;
          await this.inspectGoal(r, host); this.check(generation);
          if ((this.changes.get(r.id) ?? 0) !== changed) continue;
          if (r.reason !== "goal_active") continue;
          if (!this.settings.enabled) continue;
          const block = automaticBlock(r, this.settings, this.now());
          if (block) { this.review(r, block); continue; }
          if ((r.dueAt ?? Infinity) <= this.now()) await this.attempt(r, false, generation);
          continue;
        }
        if (a.attentionReason === "finished" && time(a.attentionTimestamp) >= r.startedAt) {
          if (isSelectedGoal(r) && !r.humanRequired) { r.messageAt = a.lastUserMessageAt; await this.inspectGoal(r, host); }
          else { this.set(r, "completed", "finished"); this.audit(r, "completed"); }
          continue;
        }
        if (["watching", "waiting", "resumed"].includes(r.phase)) {
          if (r.expectingStart && this.now() - r.lastSeenAt < 30_000) continue;
          this.review(r, r.expectingStart ? "uncertain_send" : r.humanRequired ? "input" : "unknown_end"); continue;
        }
        if (r.phase !== "scheduled" || !this.settings.enabled) continue;
        const block = automaticBlock(r, this.settings, this.now());
        if (block) { this.review(r, block); continue; }
        if ((r.dueAt ?? Infinity) <= this.now()) await this.attempt(r, false, generation);
      }
      this.check(generation); await this.persist(); this.error = null; this.lastScanAt = this.now();
    } catch (e) {
      if (!this.fatal && this.host) { const host = this.host; this.host = null; await host.close(); }
      throw e;
    } finally { this.scanning = false; }
  }
  scanNow(): Promise<void> { return this.enqueue(() => this.scan(this.generation)); }
  requestScan(): { ok: true } {
    if (!this.scanQueued && !this.scanning && !this.stopped) {
      this.scanQueued = true; void this.enqueue(async () => { this.scanQueued = false; await this.scan(this.generation); }).catch(() => {});
    }
    return { ok: true };
  }
  private async attempt(r: RecordEntry, manual: boolean, generation: number, ticket?: Ticket): Promise<void> {
    const host = await this.ready(); const changed = this.changes.get(r.id) ?? 0;
    const guard = () => { this.check(generation); if ((this.changes.get(r.id) ?? 0) !== changed || this.saved.excluded.includes(r.id)) throw new RecoveryError("The session changed during recovery. Open it before trying again."); };
    guard();
    if (!manual) { const block = automaticBlock(r, this.settings, this.now()); if (block) { this.review(r, block); return; } }
    const goalAttempt = isGoalContinuation(r);
    if (goalAttempt) {
      const key = r.goal!.key;
      const reading = await host.goal?.(r.id); guard();
      if (!reading || reading.state !== "active" || reading.key !== key || !key) {
        await this.inspectGoal(r, host); await this.persist();
        if (manual) throw new RecoveryError("The goal changed after the preview. Check its latest state.");
        return;
      }
      if (reading.nativeContinuation) {
        if (manual) throw new RecoveryError("The provider is managing this goal's continuation. Review its native goal state before sending another message.");
        r.dueAt = this.now() + this.settings.goalDelaySeconds * 1000;
        return;
      }
    }
    const result = await this.verified(r, host); guard();
    if (result.reason || !result.agent) {
      this.review(r, result.reason ?? "unknown_state"); await this.persist();
      if (manual) throw new RecoveryError("The session cannot be resumed in its current state. Open it and review the latest state."); return;
    }
    if (ticket && (ticket.revision !== r.revision || ticket.fingerprint !== fingerprint(result.agent))) throw new RecoveryError("The session changed after the preview. Prepare recovery again.");
    const messageId = `session-recovery-${randomUUID()}`;
    // Persist intent before submission. Uncertain delivery is never automatically replayed.
    this.set(r, "sending", r.reason); r.attemptMessageId = messageId; r.expectingStart = true;
    if (goalAttempt) r.goal!.attempts++; else r.attempts++;
    r.lastSeenAt = this.now();
    await this.persist();
    try {
      guard(); await host.send(r.id, ticket?.prompt ?? (goalAttempt ? GOAL_PROMPT : this.settings.prompt), messageId, result.agent, guard);
      this.set(r, "resumed", "sent"); r.lastSeenAt = this.now(); this.audit(r, "resume");
    } catch { this.review(r, "uncertain_send"); }
    await this.persist();
  }
  exclude(id: string, excluded: boolean): Promise<{ ok: true }> {
    ++this.generation; this.tickets.clear();
    this.changes.set(id, (this.changes.get(id) ?? 0) + 1);
    return this.action(async () => {
      await this.ready(); this.saved.excluded = this.saved.excluded.filter((x) => x !== id); if (excluded) this.saved.excluded.push(id);
      const r = this.saved.records[id];
      if (r) { r.revision++; if (excluded) this.audit(r, "excluded", "excluded"); else if (OPEN_PHASES.has(r.phase)) this.review(r, "monitor_gap"); }
      await this.persist(); return { ok: true };
    });
  }
  dismiss(id: string): Promise<{ ok: true }> {
    this.changes.set(id, (this.changes.get(id) ?? 0) + 1);
    return this.action(async () => {
      await this.ready(); const r = this.saved.records[id];
      if (r && !["watching", "waiting", "sending", "resumed"].includes(r.phase)) { this.set(r, "dismissed", "dismissed"); this.audit(r, "dismissed"); await this.persist(); }
      return { ok: true };
    });
  }
  watchGoal(id: string, expectedKey?: string, resetAttempts = false, resumeBlocked = false): Promise<{ ok: true }> {
    this.changes.set(id, (this.changes.get(id) ?? 0) + 1);
    const changed = this.changes.get(id) ?? 0, generation = this.generation;
    return this.action(async () => {
      let nativeResume: NativeGoalResume | undefined;
      const guard = () => { this.check(generation); if (this.changes.get(id) !== changed + (nativeResume?.starts ?? 0)) throw new RecoveryError("The session changed. Check it before selecting its goal again."); };
      const host = await this.ready(); let a = await host.fetch(id);
      guard();
      if (!a || a.internal || a.archivedAt || this.saved.excluded.includes(id)) throw new RecoveryError("This session is unavailable or excluded from recovery.");
      const existing = this.saved.records[id];
      if (!existing && Object.keys(this.saved.records).length >= 2000) throw new RecoveryError("Too many sessions are being tracked. Review existing candidates before watching another goal.");
      if (existing?.expectingStart || existing?.phase === "sending" || existing?.reason === "uncertain_send") throw new RecoveryError("A previous continuation has uncertain delivery. Check the conversation and dismiss that candidate before watching its goal again.");
      if (resumeBlocked && existing?.reason === "user_stop") throw new RecoveryError("This session was stopped by the user. Continue it in the conversation first.");
      let reading = await host.goal?.(id); guard();
      if (!reading?.evidence) throw new RecoveryError("No supported current goal was found. Set a goal in the provider before selecting it here.");
      if (!reading.key || reading.state === "complete" || reading.state === "cleared") throw new RecoveryError("The current goal could not be verified or has already ended. Open the session and check its goal.");
      if (expectedKey && expectedKey !== reading.key) throw new RecoveryError("The goal changed. Refresh and select the new goal if you want to continue it.");
      const reactivating = resumeBlocked && reading.state === "blocked" && reading.source === "codex";
      if (reactivating) {
        if (!this.settings.enabled || !this.settings.continueGoals) throw new RecoveryError("Enable Continue selected goals in Settings before resuming this goal.");
        if (existing?.humanRequired || existing?.pendingIds.length || a.pendingPermissions !== 0) throw new RecoveryError("Answer the pending question or approval before resuming this goal.");
        if (!goalCommandReady(a)) throw new RecoveryError("Wait until the session is ready and has saved history before resuming its goal.");
        if (!resetAttempts && existing?.goal?.key === reading.key && existing.goal.attempts >= this.settings.goalMaxAttempts) throw new RecoveryError("The goal continuation limit was reached. Review it before resetting the count.");
        const workspace = a.workspaceId ? await host.workspace(a.workspaceId) : null; guard();
        if (!workspace || workspace.archived || workspace.archiving || a.parentId && (!this.settings.recoverSubagents || await this.parentBlock(a, host))) throw new RecoveryError("The workspace or parent session is unavailable for goal continuation.");
        if (!host.resumeBlockedGoal) throw new RecoveryError("This provider cannot resume blocked goals from the toggle.");
        if (!await host.supportsGoalCommand?.(id)) throw new RecoveryError("Codex goal commands are not enabled for this session. Reload it when idle.");
        guard();
        const key = reading.key;
        const at = this.now(), messageId = `session-recovery-goal-${randomUUID()}`;
        const intent: RecordEntry = { id, title: a.title, provider: a.provider, workspaceId: a.workspaceId, parentId: a.parentId,
          turnId: a.activeTurn ?? null, bootKey: host.bootKey, startedAt: at, lastSeenAt: at, phase: "sending", reason: "goal_blocked", dueAt: null,
          attempts: existing?.attempts ?? 0, humanRequired: false, pendingIds: [], messageAt: a.lastUserMessageAt,
          attemptMessageId: messageId, expectingStart: false, revision: (existing?.revision ?? 0) + 1,
          goal: { key, state: "blocked", selectedKey: key, attempts: existing?.goal?.key === key ? existing.goal.attempts : 0 } };
        this.saved.records[id] = intent; await this.persist();
        nativeResume = { submitted: false, starts: 0 };
        this.nativeGoalResumes.set(id, nativeResume);
        try {
          reading = await host.resumeBlockedGoal(id, key, a, guard, messageId, () => { nativeResume!.submitted = true; }); guard();
          if (reading.state !== "active" || reading.key !== key) throw new RecoveryError("The same goal could not be resumed. Check its latest state.");
          const latest = await host.fetch(id); guard();
          if (!latest || latest.provider !== a.provider || latest.workspaceId !== a.workspaceId || latest.parentId !== a.parentId || latest.archivedAt) throw new RecoveryError("The session changed while its goal resumed. Check it before continuing.");
          a = latest;
        } catch (error) {
          if (nativeResume.submitted) this.review(intent, "uncertain_send");
          else if (this.changes.get(id) === changed) {
            if (existing) this.saved.records[id] = existing;
            else delete this.saved.records[id];
          }
          else {
            // Keep a record for queued lifecycle events to update. It carries
            // neither a submitted message nor a new automatic goal selection.
            // A closed or stale previous turn must not swallow a new stop.
            intent.attemptMessageId = null;
            intent.goal = existing?.goal ? { ...existing.goal } : { ...intent.goal!, selectedKey: null };
            this.set(intent, "review", "goal_blocked");
          }
          await this.persist(); throw error;
        } finally { this.nativeGoalResumes.delete(id); }
      }
      const previous = this.saved.records[id]; const at = this.now();
      const goal = { key: reading.key, state: reading.state, selectedKey: reading.key, attempts: !resetAttempts && previous?.goal?.key === reading.key ? previous.goal.attempts : 0,
        ...(reading.modeId ? { modeId: reading.modeId } : {}) };
      // Selecting a goal must not replace an unresolved interruption or approval.
      if (!reactivating && previous && OPEN_PHASES.has(previous.phase) && !previous.reason.startsWith("goal_") && !["watching", "waiting"].includes(previous.phase)) {
        previous.goal = goal; previous.revision++; await this.persist(); return { ok: true };
      }
      const r: RecordEntry = { id, title: a.title, provider: a.provider, workspaceId: a.workspaceId, parentId: a.parentId,
        turnId: a.activeTurn ?? null, bootKey: host.bootKey, startedAt: at, lastSeenAt: at, phase: "review", reason: "goal_check", dueAt: null,
        attempts: previous?.attempts ?? 0, humanRequired: previous?.humanRequired || a.pendingPermissions !== 0, pendingIds: previous?.pendingIds ?? [],
        messageAt: a.lastUserMessageAt, attemptMessageId: null, expectingStart: false, revision: (previous?.revision ?? 0) + 1,
        goal };
      this.saved.records[id] = r;
      if (busy(a)) this.set(r, a.pendingPermissions > 0 ? "waiting" : "watching", a.pendingPermissions > 0 ? "input" : "active");
      else if (r.humanRequired) this.review(r, "input");
      else await this.inspectGoal(r, host);
      await this.persist(); return { ok: true };
    });
  }
  unwatchGoal(id: string): Promise<{ ok: true }> {
    this.changes.set(id, (this.changes.get(id) ?? 0) + 1);
    return this.action(async () => {
      await this.ready(); const r = this.saved.records[id];
      if (r?.goal) {
        r.goal.selectedKey = null; r.revision++;
        if (r.reason.startsWith("goal_") && ["scheduled", "review"].includes(r.phase) && !r.humanRequired && !r.expectingStart) this.set(r, "completed", "goal_unselected");
        await this.persist();
      }
      return { ok: true };
    });
  }
  goalControl(id: string, fresh = false, inspect = false, preview = false): Promise<GoalControl> {
    // History inspection is an explicit action for one opened goal screen.
    // Background mounted-composer checks must never restore a conversation.
    if (inspect) return this.inspectGoalControl(id, true, true, preview);
    const signature = `${this.generation}:${this.changes.get(id) ?? 0}`;
    const requestKey = `${id}:${preview}`;
    const pending = this.controlReads.get(requestKey);
    // 마운트된 composer의 동시 미리보기만 공유한다. 명시적인 fresh 읽기는
    // 이전 조회와 분리하여 사용자가 요청한 최신 상태를 다시 확인한다.
    if ((!fresh || preview) && pending?.signature === signature) return pending.promise;
    const promise = this.inspectGoalControl(id, fresh, false, preview);
    const entry = { signature, promise };
    this.controlReads.set(requestKey, entry);
    const clear = () => { if (this.controlReads.get(requestKey) === entry) this.controlReads.delete(requestKey); };
    void promise.then(clear, clear);
    return promise;
  }
  readGoalEditor(id: string): Promise<GoalEditorSnapshot> {
    const pending = this.editorReads.get(id); if (pending) return pending;
    const task = this.readNativeGoalEditor(id); this.editorReads.set(id, task);
    const clear = () => { if (this.editorReads.get(id) === task) this.editorReads.delete(id); };
    void task.then(clear, clear); return task;
  }
  private async readNativeGoalEditor(id: string): Promise<GoalEditorSnapshot> {
    // Explicit inspection of one session only. Do not add objective reads to
    // background discovery, persist them in the journal, or hold its scan queue.
    const { host, generation, changed } = await this.action(async () => ({ host: await this.ready(), generation: this.generation, changed: this.changes.get(id) ?? 0 }));
    const a = await host.fetch(id); this.check(generation);
    if (!a || a.internal || a.archivedAt || !a.workspaceId) throw new RecoveryError("This session is unavailable. Open a current session and try again.");
    const view: GoalEditorSnapshot = { id, title: a.title, provider: a.provider, supported: false, source: null, objective: null, state: "unknown", tokenBudget: null, tokensUsed: null, ticket: null, note: null, action: null, actionTicket: null, actionNote: null, key: null };
    const details = await host.goalDetails?.(id, { allowTimeline: false }); this.check(generation);
    if (!details) return { ...view, note: "This provider does not expose a supported goal editor. Use its native goal controls." };
    const source = details.reading.source;
    Object.assign(view, { objective: details.objective, state: details.reading.state, tokenBudget: details.tokenBudget, tokensUsed: details.tokensUsed, key: details.reading.key });
    if (!source || source === "timeline") return { ...view, note: "This provider exposes goal history for viewing. Editing and native pause/resume are unavailable through this plugin connection." };
    Object.assign(view, { supported: true, source, actionNote: source === "claude" ? "Claude does not expose a separate native pause/resume command. Replacing its goal starts a new turn and resets its timer and counters." : null });
    if (details.reading.state === "unknown") return { ...view, note: "The current native goal could not be verified. Check its state in the conversation and reload." };
    if (!details.objective) return { ...view, note: source === "opencode" && !details.reading.modeId ? "Select the registered OpenCode Goal mode and set an objective with /goal <objective>." : "There is no current goal. Set one in the conversation with /goal <objective>." };
    if (!details.reading.key || !["active", "paused", "blocked", "limited"].includes(details.reading.state) || details.objective.length > goalLengthLimit(source)) return { ...view, note: "This goal is read-only in its current state. Review it in the conversation." };
    if (source === "codex" || source === "opencode") view.action = details.reading.state === "active" ? "pause" : "resume";
    const r = this.saved.records[id];
    if (!goalCommandReady(a) || !a.sessionId || r?.humanRequired || r?.phase === "sending" || r?.expectingStart || r?.reason === "uncertain_send") return { ...view, note: "Resolve pending input or uncertain delivery in this session before editing its goal." };
    if (source !== "codex" && busy(a)) return { ...view, note: "Wait for this session's current turn to finish before editing its goal. Saving starts native goal work." };
    const workspace = await host.workspace(a.workspaceId); this.check(generation);
    if (!workspace || workspace.archived || workspace.archiving || !host.editGoal) return { ...view, note: "Native goal commands are unavailable for this session. Reload it when idle." };
    this.check(generation);
    let expected = a, ticketChanged = changed;
    if ((this.changes.get(id) ?? 0) !== changed) {
      // An active native goal can naturally finish/start turns during this
      // read. Keep its text visible and refresh the ticket's session snapshot.
      // Goal identity/revision is still rechecked by the adapter before writes.
      if ((this.goalReadBlocks.get(id) ?? -1) > changed) return { ...view, note: "The session changed. Reload to edit or control this goal." };
      const latest = await host.fetch(id); this.check(generation);
      const current = this.saved.records[id];
      const stable = ["id", "provider", "workspaceId", "parentId", "sessionId", "modeId", "lastUserMessageAt"] as const;
      if ((this.goalReadBlocks.get(id) ?? -1) > changed || !latest || !stable.every((field) => latest[field] === a[field]) || latest.internal || latest.archivedAt ||
        !goalCommandReady(latest) || current?.humanRequired || current?.reason === "user_stop" || current?.reason === "uncertain_send" ||
        current?.phase === "sending" || current?.expectingStart || source !== "codex" && busy(latest)) return { ...view, note: "The session changed. Reload to edit or control this goal." };
      expected = latest; ticketChanged = this.changes.get(id) ?? 0;
    }
    const ticket = randomUUID(), now = this.now();
    for (const [key, value] of this.goalEditTickets) if (value.expiresAt <= now) this.goalEditTickets.delete(key);
    if (this.goalEditTickets.size >= 100) this.goalEditTickets.delete(this.goalEditTickets.keys().next().value!);
    this.goalEditTickets.set(ticket, { id, generation, changed: ticketChanged, revision: details.revision, expected, expiresAt: now + 300_000 });
    if ((source === "codex" || source === "opencode") && host.controlGoal) {
      const action: GoalAction = details.reading.state === "active" ? "pause" : "resume", actionTicket = randomUUID();
      for (const [key, value] of this.goalActionTickets) if (value.expiresAt <= now) this.goalActionTickets.delete(key);
      if (this.goalActionTickets.size >= 100) this.goalActionTickets.delete(this.goalActionTickets.keys().next().value!);
      this.goalActionTickets.set(actionTicket, { id, generation, changed: ticketChanged, revision: details.revision, expected, expiresAt: now + 300_000, action, source, key: details.reading.key });
      Object.assign(view, { action, actionTicket, actionNote: source === "opencode" && action === "resume" ? "OpenCode resume starts a new native turn, token, and time budget window. Review this before resuming."
        : action === "pause" ? "Pause the native goal's continuation. A current turn may finish before work stops." : "Resume the native goal using its existing limits." });
    }
    const note = source === "claude" ? "Replacing uses Claude's native /goal command and immediately starts a turn. Claude resets its goal timer, evaluated turn count, and token-spend baseline. Existing session limits are unchanged."
      : source === "opencode" ? "Saving uses OpenCode's native /goal edit command and preserves turn/token/time budgets and history. OpenCode decides whether the edited goal can continue."
      : "Saving uses Codex's native /goal command and makes the edited goal active. Goal continuation must be selected again for the new objective.";
    return { ...view, ticket, note };
  }
  actOnGoal(input: { ticket: string; confirmBudgetReset?: boolean }): Promise<{ ok: true }> {
    const parsed = actOnGoalRpc.input.parse(input), ticket = this.goalActionTickets.get(parsed.ticket);
    this.goalActionTickets.delete(parsed.ticket);
    return this.action(async () => {
      this.check(ticket?.generation);
      if (!ticket || ticket.expiresAt <= this.now()) throw new RecoveryError("These goal controls expired. Reload before trying again.");
      if (ticket.source === "opencode" && ticket.action === "resume" && !parsed.confirmBudgetReset) throw new RecoveryError("Review and confirm OpenCode's new native budget window before resuming.");
      const { id, generation, changed } = ticket;
      const native: NativeGoalResume = { submitted: false, starts: 0 };
      const guard = () => { this.check(generation); if ((this.changes.get(id) ?? 0) !== changed + native.starts) throw new RecoveryError("The session changed. Reload its goal controls."); };
      guard(); const host = await this.ready(); guard();
      const previous = this.saved.records[id];
      if (!host.controlGoal || this.saved.excluded.includes(id) || previous?.humanRequired || previous?.phase === "sending" || previous?.expectingStart || previous?.reason === "uncertain_send") throw new RecoveryError("Resolve pending input, exclusions, or uncertain delivery before changing this goal.");
      if (!previous && Object.keys(this.saved.records).length >= 2000) throw new RecoveryError("Too many sessions are being tracked. Review the recovery queue first.");
      const at = this.now(), messageId = `session-recovery-control-${randomUUID()}`, a = ticket.expected;
      // Persist intent before handing the command to the provider. A crash or
      // lost receipt must never turn into an automatic retry or continuation.
      const intent: RecordEntry = { id, title: a.title, provider: a.provider, workspaceId: a.workspaceId, parentId: a.parentId,
        turnId: a.activeTurn ?? null, bootKey: host.bootKey, startedAt: at, lastSeenAt: at, phase: "sending", reason: "goal_check", dueAt: null,
        attempts: previous?.attempts ?? 0, humanRequired: false, pendingIds: [], messageAt: a.lastUserMessageAt, attemptMessageId: messageId,
        expectingStart: false, revision: (previous?.revision ?? 0) + 1,
        goal: { key: ticket.key, state: "unknown", selectedKey: null, attempts: previous?.goal?.key === ticket.key ? previous.goal.attempts : 0 } };
      this.saved.records[id] = intent; await this.persist();
      this.nativeGoalResumes.set(id, native);
      try {
        const reading = await host.controlGoal(id, ticket.revision, ticket.action, a, guard, messageId, () => { native.submitted = true; }); guard();
        if (reading.key !== ticket.key || reading.state !== (ticket.action === "pause" ? "paused" : "active")) throw new RecoveryError("The native goal action could not be confirmed. Reload and review its state.");
        intent.goal!.state = reading.state;
        if (previous) {
          // Native controls clear only fallback goal selection. Preserve an
          // independently tracked interruption, current turn, or user stop.
          this.saved.records[id] = { ...previous, goal: intent.goal, revision: intent.revision + 1 };
          if (previous.reason.startsWith("goal_")) this.set(this.saved.records[id], "completed", ticket.action === "pause" ? "goal_paused" : "goal_unselected");
        } else this.set(intent, "completed", ticket.action === "pause" ? "goal_paused" : "goal_unselected");
        await this.persist(); return { ok: true };
      } catch (error) {
        if (native.submitted || (this.changes.get(id) ?? 0) !== changed) this.review(intent, native.submitted ? "uncertain_send" : "goal_check");
        else if (previous) this.saved.records[id] = previous;
        else delete this.saved.records[id];
        await this.persist(); throw error;
      } finally {
        this.nativeGoalResumes.delete(id); this.controls.delete(id);
        this.changes.set(id, (this.changes.get(id) ?? 0) + 1);
      }
    });
  }
  editGoal(input: { ticket: string; objective: string }): Promise<{ ok: true }> {
    const { ticket: token, objective } = editGoalInput.parse(input);
    const ticket = this.goalEditTickets.get(token); this.goalEditTickets.delete(token);
    return this.action(async () => {
      this.check(ticket?.generation);
      if (!ticket || ticket.expiresAt <= this.now()) throw new RecoveryError("This goal editor expired. Reload the current goal before saving.");
      const { id, generation, changed } = ticket;
      const nativeEdit: NativeGoalResume = { submitted: false, starts: 0 };
      const guard = () => { this.check(generation); if ((this.changes.get(id) ?? 0) !== changed + nativeEdit.starts) throw new RecoveryError("The session changed while you were editing. Reload the current goal before saving."); };
      guard(); const host = await this.ready(); guard();
      const r = this.saved.records[id];
      if (!host.editGoal || r?.humanRequired || r?.phase === "sending" || r?.expectingStart || r?.reason === "uncertain_send") throw new RecoveryError("Review pending input or uncertain delivery in this session before editing.");
      let submitted = false;
      this.nativeGoalResumes.set(id, nativeEdit);
      try {
        const reading = await host.editGoal(id, ticket.revision, objective, ticket.expected, guard, `session-recovery-edit-${randomUUID()}`, () => { submitted = true; nativeEdit.submitted = true; });
        guard();
        if (r?.goal && reading.key !== r.goal.key) {
          r.goal = { key: reading.key, state: reading.state, selectedKey: null, attempts: 0 }; r.revision++;
          if (r.reason.startsWith("goal_") && ["scheduled", "review"].includes(r.phase) && !r.humanRequired && !r.expectingStart) this.set(r, "completed", "goal_unselected");
          await this.persist();
        }
        return { ok: true };
      } catch (error) {
        // Never automatically replay a goal edit whose result is uncertain.
        if (submitted && r?.goal) {
          r.goal.selectedKey = null; r.revision++;
          if (r.reason.startsWith("goal_") && ["scheduled", "review"].includes(r.phase)) this.review(r, "uncertain_send");
          await this.persist();
        }
        throw error;
      } finally {
        this.nativeGoalResumes.delete(id);
        this.controls.delete(id);
        this.changes.set(id, (this.changes.get(id) ?? 0) + 1);
      }
    });
  }
  private inspectGoalControl(id: string, fresh: boolean, inspect = false, preview = false): Promise<GoalControl> {
    // Passive discovery must not hold up recovery actions while a provider is slow.
    const request = {}; this.controlRequests.set(id, request);
    return (async () => {
      const { host, generation, changed } = await this.action(async () => ({ host: await this.ready(), generation: this.generation, changed: this.changes.get(id) ?? 0 }));
      const cached = this.controls.get(id);
      if (!fresh && cached && (!preview || cached.preview) && cached.generation === generation && cached.changed === changed && this.now() - cached.at < (cached.value.visible ? 15_000 : 300_000)) return cached.value;
      const a = await host.fetch(id); this.check(generation);
      const r = this.saved.records[id];
      const value: GoalControl = { id, workspaceId: a?.workspaceId ?? null, visible: false, state: null, key: null, selected: false, canSelect: false,
        automatic: this.settings.enabled && this.settings.continueGoals, attempts: 0, maxAttempts: this.settings.goalMaxAttempts, delaySeconds: this.settings.goalDelaySeconds, note: null };
      if (a && !a.internal && !a.archivedAt && a.workspaceId) {
        // Only mounted composers ask for previews. Native readers do not restore
        // a conversation. Timeline-only providers stay behind explicit inspection.
        const details = preview ? await host.goalDetails?.(id, { allowTimeline: false }) : null;
        let reading = details?.reading ?? await host.goal?.(id, { allowTimeline: inspect }) ?? { state: "unknown" as const, key: null, evidence: false }; this.check(generation);
        const snapshotOnly = reading.source === "timeline" && !reading.evidence && reading.state === "unknown" && !!r?.goal?.selectedKey;
        // 선택된 비네이티브 Goal은 마지막 검사 결과로 해제 버튼을 유지한다.
        // 이 표시 결과는 자동 전송이나 새 Goal 선택의 증거로 쓰지 않는다.
        if (snapshotOnly) reading = { ...reading, state: r!.goal!.state, key: r!.goal!.key };
        // Inspection never opts a session in, schedules a turn, or writes a recovery record.
        if ((this.changes.get(id) ?? 0) !== changed) { value.note = "The session changed while checking its goal. Try again."; return value; }
        if (preview) {
          value.objective = details?.objective ?? null; value.source = reading.source ?? null;
          value.nativeAction = (reading.source === "codex" || reading.source === "opencode") && !!reading.key
            ? reading.state === "active" ? "pause" : ["paused", "blocked", "limited"].includes(reading.state) ? "resume" : null : null;
          value.nativeActionReady = !this.saved.excluded.includes(id) && !r?.humanRequired && r?.reason !== "uncertain_send" && r?.phase !== "sending" && !r?.expectingStart &&
            goalCommandReady(a) && (reading.source === "codex" || reading.source === "opencode" && !busy(a));
        }
        const terminal = reading.state === "complete" || reading.state === "cleared";
        const selected = !terminal && !!r?.goal?.selectedKey && (!reading.key || r.goal.selectedKey === reading.key);
        value.visible = !terminal && (reading.evidence && !!reading.key || selected);
        value.state = reading.state === "active" && !reading.key ? "unknown" : reading.state;
        value.key = reading.key ?? (selected ? r?.goal?.key ?? null : null); value.selected = selected;
        value.attempts = r?.goal?.key === value.key ? r?.goal?.attempts ?? 0 : 0;
        const excluded = this.saved.excluded.includes(id);
        const uncertain = r?.reason === "uncertain_send" || r?.phase === "sending" || r?.expectingStart;
        value.canSelect = value.visible && reading.evidence && !!reading.key && !excluded && !uncertain;
        value.holdReason = !selected ? null : excluded ? "excluded" : uncertain ? "uncertain_send" : !value.automatic ? "goal_disabled"
          : r?.humanRequired || a.pendingPermissions > 0 ? "input" : value.attempts >= value.maxAttempts ? "goal_limit"
          : value.state !== "active" ? value.state === "paused" ? "goal_paused" : value.state === "blocked" ? "goal_blocked" : value.state === "limited" ? "goal_limited" : "goal_unknown"
          : r?.reason === "user_stop" || r?.phase === "review" && !r.reason.startsWith("goal_") ? r.reason : null;
        value.note = excluded ? reasonText.excluded : uncertain ? reasonText.uncertain_send : !value.automatic ? "Automatic goal continuation is off in Settings."
          : r?.humanRequired || a.pendingPermissions > 0 ? reasonText.input : value.attempts >= value.maxAttempts ? reasonText.goal_limit
          : snapshotOnly ? "Showing the last checked goal state. Automatic continuation verifies the current state again before sending."
          : reading.source === "opencode" ? value.state === "active" ? reading.nativeContinuation ? "OpenCode is managing continuation. Paseo will not send an extra message while the native continuation or child-session guard is in effect."
            : "OpenCode also runs its own goal loop. This toggle controls Paseo's fallback continuation."
            : value.state === "unknown" ? "OpenCode's current goal state could not be verified. Automatic continuation is paused."
            : "OpenCode has paused or stopped this goal. This toggle does not resume it or reset its native limits. Review it in OpenCode; /goal resume starts a new native budget window."
          : value.state !== "active" ? reasonText[value.state === "paused" ? "goal_paused" : value.state === "blocked" ? "goal_blocked" : value.state === "limited" ? "goal_limited" : "goal_unknown"] : null;
      }
      if (this.controlRequests.get(id) === request) {
        if (this.controls.size >= 2000) this.controls.delete(this.controls.keys().next().value!);
        this.controls.set(id, { at: this.now(), generation, changed, preview, value });
      }
      return value;
    })().finally(() => { if (this.controlRequests.get(id) === request) this.controlRequests.delete(id); });
  }
  prepare(id: string): Promise<ResumePreview> {
    return this.action(async () => {
      const host = await this.ready(); const r = this.saved.records[id];
      if (!r || !this.canResume(r)) throw new RecoveryError("This session does not have a recovery candidate. Open its conversation to continue it manually.");
      const changed = this.changes.get(id) ?? 0; const result = await this.verified(r, host);
      if (result.reason || !result.agent || (this.changes.get(id) ?? 0) !== changed) throw new RecoveryError("The session is active, changed, or waiting for input. Open it before resuming.");
      const token = randomUUID(); const expiresAt = this.now() + 60_000;
      for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(key);
      const prompt = isGoalContinuation(r) ? GOAL_PROMPT : this.settings.prompt;
      this.tickets.set(token, { id, revision: r.revision, generation: this.generation, expiresAt, fingerprint: fingerprint(result.agent), prompt });
      return { token, expiresAt, title: result.agent.title, prompt };
    });
  }
  resume(token: string): Promise<{ ok: true }> {
    const ticket = this.tickets.get(token); this.tickets.delete(token);
    return this.action(async () => {
      this.check(ticket?.generation);
      if (!ticket || ticket.expiresAt <= this.now()) throw new RecoveryError("This recovery preview expired. Prepare it again.");
      const r = this.saved.records[ticket.id]; if (!r || !this.canResume(r)) throw new RecoveryError("The recovery candidate is no longer available.");
      await this.attempt(r, true, ticket.generation, ticket); return { ok: true };
    });
  }
  private canResume(r: RecordEntry): boolean { return ["review", "scheduled", "interrupted"].includes(r.phase) && !r.humanRequired && !this.saved.excluded.includes(r.id) && !["uncertain_send", "new_activity", "finished", "archived", "missing", "input", "goal_check", "goal_unknown", "goal_paused", "goal_blocked", "goal_complete", "goal_cleared", "goal_limited"].includes(r.reason); }
  status(input = statusInput.parse({})): RecoveryStatus {
    const rows: RecoveryRow[] = Object.values(this.saved.records).map((r) => ({ id: r.id, title: r.title, provider: r.provider, workspaceId: r.workspaceId, parentId: r.parentId,
      phase: r.phase, reason: this.saved.excluded.includes(r.id) ? "excluded" : !this.settings.enabled && r.phase === "scheduled" ? "disabled" : r.reason,
      dueAt: r.phase === "scheduled" && this.settings.enabled ? r.dueAt : null, lastSeenAt: r.lastSeenAt, attempts: r.attempts, excluded: this.saved.excluded.includes(r.id), canResume: this.canResume(r), goalState: r.goal?.state ?? null, goalAttempts: r.goal?.attempts ?? 0, goalKey: r.goal?.key ?? null, goalSelected: !!r.goal?.selectedKey }));
    for (const id of this.saved.excluded) if (!this.saved.records[id]) rows.push({ id, title: `Excluded session (${id.slice(0, 8)})`, provider: "", parentId: null, workspaceId: null, phase: "dismissed", reason: "excluded", dueAt: null, lastSeenAt: 0, attempts: 0, excluded: true, canResume: false, goalState: null, goalAttempts: 0, goalKey: null, goalSelected: false });
    const query = input.query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (input.view === "excluded" ? !r.excluded : r.excluded) return false;
      if (input.view === "queue" && !["review", "scheduled", "interrupted", "sending"].includes(r.phase)) return false;
      if (input.view === "watching" && !["watching", "waiting", "resumed"].includes(r.phase)) return false;
      if (input.view === "goals" && !r.goalState) return false;
      if (input.view === "history" && OPEN_PHASES.has(r.phase)) return false;
      return !query || `${r.id} ${r.title} ${r.provider}`.toLowerCase().includes(query);
    }).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || b.lastSeenAt - a.lastSeenAt);
    const page = Math.min(input.page, Math.max(0, Math.ceil(filtered.length / 30) - 1));
    return { state: this.error || this.fatal ? "error" : !this.host ? "starting" : this.settings.enabled ? "running" : "paused", error: this.error, scanning: this.scanning, lastScanAt: this.lastScanAt,
      counts: { watching: rows.filter((r) => !r.excluded && ["watching", "waiting", "resumed"].includes(r.phase)).length, scheduled: rows.filter((r) => !r.excluded && r.phase === "scheduled").length, review: rows.filter((r) => !r.excluded && r.phase === "review").length, resumed: this.saved.history.filter((r) => r.action === "resume").length, excluded: this.saved.excluded.length, selectedGoals: rows.filter((r) => !r.excluded && r.goalSelected).length },
      goalContinuationEnabled: this.settings.continueGoals,
      rows: filtered.slice(page * 30, page * 30 + 30), total: filtered.length, page, history: [...this.saved.history].reverse().slice(0, 30) };
  }
  async stop(): Promise<void> {
    this.stopped = true; ++this.generation; clearTimeout(this.timer); this.tickets.clear(); this.goalEditTickets.clear(); this.goalActionTickets.clear(); await this.queue;
    const host = this.host; if (!host) return;
    try {
      if (!this.fatal && !await host.shuttingDown()) { for (const r of Object.values(this.saved.records)) if (["watching", "waiting"].includes(r.phase)) this.review(r, r.humanRequired ? "input" : "monitor_gap"); await this.persist(); }
    } finally { await host.close(); this.host = null; }
  }
}
