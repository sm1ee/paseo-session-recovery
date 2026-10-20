import { randomUUID } from "node:crypto";
import { GOAL_PROMPT, preferences, statusInput, type Preferences, type Reason, type RecoveryRow, type RecoveryStatus, type ResumePreview } from "../shared/contracts";
import { automaticBlock, backoff, busy, emptyState, fingerprint, isGoalContinuation, isTransient, OPEN_PHASES, snapshotBlock, time, type Agent, type RecordEntry, type SavedState } from "../shared/model";
import { openLocalHost, type RecoveryHost } from "./host";
import { RecoveryError } from "./store";

interface HookAgent { id: string; title: string | null; provider: string; workspaceId: string | null; parentAgentId: string | null }
export type RecoveryEvent =
  | { kind: "start"; agent: HookAgent; turnId: string | null }
  | { kind: "end"; agent: HookAgent; turnId: string | null; outcome: { kind: "completed" } | { kind: "canceled"; reason: string } | { kind: "failed"; error: { code?: string } } }
  | { kind: "permission"; agent: HookAgent; requestId: string }
  | { kind: "resolution"; agent: HookAgent; requestId: string; allowed: boolean }
  | { kind: "closed" | "archived"; agent: HookAgent };
interface Ticket { id: string; revision: number; generation: number; expiresAt: number; fingerprint: string; prompt: string }
export class RecoveryService {
  private host: RecoveryHost | null = null;
  private saved: SavedState = emptyState("");
  private settings = preferences.schema.parse({});
  private generation = 0;
  private changes = new Map<string, number>();
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
      await this.persist(); return host;
    } catch (e) { this.host = null; await host.close(); throw e; }
  }
  configure(settings: Preferences): Promise<void> {
    const generation = ++this.generation;
    this.tickets.clear(); clearTimeout(this.timer);
    return this.enqueue(async () => {
      if (this.stopped || generation !== this.generation) return;
      if (settings.daemonHome !== this.settings.daemonHome && this.host) { await this.host.close(); this.host = null; }
      const enabling = !this.settings.enabled && settings.enabled;
      const enablingGoals = !this.settings.continueGoals && settings.continueGoals;
      this.settings = settings;
      this.validSettings = true;
      if (enabling) for (const r of Object.values(this.saved.records)) if (r.phase === "scheduled") r.dueAt = this.now() + backoff(settings, r.attempts);
      for (const r of Object.values(this.saved.records)) {
        if (r.goal?.state === "active" && (enablingGoals && r.reason === "goal_disabled" || settings.continueGoals && r.reason === "goal_limit" && r.goal.attempts < settings.goalMaxAttempts)) this.set(r, "review", "goal_check");
      }
      try { await this.scan(generation); } finally { this.scheduleTimer(); }
    });
  }
  invalidSettings(): Promise<void> {
    this.validSettings = false;
    ++this.generation; clearTimeout(this.timer); this.tickets.clear();
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
            if (this.settings.continueGoals && r.humanRequired) this.review(r, "input");
            else if (this.settings.continueGoals) this.set(r, "review", "goal_check");
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
    const reading = await host.goal?.(r.id) ?? { state: "unknown" as const, key: null, evidence: false };
    if (!reading.evidence && !r.goal) { this.set(r, "completed", "finished"); this.audit(r, "completed"); return; }
    const previous = r.goal;
    const state = reading.state === "active" && !reading.key ? "unknown" : reading.state;
    r.goal = { key: reading.key, state, attempts: previous?.key === reading.key ? previous?.attempts ?? 0 : 0 };
    if (state === "active") {
      if (!this.settings.continueGoals) { this.review(r, "goal_disabled"); return; }
      if (r.phase !== "scheduled" || r.reason !== "goal_active" || previous?.key !== reading.key) {
        this.scheduled(r, "goal_active"); r.dueAt = this.now() + this.settings.goalDelaySeconds * 1000;
      }
    } else if (state === "complete") { this.set(r, "completed", "goal_complete"); this.audit(r, "completed"); }
    else if (state === "paused" || state === "cleared") { this.set(r, "stopped", state === "paused" ? "goal_paused" : "goal_cleared"); this.audit(r, "stopped"); }
    else this.review(r, state === "blocked" ? "goal_blocked" : state === "limited" ? "goal_limited" : "goal_unknown");
  }
  private async scan(generation: number): Promise<void> {
    this.scanning = true;
    try {
      this.check(generation); const host = await this.ready();
      const all = Object.values(this.saved.records).filter((r) => OPEN_PHASES.has(r.phase) && !this.saved.excluded.includes(r.id));
      const due = all.filter((r) => r.phase === "scheduled").sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
      const watch = all.filter((r) => ["watching", "waiting", "resumed"].includes(r.phase) || r.phase === "review" && ["monitor_gap", "unknown_end", "runtime_closed", "goal_check"].includes(r.reason));
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
        if (r.reason === "goal_check" || r.reason === "goal_active") {
          if (r.reason === "goal_check") r.messageAt = a.lastUserMessageAt;
          await this.inspectGoal(r, host); this.check(generation);
          if ((this.changes.get(r.id) ?? 0) !== changed) continue;
          if (r.reason !== "goal_active") continue;
          if (!this.settings.enabled) continue;
          const block = automaticBlock(r, this.settings, this.now());
          if (block) { this.review(r, block); continue; }
          if ((r.dueAt ?? Infinity) <= this.now()) await this.attempt(r, false, generation);
          continue;
        }
        if (a.attentionReason === "finished" && time(a.attentionTimestamp) >= r.startedAt) { this.set(r, "completed", "finished"); this.audit(r, "completed"); continue; }
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
  watchGoal(id: string): Promise<{ ok: true }> {
    this.changes.set(id, (this.changes.get(id) ?? 0) + 1);
    return this.action(async () => {
      const host = await this.ready(); const a = await host.fetch(id);
      if (!a || a.internal || a.archivedAt || this.saved.excluded.includes(id)) throw new RecoveryError("This session is unavailable or excluded from recovery.");
      const existing = this.saved.records[id];
      if (!existing && Object.keys(this.saved.records).length >= 2000) throw new RecoveryError("Too many sessions are being tracked. Review existing candidates before watching another goal.");
      if (existing?.expectingStart || existing?.phase === "sending" || existing?.reason === "uncertain_send") throw new RecoveryError("A previous continuation has uncertain delivery. Check the conversation and dismiss that candidate before watching its goal again.");
      const reading = await host.goal?.(id);
      if (!reading?.evidence) throw new RecoveryError("No supported goal state was found in the recent conversation. Goal tools must expose their result in Paseo.");
      const previous = this.saved.records[id]; const at = this.now();
      const r: RecordEntry = { id, title: a.title, provider: a.provider, workspaceId: a.workspaceId, parentId: a.parentId,
        turnId: a.activeTurn ?? null, bootKey: host.bootKey, startedAt: at, lastSeenAt: at, phase: "review", reason: "goal_check", dueAt: null,
        attempts: previous?.attempts ?? 0, humanRequired: previous?.humanRequired || a.pendingPermissions !== 0, pendingIds: previous?.pendingIds ?? [],
        messageAt: a.lastUserMessageAt, attemptMessageId: null, expectingStart: false, revision: (previous?.revision ?? 0) + 1,
        goal: { key: reading.key, state: reading.state, attempts: 0 } };
      this.saved.records[id] = r;
      if (busy(a)) this.set(r, a.pendingPermissions > 0 ? "waiting" : "watching", a.pendingPermissions > 0 ? "input" : "active");
      else if (r.humanRequired) this.review(r, "input");
      else await this.inspectGoal(r, host);
      await this.persist(); return { ok: true };
    });
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
      dueAt: r.phase === "scheduled" && this.settings.enabled ? r.dueAt : null, lastSeenAt: r.lastSeenAt, attempts: r.attempts, excluded: this.saved.excluded.includes(r.id), canResume: this.canResume(r), goalState: r.goal?.state ?? null, goalAttempts: r.goal?.attempts ?? 0 }));
    for (const id of this.saved.excluded) if (!this.saved.records[id]) rows.push({ id, title: `Excluded session (${id.slice(0, 8)})`, provider: "", parentId: null, workspaceId: null, phase: "dismissed", reason: "excluded", dueAt: null, lastSeenAt: 0, attempts: 0, excluded: true, canResume: false, goalState: null, goalAttempts: 0 });
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
      counts: { watching: rows.filter((r) => !r.excluded && ["watching", "waiting", "resumed"].includes(r.phase)).length, scheduled: rows.filter((r) => !r.excluded && r.phase === "scheduled").length, review: rows.filter((r) => !r.excluded && r.phase === "review").length, resumed: this.saved.history.filter((r) => r.action === "resume").length, excluded: this.saved.excluded.length },
      rows: filtered.slice(page * 30, page * 30 + 30), total: filtered.length, page, history: [...this.saved.history].reverse().slice(0, 30) };
  }
  async stop(): Promise<void> {
    this.stopped = true; ++this.generation; clearTimeout(this.timer); this.tickets.clear(); await this.queue;
    const host = this.host; if (!host) return;
    try {
      if (!this.fatal && !await host.shuttingDown()) { for (const r of Object.values(this.saved.records)) if (["watching", "waiting"].includes(r.phase)) this.review(r, r.humanRequired ? "input" : "monitor_gap"); await this.persist(); }
    } finally { await host.close(); this.host = null; }
  }
}
