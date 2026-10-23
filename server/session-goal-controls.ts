import type { Agent } from "../shared/model";
import { busy, goalCommandReady } from "../shared/model";
import type { GoalAction } from "../shared/goal-actions";
import type { GoalDetails, GoalReading } from "./goals";

interface SessionControl {
  expected: Agent; revision: string; action: GoalAction;
  fetch(): Promise<Agent | null>; details(): Promise<GoalDetails | null>;
  guard(): void; submitted(): void; pause(): Promise<void>; resume(): Promise<void>;
}
// Claude has no native /goal pause or /goal resume command: those words would
// replace the objective. Use the owning session's interrupt and normal prompt.
// The same execution controls serve explicit OMP requests that never became a
// native GoalRuntime. Never clear a goal, edit JSONL, or start a second provider.
export async function controlSessionGoal(io: SessionControl): Promise<GoalReading> {
  const stable = ["id", "provider", "workspaceId", "parentId", "sessionId", "lastUserMessageAt", "modeId"] as const;
  const verify = (a: Agent | null) => {
    io.guard();
    if (!a || !io.expected.sessionId || !stable.every((k) => a[k] === io.expected[k]) || a.archivedAt || a.internal || !goalCommandReady(a) || a.activeTurn === undefined && a.status !== "closed" ||
      (io.action === "pause" ? !busy(a) || a.activeTurn !== io.expected.activeTurn : busy(a))) throw new Error("The session changed. Reload its goal controls.");
  };
  verify(await io.fetch());
  const before = await io.details(); io.guard();
  if (!before?.sessionControls || before.revision !== io.revision || !before.reading.key || !["active", "paused"].includes(before.reading.state)) throw new Error("The goal changed. Reload its goal controls.");
  verify(await io.fetch());
  io.submitted();
  if (io.action === "pause") await io.pause(); else await io.resume();
  // A receipt for the stop request alone is not proof that the turn stopped.
  for (let n = 0; n < 20; n++) {
    io.guard(); const a = await io.fetch(); io.guard();
    if (!a || a.sessionId !== io.expected.sessionId || a.provider !== io.expected.provider || a.archivedAt || a.pendingPermissions !== 0) throw new Error("The session changed after the goal action. Reload.");
    if (io.action === "pause" && !busy(a) && a.activeTurn === null && a.lastUserMessageAt === io.expected.lastUserMessageAt) return before.reading;
    if (io.action === "resume" && (a.activeTurn != null || a.lastUserMessageAt !== io.expected.lastUserMessageAt)) return before.reading;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The goal action could not be confirmed. Reload before trying again.");
}
