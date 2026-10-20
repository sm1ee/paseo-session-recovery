import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readGoal, type GoalDetails, type GoalReading } from "./goals";
import { goalObjectiveError } from "../shared/goal-editor";

export type CodexGoalDetails = GoalDetails;

export interface CodexLaunch { command: string; args: string[]; env: Record<string, string> }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function codexLaunch(config: unknown, provider: string): CodexLaunch | null {
  const providers = record(record(record(config).agents).providers);
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let id = provider;
  while (true) {
    if (seen.has(id) || seen.size > 10) throw new Error("Invalid provider inheritance");
    seen.add(id); const entry = record(providers[id]); chain.unshift(entry);
    if (id === "codex") break;
    if (typeof entry.extends !== "string") return null;
    id = entry.extends;
  }
  let command = ["codex"];
  let env: Record<string, string> = {};
  for (const entry of chain) {
    if (Array.isArray(entry.command) && entry.command.length && entry.command.every((v) => typeof v === "string" && v)) command = entry.command as string[];
    env = { ...env, ...Object.fromEntries(Object.entries(record(entry.env)).filter((pair): pair is [string, string] => typeof pair[1] === "string")) };
  }
  return { command: command[0], args: [...command.slice(1), "app-server", "--enable", "goals"], env };
}

export class CodexGoalConnection {
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<void> | undefined;
  private nextId = 0;
  private buffer = "";
  private closed = false;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly launch: CodexLaunch, private readonly cwd: string, private readonly timeoutMs = 10_000) {}
  private fail(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("Codex goal lookup is unavailable")); }
    this.pending.clear(); this.ready = undefined;
  }
  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex goal lookup timed out")); void this.close(); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => { if (error) this.fail(); });
    });
  }
  private start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Goal reader is closed"));
    if (this.ready) return this.ready;
    this.buffer = "";
    // This subprocess only initializes and reads goals. Goal changes and turns
    // go through the owning Paseo connection, which holds Codex's writer lease.
    const child = spawn(this.launch.command, this.launch.args, { cwd: this.cwd, env: { ...process.env, ...this.launch.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr.resume();
    child.on("error", () => this.fail());
    child.on("exit", () => { if (this.child === child) { this.child = undefined; this.fail(); } });
    child.stdin.on("error", () => this.fail());
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 1_000_000) { this.fail(); void this.close(); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let message: Record<string, unknown>;
        try { message = record(JSON.parse(line)); } catch { continue; }
        if (typeof message.id !== "number") continue;
        const pending = this.pending.get(message.id); if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error("Codex goal lookup was rejected")); else pending.resolve(message.result);
      }
    });
    this.ready = (async () => {
      await this.request("initialize", { clientInfo: { name: "paseo-session-recovery", version: "0.2.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    })();
    return this.ready;
  }
  async read(threadId: string): Promise<GoalReading> {
    return this.decode(await this.get(threadId));
  }
  async details(threadId: string): Promise<CodexGoalDetails> {
    const data = await this.get(threadId), goal = record(data.goal);
    const objective = typeof goal.objective === "string" ? goal.objective : null;
    // Usage changes while a turn is running. A changed objective, native state,
    // identity or budget invalidates the editor; ordinary usage increments do not.
    const revision = createHash("sha256").update(JSON.stringify({
      id: goal.id ?? null, objective, status: goal.status ?? null,
      createdAt: goal.createdAt ?? goal.created_at ?? null, tokenBudget: goal.tokenBudget ?? null,
    })).digest("hex");
    const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    return { reading: this.decode(data), objective, revision, tokenBudget: count(goal.tokenBudget), tokensUsed: count(goal.tokensUsed) };
  }
  async edit(threadId: string, revision: string, objective: string, check: () => void, send: () => Promise<void>): Promise<GoalReading> {
    const invalid = goalObjectiveError(objective); if (invalid) throw new Error(invalid);
    const before = await this.details(threadId); check();
    if (before.revision !== revision) throw new Error("The goal changed while you were editing. Reload it and review your changes before saving.");
    if (!before.objective || !["active", "paused", "blocked"].includes(before.reading.state)) throw new Error("This goal cannot be edited in its current state. Review its native state and limits.");
    if (before.tokensUsed === null || before.tokenBudget !== null && (before.tokenBudget <= 0 || before.tokensUsed >= before.tokenBudget)) throw new Error("The native goal budget could not be verified. Review its limits before editing.");
    const text = objective.trim();
    if (text === before.objective.trim()) return before.reading;
    // Only the owning Paseo connection may write. This reader never acquires
    // the thread writer lease or issues thread/goal/set itself.
    await send(); check();
    for (let n = 0; n < 20; n++) {
      const after = await this.details(threadId); check();
      if (after.objective?.trim() === text && after.reading.state === "active") {
        if (after.tokenBudget !== before.tokenBudget || before.tokensUsed !== null && (after.tokensUsed === null || after.tokensUsed < before.tokensUsed)) {
          throw new Error("The native goal budget changed. Check the conversation before making another change.");
        }
        return after.reading;
      }
      if (after.revision !== revision && after.objective?.trim() !== text) break;
      await new Promise((resolve) => setTimeout(resolve, 250)); check();
    }
    throw new Error("Codex has not confirmed the edited goal. Check the conversation and reload the editor before trying again.");
  }
  private async get(threadId: string): Promise<Record<string, unknown>> {
    await this.start();
    const data = record(await this.request("thread/goal/get", { threadId }));
    if (!("goal" in data)) throw new Error("Unrecognized Codex goal response");
    return data;
  }
  private decode(data: Record<string, unknown>): GoalReading {
    if (data.goal === null) return { state: "cleared", key: null, evidence: false, source: "codex" };
    return { ...readGoal([{ type: "tool_call", name: "get_goal", status: "completed", detail: { type: "unknown", input: {}, output: data.goal } }]), source: "codex" };
  }
  async resumeBlocked(threadId: string, key: string, check: () => void, send: () => Promise<void>): Promise<GoalReading> {
    const data = await this.get(threadId); check();
    const before = this.decode(data), goal = record(data.goal);
    if (before.state !== "blocked" || before.key !== key) throw new Error("The Codex goal changed. Check it before trying again.");
    if (typeof goal.tokensUsed !== "number" || !Number.isFinite(goal.tokensUsed) || goal.tokensUsed < 0 ||
      goal.tokenBudget !== null && (typeof goal.tokenBudget !== "number" || !Number.isFinite(goal.tokenBudget) || goal.tokenBudget <= 0 || goal.tokensUsed >= goal.tokenBudget)) {
      throw new Error("The Codex goal's usage limit could not be cleared safely. Review its native budget.");
    }
    check();
    // Paseo's native /goal resume uses the connection that owns the thread.
    // Never write its database or retry a command whose receipt was lost.
    await send(); check();
    for (let n = 0; n < 20; n++) {
      const after = await this.read(threadId); check();
      if (after.key !== key || after.state !== "blocked" && after.state !== "active") break;
      if (after.state === "active") return after;
      await new Promise((resolve) => setTimeout(resolve, 250)); check();
    }
    throw new Error("Codex has not confirmed that the same goal resumed. Check the conversation before trying again.");
  }
  async close(): Promise<void> {
    this.closed = true; this.fail();
    const child = this.child; this.child = undefined;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 1000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
export class CodexGoals {
  private readers = new Map<string, { signature: string; reader: CodexGoalConnection }>();
  private closed = false;
  constructor(private readonly home: string) {}
  private async reader(provider: string): Promise<CodexGoalConnection | null> {
    const config = JSON.parse(await readFile(join(this.home, "config.json"), "utf8"));
    if (this.closed) throw new Error("Goal reader is closed");
    const launch = codexLaunch(config, provider); if (!launch) return null;
    const signature = createHash("sha256").update(JSON.stringify(launch)).digest("hex");
    let current = this.readers.get(provider);
    while (current && current.signature !== signature) {
      this.readers.delete(provider); await current.reader.close();
      if (this.closed) throw new Error("Goal reader is closed");
      current = this.readers.get(provider);
    }
    if (current?.signature !== signature) {
      current = { signature, reader: new CodexGoalConnection(launch, this.home) };
      this.readers.set(provider, current);
    }
    return current.reader;
  }
  async read(provider: string, threadId: string): Promise<GoalReading | null> {
    if (this.closed) return { state: "unknown", key: null, evidence: true };
    const reader = await this.reader(provider); if (!reader) return null;
    try { return await reader.read(threadId); }
    catch {
      await reader.close(); if (this.readers.get(provider)?.reader === reader) this.readers.delete(provider);
      return { state: "unknown", key: null, evidence: true };
    }
  }
  async resumeBlocked(provider: string, threadId: string, key: string, check: () => void, send: () => Promise<void>): Promise<GoalReading> {
    const reader = await this.reader(provider);
    if (!reader) throw new Error("Only native Codex blocked goals can be resumed from this toggle.");
    return reader.resumeBlocked(threadId, key, check, send);
  }
  async details(provider: string, threadId: string): Promise<CodexGoalDetails | null> {
    if (this.closed) throw new Error("Goal reader is closed");
    let reader: CodexGoalConnection | null = null;
    try { reader = await this.reader(provider); return reader ? await reader.details(threadId) : null; }
    catch {
      await reader?.close(); if (this.readers.get(provider)?.reader === reader) this.readers.delete(provider);
      throw new Error("The current Codex goal could not be read. Check the connection and try again.");
    }
  }
  async edit(provider: string, threadId: string, revision: string, objective: string, check: () => void, send: () => Promise<void>): Promise<GoalReading> {
    let reader: CodexGoalConnection | null;
    try { reader = await this.reader(provider); } catch { throw new Error("Codex goal commands could not be initialized. Check the provider configuration."); }
    if (!reader) throw new Error("Goal editing is currently supported for native Codex sessions.");
    return reader.edit(threadId, revision, objective, check, send);
  }
  async close(): Promise<void> { this.closed = true; for (const { reader } of this.readers.values()) await reader.close(); this.readers.clear(); }
}
