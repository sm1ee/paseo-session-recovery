import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_GOAL_LENGTH = 16_000;
export const goalEditorSchema = z.object({
  id: z.string(), title: z.string(), provider: z.string(), supported: z.boolean(),
  objective: z.string().nullable(), state: z.enum(["active", "paused", "blocked", "limited", "complete", "cleared", "unknown"]),
  tokenBudget: z.number().finite().nonnegative().nullable(), tokensUsed: z.number().finite().nonnegative().nullable(),
  ticket: z.string().nullable(), note: z.string().nullable(),
});
export type GoalEditorSnapshot = z.infer<typeof goalEditorSchema>;
export const readGoalRpc = defineRpc({ name: "recovery.goal.read", input: z.object({ id: z.string().min(1) }), output: goalEditorSchema });
export const editGoalInput = z.object({ ticket: z.string().min(1), objective: z.string().trim().min(1).max(MAX_GOAL_LENGTH) });
export const editGoalRpc = defineRpc({ name: "recovery.goal.edit", input: editGoalInput, output: z.object({ ok: z.literal(true) }) });

export function goalObjectiveError(objective: string): string | null {
  const text = objective.trim();
  if (!text || text.length > MAX_GOAL_LENGTH) return `Enter a goal between 1 and ${MAX_GOAL_LENGTH.toLocaleString("en-US")} characters.`;
  // These are control commands in Paseo's native Codex /goal parser.
  if (/^(pause|resume|clear)$/i.test(text)) return "This text is a native goal control command. Use a complete objective sentence instead.";
  return null;
}
