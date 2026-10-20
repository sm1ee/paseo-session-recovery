import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export type GoalAction = "pause" | "resume";
export const actOnGoalRpc = defineRpc({
  name: "recovery.goal.action",
  input: z.object({ ticket: z.string().min(1), confirmBudgetReset: z.boolean().default(false) }),
  output: z.object({ ok: z.literal(true) }),
});
