import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoAgent } from "@getpaseo/client";
import type { Agent } from "../shared/model";
import { busy, goalCommandReady } from "../shared/model";
import type { GoalAction } from "../shared/goal-actions";
import type { GoalReading } from "./goals";
import { isDevinProvider, type DevinNativeInput, type DevinNativeOutput, type DevinGoalDetails } from "./devin-native-bridge";
export * from "./devin-native-bridge";

export class DevinGoals {
  private available: Promise<boolean> | undefined;
  private pending = new Map<string, Promise<DevinGoalDetails | null>>();
  constructor(private readonly home: string, private readonly rpc: (input: DevinNativeInput) => Promise<DevinNativeOutput>) {}
  async details(agent: PaseoAgent): Promise<DevinGoalDetails | null> {
    if (["codex", "claude", "omp", "pi", "opencode"].includes(agent.provider)) return null;
    let config: unknown = {};
    try { config = JSON.parse(await readFile(join(this.home, "config.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!isDevinProvider(config, agent.provider)) return null;
    const unknown = (): DevinGoalDetails => ({ reading: { source: "devin", state: "unknown", key: null, evidence: true, nativeContinuation: true }, objective: null,
      revision: "", tokenBudget: null, tokensUsed: null, nativeTurns: 0 });
    if (!agent.persistence?.sessionId || !await (this.available ??= this.rpc({ op: "capabilities" }).then(v => v.protocol === 1 && v.available, () => false))) return unknown();
    const sessionId = agent.persistence.sessionId, key = JSON.stringify([agent.id, agent.provider, sessionId]);
    const prior = this.pending.get(key); if (prior) return prior;
    const task = this.rpc({ op: "get", id: agent.id, provider: agent.provider, sessionId }).then(v => {
      if (v.protocol !== 1) throw new Error("The Devin goal protocol changed.");
      return v.available && v.details ? v.details : unknown();
    });
    this.pending.set(key, task); const clear = () => this.pending.delete(key); void task.then(clear, clear); return task;
  }
  async control(agent: PaseoAgent, revision: string, action: GoalAction, expected: Agent, io: {
    fetch(): Promise<Agent | null>; guard(): void; submitted(): void; pause(): Promise<void>; resume(): Promise<void>;
  }): Promise<GoalReading> {
    const check = async () => {
      io.guard(); const current = await io.fetch(); io.guard();
      const stable = ["id", "provider", "workspaceId", "parentId", "sessionId", "lastUserMessageAt", "modeId"] as const;
      if (!current || !expected.sessionId || !stable.every(k => current[k] === expected[k]) || !goalCommandReady(current) || current.archivedAt || current.internal ||
          (action === "pause" ? !busy(current) || !current.activeTurn || current.activeTurn !== expected.activeTurn : busy(current))) throw new Error("The Devin session changed. Reload its goal controls.");
    };
    await check(); const before = await this.details(agent); io.guard();
    if (!before?.objective || before.revision !== revision || !before.identity ||
        (action === "pause" ? before.reading.state !== "active" : !["paused", "blocked"].includes(before.reading.state))) throw new Error("The Devin goal changed. Reload its goal controls.");
    await check(); io.submitted();
    // Send the native slash command through Paseo's normal prompt/receipt path
    // so turn_started/turn_ended and the conversation stay synchronized. Calling
    // ACP goal/resume directly would bypass that foreground-turn bookkeeping.
    if (action === "pause") await io.pause(); else await io.resume();
    for (let n = 0; n < 25; n++) {
      io.guard(); const after = await this.details(agent); io.guard();
      if (!after?.identity || after.identity !== before.identity || after.objective !== before.objective) throw new Error("The Devin goal changed after the action. Reload.");
      const current = await io.fetch(); io.guard();
      if (!current || !(["id", "sessionId", "provider", "workspaceId", "parentId", "modeId"] as const).every(k => current[k] === expected[k]) || current.internal || current.archivedAt || !goalCommandReady(current)) throw new Error("The Devin session changed after the action. Reload.");
      if (action === "pause" && ["paused", "blocked", "complete"].includes(after.reading.state) && !busy(current) && current.activeTurn === null && current.lastUserMessageAt === expected.lastUserMessageAt) return after.reading;
      if (action === "resume" && (after.reading.state === "active" || ["blocked", "complete"].includes(after.reading.state) && after.nativeTurns > before.nativeTurns) &&
          (current.activeTurn != null || current.lastUserMessageAt !== expected.lastUserMessageAt)) return after.reading;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Devin has not confirmed the goal action. Reload before trying again.");
  }
}
