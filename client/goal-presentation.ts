import type { GoalControl } from "../shared/contracts";
import type { GoalEditorSnapshot } from "../shared/goal-editor";

export function goalPreviewLabel(goal: GoalControl | null): string {
  const text = goal?.objective?.replace(/\s+/g, " ").trim();
  if (!text) return "Goal";
  const chars = [...text];
  return `${chars.slice(0, 48).join("")}${chars.length > 48 ? "…" : ""}`;
}
export function goalErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (/Could not restore model|saved OMP model is unavailable/i.test(raw)) return "Saved model unavailable. Choose another model in Paseo.";
  if (/changed|expired/i.test(raw)) return "Changed. Reload.";
  if (/approval|permission|pending input/i.test(raw)) return "Waiting for input.";
  if (/budget|limit/i.test(raw)) return "Check goal limits.";
  if (/unavailable|disconnected|connection|timed out/i.test(raw)) return "Unavailable. Reload.";
  return "Couldn’t confirm. Reload.";
}

export function goalReadOnlyText(goal: GoalEditorSnapshot): string {
  if (goal.state === "complete") return "Goal completed.";
  if (!goal.supported) return "Viewing only. Native controls unavailable.";
  if (goal.source === "omp" && goal.actionTicket) return "Goal text cannot be edited.";
  const note = goal.note ?? "";
  if (/current turn/.test(note)) return "Turn running. Edit when idle.";
  if (/pending input|uncertain delivery/.test(note)) return "Resolve pending input or delivery first.";
  if (/session changed/i.test(note)) return "Session changed. Reload.";
  if (/commands are unavailable/.test(note)) return "Native controls unavailable.";
  if (goal.state === "unknown") return "Goal unavailable. Reload.";
  return "Read only. Check Details.";
}
