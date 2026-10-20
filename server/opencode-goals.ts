import type { PaseoAgent } from "@getpaseo/client";
import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GoalReading } from "./goals";

const description = "Execute an explicit user goal with persistent progress and evidence-gated completion.";
const unknown: GoalReading = { state: "unknown", key: null, evidence: true, source: "opencode" };
const cleared: GoalReading = { state: "cleared", key: null, evidence: false, source: "opencode" };
const maxBytes = 2 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function objectiveKey(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 4000 ? createHash("sha256").update(value.trim()).digest("hex") : null;
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
  const focused = goals.filter((g) => g.focused === true);
  const goal = focused.length === 1 ? focused[0] : focused.length === 0 && goals.length === 1 && goals[0].focused === undefined ? goals[0] : undefined;
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
  const state = goal.stopped ? goal.stopReason === "blocked" ? "blocked" : /^max (?:turns|(?:context )?tokens|duration) reached\b/.test(goal.stopReason) ? "limited" : "paused" : limit ? "limited" : "active";
  return { state, key, evidence: true, source: "opencode",
    ...(state === "active" && (goal.continuationClaim != null || options.noContinueWhileChildrenActive === true) ? { nativeContinuation: true } : {}) };
}

export class OpenCodeGoals {
  constructor(private readonly home: string) {}
  async read(agent: PaseoAgent): Promise<GoalReading | null> {
    let config: unknown = {};
    try { config = JSON.parse(await readFile(join(this.home, "config.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const env = openCodeEnvironment(config, agent.provider);
    if (!env) return null;
    const modeId = openCodeGoalMode(agent);
    if (!modeId) return cleared;
    const sessionId = agent.persistence?.sessionId;
    if (!sessionId || !agent.cwd) return unknown;
    // Default project-local shards and the documented environment override.
    // Never import the plugin: doing so would acquire its lease and mutate state.
    const configured = env.OPENCODE_GOAL_STATE_PATH ?? process.env.OPENCODE_GOAL_STATE_PATH;
    const base = configured?.trim() ? resolve(agent.cwd, configured.trim()) : join(agent.cwd, ".opencode", "goals", "state.json");
    const shard = join(`${base}.sessions`, createHash("sha256").update(sessionId).digest("hex"), "state.json");
    try {
      const state = await this.snapshot(shard);
      return { ...readOpenCodeGoal(state, sessionId), modeId };
    } catch { return unknown; }
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
