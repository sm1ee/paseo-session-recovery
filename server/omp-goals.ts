import type { PaseoAgent } from "@getpaseo/client";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setImmediate } from "node:timers/promises";
import { GOAL_PROMPT } from "../shared/contracts";
import type { GoalDetails, GoalReading } from "./goals";

// OMP's RPC adapter does not implement /goal. Older conversations therefore
// contain explicit user requests rather than a native GoalRuntime. Read that
// distinction from the owning session file, without restoring another process.
const coldLimit = 32 * 1024 * 1024, appendLimit = 2 * 1024 * 1024;
const chunkSize = 128 * 1024, maxNodes = 30_000, maxLine = 1024 * 1024;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const empty = (state: GoalReading["state"] = "unknown"): GoalDetails => ({ reading: { state, key: null, evidence: state === "unknown", source: "omp" }, objective: null, revision: "", tokenBudget: null, tokensUsed: null });
interface Node { parent: string | null; mode?: string; goal?: Record<string, unknown>; command?: string }
interface Index { session: string | null; nodes: Map<string, Node>; leaf: string | null; fallbackLeaf: string | null }
const index = (): Index => ({ session: null, nodes: new Map(), leaf: null, fallbackLeaf: null });
function add(state: Index, line: string): void {
  const e = object(JSON.parse(line));
  if (e.type === "title") return;
  if (e.type === "session") {
    if (state.session || e.version !== 3 || typeof e.id !== "string") throw new Error("Invalid OMP session header");
    state.session = e.id; return;
  }
  if (typeof e.id !== "string" || !(e.parentId === null || typeof e.parentId === "string") || state.nodes.has(e.id) || state.nodes.size >= maxNodes) throw new Error("Unverifiable OMP branch");
  const node: Node = { parent: e.parentId };
  if (e.type === "mode_change") { node.mode = String(e.mode); node.goal = object(object(e.data).goal); }
  if (e.type === "message") {
    const m = object(e.message);
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((b) => object(b).type === "text").map((b) => object(b).text).join("\n") : "";
      const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (match?.[1]?.trim() && match[1].trim().length <= 16_000) node.command = match[1].trim();
      if (node.command && /^(edit|status|get)$/i.test(node.command)) delete node.command;
      if (text.trim() === GOAL_PROMPT) node.command = "resume";
      if (/^(?:stop|pause|cancel|중지|멈춰|그만|일시\s?중지)(?:[.!\s]|$)/i.test(text.trim())) node.command = "pause";
    }
  }
  state.nodes.set(e.id, node);
  state.leaf = e.type === "model_usage" && (e.activeLeafId === null || typeof e.activeLeafId === "string") ? e.activeLeafId : e.id;
  if (state.leaf === e.id) state.fallbackLeaf = e.id;
}
function details(state: Index, session: string): GoalDetails {
  if (state.session !== session) return empty();
  let leaf = state.leaf;
  // Match OMP's fallback after a late-usage marker targets a removed entry.
  if (leaf !== null && !state.nodes.has(leaf)) leaf = state.fallbackLeaf;
  const branch: [string, Node][] = [], seen = new Set<string>();
  while (leaf !== null) {
    if (seen.has(leaf)) return empty(); seen.add(leaf);
    const node = state.nodes.get(leaf); if (!node) return empty();
    branch.push([leaf, node]); leaf = node.parent;
  }
  let native: GoalDetails | null = null, requested: GoalDetails | null = null;
  for (const [id, node] of branch.reverse()) {
    if (node.mode === "goal" || node.mode === "goal_paused") {
      const g = node.goal ?? {}, objective = typeof g.objective === "string" ? g.objective.trim() : "";
      const states: Record<string, GoalReading["state"]> = { active: "active", paused: "paused", complete: "complete", dropped: "cleared", "budget-limited": "limited" };
      const status = states[String(g.status)];
      if (!objective || objective.length > 16_000 || !Object.hasOwn(states, String(g.status)) || typeof g.id !== "string" || !g.id) { native = empty(); continue; }
      const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
      if (number(g.tokensUsed) === null || g.tokenBudget !== undefined && number(g.tokenBudget) === null) { native = empty(); continue; }
      native = { reading: { state: status, key: hash(objective), evidence: true, source: "omp", nativeContinuation: true }, objective,
        revision: hash(JSON.stringify([session, g.id, objective, status, g.tokenBudget])), tokenBudget: number(g.tokenBudget), tokensUsed: number(g.tokensUsed) };
    } else if (node.mode === "none" && native) native = empty("cleared");
    if (!node.command) continue;
    const op = /^(pause|resume|clear|drop|stop|off|cancel)(?:\s|$)/i.exec(node.command)?.[1].toLowerCase();
    if (op) {
      if (requested?.objective) {
        const status = op === "resume" ? "active" : op === "pause" || op === "stop" ? "paused" : "cleared";
        const previous: GoalDetails = requested;
        requested = Object.assign({}, previous, { reading: Object.assign({}, previous.reading, { state: status }), revision: hash(JSON.stringify([session, id, previous.objective, status])) });
        if (status === "cleared") requested = { ...empty("cleared"), revision: requested.revision };
      }
    } else requested = { reading: { state: "active", key: hash(node.command), evidence: true, source: "omp" }, objective: node.command,
      revision: hash(JSON.stringify([session, id, node.command])), tokenBudget: null, tokensUsed: null, sessionControls: true };
  }
  return native ?? requested ?? empty("cleared");
}

export function readOmpGoal(text: string, session: string): GoalDetails {
  if (!text.endsWith("\n")) return empty();
  try { const state = index(); for (const line of text.split("\n")) if (line.trim()) add(state, line); return details(state, session); }
  catch { return empty(); }
}
interface Cached { path: string; session: string; inode: bigint; dev: bigint; size: number; mtime: bigint; offset: number; index: Index; value: GoalDetails }
export class OmpGoals {
  private cache = new Map<string, Cached>();
  private pending = new Map<string, Promise<GoalDetails | null>>();
  private serial: Promise<unknown> = Promise.resolve();
  // Background discovery is memory-only. Only a visible composer, explicit
  // inspection, or an already selected continuation can read a transcript.
  cached(agent: PaseoAgent): GoalDetails | null {
    if (agent.provider !== "omp") return null;
    const hit = this.cache.get(agent.id);
    return hit && hit.session === agent.persistence?.sessionId && hit.path === agent.persistence?.nativeHandle ? hit.value : null;
  }
  details(agent: PaseoAgent): Promise<GoalDetails | null> {
    if (agent.provider !== "omp" || !agent.persistence?.sessionId || !agent.persistence.nativeHandle) return Promise.resolve(null);
    const key = JSON.stringify([agent.id, agent.persistence?.sessionId, agent.persistence?.nativeHandle]);
    const pending = this.pending.get(key); if (pending) return pending;
    const task = this.serial.then(() => this.read(agent)); this.pending.set(key, task);
    this.serial = task.catch(() => {});
    void task.then(() => this.pending.delete(key), () => this.pending.delete(key)); return task;
  }
  private async read(agent: PaseoAgent): Promise<GoalDetails> {
    const session = agent.persistence?.sessionId, path = agent.persistence?.nativeHandle;
    if (!session || !path || !isAbsolute(path) || !path.endsWith(`_${session}.jsonl`)) return empty();
    try {
      const before = await lstat(path, { bigint: true }); if (!before.isFile()) return empty();
      const size = Number(before.size); let hit = this.cache.get(agent.id);
      if (hit?.session !== session || hit.path !== path || hit.inode !== before.ino || hit.dev !== before.dev || size < hit.size || size === hit.size && before.mtimeNs !== hit.mtime) hit = undefined;
      if (hit && hit.size === size && hit.mtime === before.mtimeNs) return hit.value;
      if (size - (hit?.offset ?? 0) > (hit ? appendLimit : coldLimit)) return empty();
      const file = await open(path, "r");
      try {
        const stat = await file.stat({ bigint: true }); if (stat.ino !== before.ino || stat.dev !== before.dev) return empty();
        const state = hit?.index ?? index(); let offset = hit?.offset ?? 0, tail = Buffer.alloc(0), readOffset = offset;
        const buffer = Buffer.alloc(chunkSize);
        while (readOffset < size) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - readOffset), readOffset);
          if (!bytesRead) throw new Error("Incomplete OMP history");
          readOffset += bytesRead; tail = Buffer.concat([tail, buffer.subarray(0, bytesRead)]);
          let start = 0, end: number;
          while ((end = tail.indexOf(10, start)) >= 0) {
            const line = tail.subarray(start, end).toString("utf8"); if (line.trim()) add(state, line);
            offset += end + 1 - start; start = end + 1;
          }
          tail = tail.subarray(start); if (tail.length > maxLine) throw new Error("OMP history row exceeds read budget");
          await setImmediate();
        }
        const after = await lstat(path, { bigint: true });
        if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw new Error("OMP history changed during inspection");
        const value = tail.length ? empty() : details(state, session);
        this.cache.delete(agent.id);
        while (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(agent.id, { path, session, inode: before.ino, dev: before.dev, size, mtime: before.mtimeNs, offset, index: state, value });
        return value;
      } finally { await file.close(); }
    } catch { this.cache.delete(agent.id); return empty(); }
  }
}
