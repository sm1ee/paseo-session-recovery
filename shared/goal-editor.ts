import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_GOAL_LENGTH = 16_000;
export type GoalEditorSource = "codex" | "opencode" | "claude";
export function goalLengthLimit(source: GoalEditorSource | null): number { return source === "opencode" || source === "claude" ? 4000 : MAX_GOAL_LENGTH; }
export const goalEditorSchema = z.object({
  id: z.string(), title: z.string(), provider: z.string(), supported: z.boolean(),
  source: z.enum(["codex", "opencode", "claude"]).nullable().default(null),
  objective: z.string().nullable(), state: z.enum(["active", "paused", "blocked", "limited", "complete", "cleared", "unknown"]),
  tokenBudget: z.number().finite().nonnegative().nullable(), tokensUsed: z.number().finite().nonnegative().nullable(),
  ticket: z.string().nullable(), note: z.string().nullable(),
  action: z.enum(["pause", "resume"]).nullable().optional(), actionTicket: z.string().nullable().optional(),
  actionNote: z.string().nullable().optional(), key: z.string().nullable().optional(),
});
export type GoalEditorSnapshot = z.infer<typeof goalEditorSchema>;
export const readGoalRpc = defineRpc({ name: "recovery.goal.read", input: z.object({ id: z.string().min(1) }), output: goalEditorSchema });
export const editGoalInput = z.object({ ticket: z.string().min(1), objective: z.string().trim().min(1).max(MAX_GOAL_LENGTH) });
export const editGoalRpc = defineRpc({ name: "recovery.goal.edit", input: editGoalInput, output: z.object({ ok: z.literal(true) }) });

export function goalObjectiveError(objective: string, source: GoalEditorSource | null = null): string | null {
  const text = objective.trim();
  const limit = goalLengthLimit(source);
  if (!text || text.length > limit) return `Enter a goal between 1 and ${limit.toLocaleString("en-US")} characters.`;
  if (source === "opencode") return null; // /goal edit receives the objective as an argument.
  if (source === "claude") return /^(clear|stop|off|reset|none|cancel)$/i.test(text) ? "This text clears Claude's goal. Use a complete objective sentence instead." : null;
  // These are control commands in Paseo's native Codex /goal parser.
  if (/^(pause|resume|clear)$/i.test(text)) return "This text is a native goal control command. Use a complete objective sentence instead.";
  return null;
}
