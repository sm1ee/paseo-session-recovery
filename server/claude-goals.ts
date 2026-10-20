import type { PaseoAgent } from "@getpaseo/client";
import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { goalObjectiveError } from "../shared/goal-editor";
import type { GoalDetails, GoalReading } from "./goals";

const maxBytes = 8 * 1024 * 1024;
const unknown: GoalReading = { state: "unknown", key: null, evidence: true, source: "claude" };
function object(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
const empty = (reading = unknown): GoalDetails => ({ reading, objective: null, revision: "", tokenBudget: null, tokensUsed: null });

export function claudeEnvironment(config: unknown, provider: string): Record<string, string> | null {
  const providers = object(object(object(config).agents).providers), chain: Record<string, unknown>[] = [], seen = new Set<string>();
  let id = provider;
  while (true) {
    if (seen.has(id) || seen.size >= 10) throw new Error("Invalid provider inheritance");
    seen.add(id); const entry = object(providers[id]); chain.unshift(entry);
    if (id === "claude") break;
    if (typeof entry.extends !== "string") return null;
    id = entry.extends;
  }
  return Object.assign({}, ...chain.map((entry) => Object.fromEntries(Object.entries(object(entry.env)).filter((pair): pair is [string, string] => typeof pair[1] === "string"))));
}

export function claudeProjectName(cwd: string): string {
  const text = process.platform === "darwin" ? cwd.normalize("NFC") : cwd, encoded = text.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 0; for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

// Claude's own restore path follows goal_status attachments in the current
// conversation. Do not infer goals from ordinary messages, skills or Task tools.
// Follow parentUuid so a rewound/abandoned branch cannot revive an old goal.
export function readClaudeGoal(text: string, sessionId: string, complete = true): GoalDetails {
  if (text && !text.endsWith("\n")) return empty();
  const nodes = new Map<string, Record<string, unknown>>();
  let head: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>; try { entry = object(JSON.parse(line)); } catch { return empty(); }
    if (entry.sessionId !== sessionId || entry.isSidechain === true || !["user", "assistant", "system", "attachment"].includes(String(entry.type))) continue;
    if (typeof entry.uuid !== "string" || !(entry.parentUuid === null || typeof entry.parentUuid === "string")) return empty();
    if (nodes.has(entry.uuid)) return empty();
    nodes.set(entry.uuid, entry); head = entry.uuid;
  }
  const seen = new Set<string>();
  while (head !== null) {
    if (seen.has(head)) return empty(); seen.add(head);
    const entry = nodes.get(head); if (!entry) return empty();
    const goal = object(entry.attachment);
    if (entry.type === "attachment" && goal.type === "goal_status") {
      const objective = typeof goal.condition === "string" ? goal.condition.trim() : "";
      if (!objective || objective.length > 4000 || typeof goal.met !== "boolean" || goal.failed !== undefined && typeof goal.failed !== "boolean") return empty();
      const state = goal.failed === true ? "cleared" : goal.met ? goal.sentinel === true ? "cleared" : "complete" : "active";
      const key = createHash("sha256").update(objective).digest("hex");
      return { reading: { state, key, evidence: true, source: "claude", ...(state === "active" ? { nativeContinuation: true } : {}) },
        objective, tokenBudget: null, tokensUsed: typeof goal.tokens === "number" && Number.isFinite(goal.tokens) && goal.tokens >= 0 ? goal.tokens : null,
        revision: createHash("sha256").update(JSON.stringify({ sessionId, uuid: entry.uuid, objective, state })).digest("hex") };
    }
    head = entry.parentUuid as string | null;
  }
  return complete ? empty({ state: "cleared", key: null, evidence: false, source: "claude" }) : empty();
}

export class ClaudeGoals {
  constructor(private readonly home: string) {}
  private async transcript(agent: PaseoAgent, env: Record<string, string>): Promise<string> {
    const sessionId = agent.persistence?.sessionId;
    if (!sessionId || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(sessionId) || !agent.cwd) throw new Error("Claude history is unavailable");
    const configDir = resolve(agent.cwd, env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")), root = join(configDir, "projects");
    const cwd = await realpath(agent.cwd), name = `${sessionId}.jsonl`, expected = join(root, claudeProjectName(cwd), name);
    try { await lstat(expected); return expected; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    // Claude can resume an existing native session in a different directory.
    // Search filenames in the configured root only; never scan other accounts.
    const directories = await readdir(root, { withFileTypes: true });
    if (directories.length > 5000) throw new Error("Claude history directory is too large");
    let found: string | undefined;
    for (const dir of directories) {
      if (!dir.isDirectory()) continue;
      const candidate = join(root, dir.name, name);
      try { await lstat(candidate); if (found) throw new Error("Ambiguous Claude history"); found = candidate; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    if (!found) throw new Error("Claude history is unavailable");
    return found;
  }
  async details(agent: PaseoAgent): Promise<GoalDetails | null> {
    let config: unknown = {};
    try { config = JSON.parse(await readFile(join(this.home, "config.json"), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const env = claudeEnvironment(config, agent.provider);
    if (!env) return null;
    if (!agent.persistence?.sessionId) return empty({ state: "cleared", key: null, evidence: false, source: "claude" });
    try {
      const path = await this.transcript(agent, env), before = await lstat(path, { bigint: true });
      if (!before.isFile()) return empty();
      const file = await open(path, "r");
      try {
        const info = await file.stat({ bigint: true });
        if (info.ino !== before.ino || info.dev !== before.dev) return empty();
        const size = Number(before.size), offset = Math.max(0, size - maxBytes), buffer = Buffer.alloc(Math.min(size, maxBytes));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset), after = await lstat(path, { bigint: true });
        if (bytesRead !== buffer.length || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeNs !== before.mtimeNs) return empty();
        const start = offset ? buffer.indexOf(10) + 1 : 0;
        if (offset && !start) return empty();
        return readClaudeGoal(buffer.subarray(start).toString("utf8"), agent.persistence.sessionId, offset === 0);
      } finally { await file.close(); }
    } catch { return empty(); }
  }
  async edit(agent: PaseoAgent, revision: string, objective: string, check: () => void, send: () => Promise<void>): Promise<GoalReading> {
    const invalid = goalObjectiveError(objective, "claude"); if (invalid) throw new Error(invalid);
    const before = await this.details(agent); check();
    if (!before || before.revision !== revision || !before.objective || before.reading.state !== "active") throw new Error("The Claude goal changed or is unavailable. Reload before saving.");
    if (objective.trim() === before.objective) return before.reading;
    // Claude replaces the condition, resets its timer/counters and starts work.
    // The editor labels this explicitly. Never clear then recreate or touch JSONL.
    await send(); check();
    for (let n = 0; n < 20; n++) {
      const after = await this.details(agent); check();
      if (after?.objective === objective.trim() && after.revision !== revision && ["active", "complete"].includes(after.reading.state)) return after.reading;
      if (after?.objective && after.revision !== revision && after.objective !== before.objective) break;
      await new Promise((resolve) => setTimeout(resolve, 250)); check();
    }
    throw new Error("Claude has not confirmed the replacement goal. Check the conversation and reload before trying again.");
  }
}
