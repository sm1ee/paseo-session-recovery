import type { PaseoAgent } from "@getpaseo/client";
import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GoalDetails, GoalReading } from "./goals";
import { goalObjectiveError } from "../shared/goal-editor";
import type { GoalAction } from "../shared/goal-actions";

const description = "Execute an explicit user goal with persistent progress and evidence-gated completion.";
const unknown: GoalReading = { state: "unknown", key: null, evidence: true, source: "opencode" };
const cleared: GoalReading = { state: "cleared", key: null, evidence: false, source: "opencode" };
const maxBytes = 2 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function objectiveKey(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 4000 ? createHash("sha256").update(value.trim()).digest("hex") : null;
}
function focusedGoal(data: Record<string, unknown>, sessionId: string): Record<string, unknown> | undefined {
  if (!Array.isArray(data.goals)) return;
  const goals = data.goals.map(object).filter((g) => g.sessionID === sessionId), focused = goals.filter((g) => g.focused === true);
  return focused.length === 1 ? focused[0] : focused.length === 0 && goals.length === 1 && goals[0].focused === undefined ? goals[0] : undefined;
}
export function openCodeGoalDetails(value: unknown, sessionId: string, now = Date.now()): GoalDetails {
  const data = object(value), reading = readOpenCodeGoal(value, sessionId, now), goal = focusedGoal(data, sessionId);
  // Native commands own their limits. For explicit controls, report their
  // actual stopped state without inferring a stop from counters or elapsed time.
  if (goal && reading.state !== "unknown") reading.state = nativeGoalState(goal);
  const record = goal ?? (Array.isArray(data.results) ? data.results.map(object).filter((g) => g.sessionID === sessionId).at(-1) : undefined);
  const objective = reading.state !== "unknown" && typeof record?.condition === "string" ? record.condition : null;
  const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  return { reading, objective, tokenBudget: count(object(record?.options).maxTokens), tokensUsed: count(record?.totalTokens),
    revision: createHash("sha256").update(JSON.stringify({ sessionId, goalId: record?.goalId ?? null, runId: record?.runId ?? null,
      objective, state: reading.state, stopped: record?.stopped, stopReason: record?.stopReason, startedAt: record?.startedAt, options: record?.options })).digest("hex") };
}
function nativeGoalState(goal: Record<string, unknown>): GoalReading["state"] {
  return !goal.stopped ? "active" : goal.stopReason === "blocked" ? "blocked"
    : /^max (?:turns|(?:context )?tokens|duration) reached\b/.test(String(goal.stopReason)) ? "limited" : "paused";
}

// OpenCode modes are agents, including custom agents named "goal". Require the
// goal plugin's registration as well as its versioned, session-matched state.
export function openCodeGoalMode(agent: Pick<PaseoAgent, "currentModeId" | "availableModes" | "runtimeInfo">): string | null {
  const mode = agent.currentModeId === undefined ? agent.runtimeInfo?.modeId : agent.currentModeId;
  return mode && agent.availableModes?.some((m) => m.id === mode && m.description === description) ? mode : null;
}

export function openCodeEnvironment(config: unknown, provider: string): Record<string, string> | null {
  const providers = object(object(object(config).agents).providers), chain: Record<string, unknown>[] = [], seen = new Set<string>();
  let id = provider;
  while (true) {
    if (seen.has(id) || seen.size >= 10) throw new Error("Invalid provider inheritance");
    seen.add(id); const entry = object(providers[id]); chain.unshift(entry);
    if (id === "opencode") break;
    if (typeof entry.extends !== "string") return null;
    id = entry.extends;
  }
  return Object.assign({}, ...chain.map((entry) => Object.fromEntries(Object.entries(object(entry.env)).filter((pair): pair is [string, string] => typeof pair[1] === "string"))));
}

// Read only the focused objective. Background and queued goals must never
// inherit the selected goal's continuation or budget.
export function readOpenCodeGoal(value: unknown, sessionId: string, now = Date.now()): GoalReading {
  const data = object(value);
  if (data.version !== 1 || !Array.isArray(data.goals) || !Array.isArray(data.results) || data.goals.length > 2000 || data.results.length > 2000) return unknown;
  const goals = data.goals.map(object).filter((g) => g.sessionID === sessionId);
  const goal = focusedGoal(data, sessionId);
  if (goals.length && !goal) return unknown;
  if (!goal) {
    const last = data.results.map(object).filter((r) => r.sessionID === sessionId).at(-1);
    if (!last) return cleared;
    const key = objectiveKey(last.condition);
    if (last.state === "achieved" || last.state === "completed" || last.state === "complete") return { state: "complete", key, evidence: true, source: "opencode" };
    return { ...unknown, key };
  }
  const key = objectiveKey(goal.condition);
  if (!key || typeof goal.stopped !== "boolean" || typeof goal.stopReason !== "string") return unknown;
  const options = object(goal.options);
  if (![options.maxTurns, options.maxTokens, options.maxDurationMs].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)
    || ![goal.turnCount, goal.totalTokens, goal.startedAt].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return unknown;
  const limit = typeof options.maxTurns === "number" && options.maxTurns > 0 && typeof goal.turnCount === "number" && goal.turnCount >= options.maxTurns
    || typeof options.maxTokens === "number" && options.maxTokens > 0 && typeof goal.totalTokens === "number" && goal.totalTokens >= options.maxTokens
    || typeof options.maxDurationMs === "number" && options.maxDurationMs > 0 && typeof goal.startedAt === "number" && now - goal.startedAt >= options.maxDurationMs;
  const state = limit ? "limited" : nativeGoalState(goal);
  return { state, key, evidence: true, source: "opencode",
    ...(state === "active" && (goal.continuationClaim != null || options.noContinueWhileChildrenActive === true) ? { nativeContinuation: true } : {}) };
}

export class OpenCodeGoals {
  constructor(private readonly home: string) {}
  async read(agent: PaseoAgent): Promise<GoalReading | null> {
    return (await this.load(agent))?.reading ?? null;
  }
  async details(agent: PaseoAgent): Promise<GoalDetails | null> { return (await this.load(agent))?.details ?? null; }
  async control(agent: PaseoAgent, revision: string, action: GoalAction, check: () => void, send: () => Promise<void>): Promise<GoalReading> {
    const before = await this.load(agent); check();
    if (!before?.record || typeof before.record.goalId !== "string" || !before.record.goalId || before.details.revision !== revision || !before.details.reading.key || !before.details.objective ||
      !(action === "pause" ? before.details.reading.state === "active" : ["paused", "blocked", "limited"].includes(before.details.reading.state))) throw new Error("The OpenCode goal changed. Reload before trying again.");
    await send(); check();
    for (let n = 0; n < 20; n++) {
      const after = await this.load(agent); check();
      if (!after?.record || after.details.reading.key !== before.details.reading.key || after.record.goalId !== before.record.goalId ||
        JSON.stringify(after.record.options) !== JSON.stringify(before.record.options)) throw new Error("The OpenCode goal identity or limits changed. Reload before trying again.");
      // Resume deliberately starts the native plugin's new budget window.
      // Pause must preserve the current window and its cumulative usage.
      if (action === "pause" && (after.record.startedAt !== before.record.startedAt ||
        after.record.runId !== before.record.runId ||
        (after.record.turnCount as number) < (before.record.turnCount as number) || (after.record.totalTokens as number) < (before.record.totalTokens as number))) throw new Error("The OpenCode budget changed while pausing. Check its native state.");
      if (after.details.reading.state === (action === "pause" ? "paused" : "active")) return after.details.reading;
      if (!["active", "paused", "blocked"].includes(after.details.reading.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 250)); check();
    }
    throw new Error("OpenCode has not confirmed the goal action. Check the conversation and reload before trying again.");
  }
  async edit(agent: PaseoAgent, revision: string, objective: string, check: () => void, send: () => Promise<void>): Promise<GoalReading> {
    const invalid = goalObjectiveError(objective, "opencode"); if (invalid) throw new Error(invalid);
    const before = await this.load(agent); check();
    if (!before || before.details.revision !== revision) throw new Error("The OpenCode goal changed. Reload the editor before saving.");
    const { details, record } = before;
    if (!record || typeof record.goalId !== "string" || !record.goalId || !details.objective || !["active", "paused", "blocked", "limited"].includes(details.reading.state)) throw new Error("This OpenCode goal cannot be edited in its current state. Review its native state.");
    const text = objective.trim(); if (text === details.objective.trim()) return details.reading;
    await send(); check();
    for (let n = 0; n < 20; n++) {
      const after = await this.load(agent); check();
      if (after?.details.objective?.trim() === text && after.record) {
        if (after.record.goalId !== record.goalId || after.record.startedAt !== record.startedAt || JSON.stringify(after.record.options) !== JSON.stringify(record.options)
          || typeof after.record.turnCount !== "number" || after.record.turnCount < (record.turnCount as number)
          || typeof after.record.totalTokens !== "number" || after.record.totalTokens < (record.totalTokens as number)) throw new Error("OpenCode's goal identity or budget changed. Check the conversation before editing again.");
        if (["active", "paused", "blocked", "limited"].includes(after.details.reading.state)) return after.details.reading;
      }
      if (after && after.details.revision !== revision && after.details.objective?.trim() !== text) break;
      await new Promise((resolve) => setTimeout(resolve, 250)); check();
    }
    throw new Error("OpenCode has not confirmed the edited goal. Check the conversation and reload before trying again.");
  }
  private async load(agent: PaseoAgent): Promise<{ details: GoalDetails; reading: GoalReading; record?: Record<string, unknown> } | null> {
    let config: unknown = {};
    try { config = JSON.parse(await readFile(join(this.home, "config.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const env = openCodeEnvironment(config, agent.provider);
    if (!env) return null;
    // Stored Paseo payloads have no availableModes. A canonical recorded Goal
    // mode can still be verified from its versioned, session-matched snapshot.
    // A live conflicting registration or explicit non-Goal mode still wins.
    const recordedMode = agent.currentModeId === undefined ? agent.runtimeInfo?.modeId : agent.currentModeId;
    const modeId = openCodeGoalMode(agent) ?? (!agent.availableModes?.length && recordedMode === "goal" ? "goal" : null);
    const empty = (reading: GoalReading) => ({ reading, details: { reading, objective: null, revision: "", tokenBudget: null, tokensUsed: null } });
    if (!modeId) return empty(cleared);
    const sessionId = agent.persistence?.sessionId;
    if (!sessionId || !agent.cwd) return empty(unknown);
    // Default project-local shards and the documented environment override.
    // Never import the plugin: doing so would acquire its lease and mutate state.
    const configured = env.OPENCODE_GOAL_STATE_PATH ?? process.env.OPENCODE_GOAL_STATE_PATH;
    const base = configured?.trim() ? resolve(agent.cwd, configured.trim()) : join(agent.cwd, ".opencode", "goals", "state.json");
    const shard = join(`${base}.sessions`, createHash("sha256").update(sessionId).digest("hex"), "state.json");
    try {
      const state = await this.snapshot(shard);
      const details = openCodeGoalDetails(state, sessionId);
      details.reading = { ...details.reading, modeId };
      return { details, reading: { ...readOpenCodeGoal(state, sessionId), modeId }, record: focusedGoal(object(state), sessionId) };
    } catch { return empty(unknown); }
  }
  private async snapshot(path: string): Promise<unknown> {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) throw new Error("Unavailable goal snapshot");
    const file = await open(path, "r");
    try {
      const info = await file.stat({ bigint: true });
      if (info.ino !== before.ino || info.dev !== before.dev) throw new Error("Goal snapshot changed");
      const buffer = Buffer.alloc(Number(before.size) + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const after = await lstat(path, { bigint: true });
      if (bytesRead !== Number(before.size) || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw new Error("Goal snapshot changed");
      // The native plugin commits lifecycle events before its snapshot. A newer
      // ledger can contain a stop/completion not reflected in an older snapshot.
      try {
        const ledger = await lstat(`${path}.ledger.jsonl`, { bigint: true });
        if (!ledger.isFile() || ledger.mtimeNs > after.mtimeNs) throw new Error("Goal snapshot is behind its ledger");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally { await file.close(); }
  }
}
