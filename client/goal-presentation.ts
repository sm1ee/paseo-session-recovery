import type { GoalControl } from "../shared/contracts";

export function goalPreviewLabel(goal: GoalControl | null): string {
  const text = goal?.objective?.replace(/\s+/g, " ").trim();
  if (!text) return "Goal";
  const chars = [...text];
  return `${chars.slice(0, 48).join("")}${chars.length > 48 ? "…" : ""}`;
}
export function goalErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (/changed|expired/i.test(raw)) return "Changed. Reload.";
  if (/approval|permission|pending input/i.test(raw)) return "Waiting for input.";
  if (/budget|limit/i.test(raw)) return "Check goal limits.";
  if (/unavailable|disconnected|connection|timed out/i.test(raw)) return "Unavailable. Reload.";
  return "Couldn’t confirm. Reload.";
}
