import { createHash } from "node:crypto";

export type GoalState = "active" | "paused" | "blocked" | "limited" | "complete" | "cleared" | "unknown";
export type GoalSource = "codex" | "opencode" | "claude";
export interface GoalReading { state: GoalState; key: string | null; evidence: boolean; modeId?: string; source?: GoalSource | "timeline"; nativeContinuation?: boolean }
export interface GoalDetails {
  reading: GoalReading; objective: string | null; revision: string;
  tokenBudget: number | null; tokensUsed: number | null;
}
export interface GoalItem { type: string; [key: string]: unknown }
const names = new Set(["goal", "create_goal", "get_goal", "update_goal", "set_goal_tasks", "update_goal_task", "omp_goal_updated"]);
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function status(value: unknown): GoalState {
  const key = typeof value === "string" ? value.toLowerCase().replace(/[-_]/g, "") : "";
  if (key === "active" || key === "paused" || key === "blocked") return key;
  if (["complete", "completed"].includes(key)) return "complete";
  if (["budgetlimited", "usagelimited", "budgetlimit", "usagelimit"].includes(key)) return "limited";
  if (["dropped", "cleared"].includes(key)) return "cleared";
  return "unknown";
}
// Only decode the result of a recognized goal tool. Ordinary conversation,
// shell output, quoted examples, and to-do completion are not goal evidence.
function result(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6) return null;
  if (typeof value === "string") {
    if (value.length > 128_000) return null;
    try { return result(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 50)) { const found = result(entry, depth + 1); if (found) return found; }
    return null;
  }
  const data = object(value); if (!data) return null;
  if (data.isError === true || data.error != null) return { status: "unknown" };
  // Structured data wins over the tool's human-readable text.
  for (const key of ["structuredContent", "details", "goal", "state"]) {
    if (key === "goal" && data.goal === null) return { status: "cleared" };
    if (data[key] !== undefined) { const found = result(data[key], depth + 1); if (found) return found; }
  }
  if (typeof data.status === "string") return data;
  for (const key of ["content", "text", "output", "result"]) {
    if (data[key] !== undefined) { const found = result(data[key], depth + 1); if (found) return found; }
  }
  return null;
}
export function readGoal(items: readonly GoalItem[]): GoalReading {
  let reading: GoalReading = { state: "unknown", key: null, evidence: false };
  let identity: Record<string, unknown> = {};
  let command: string | null = null;
  const update = (data: Record<string, unknown>, fallback: Record<string, unknown> = {}, reset = false) => {
    let state = status(data.status);
    const tokenBudget = data.tokenBudget ?? data.token_budget;
    const tokensUsed = data.tokensUsed ?? data.tokens_used;
    if (state === "active" && typeof tokenBudget === "number" && tokenBudget > 0 && typeof tokensUsed === "number" && tokensUsed >= tokenBudget) state = "limited";
    const next: Record<string, unknown> = reset ? {} : { ...identity };
    for (const key of ["id", "objective", "createdAt", "created_at"]) {
      const value = data[key] ?? fallback[key];
      if (typeof value === "string" || typeof value === "number") next[key] = value;
    }
    identity = next;
    // Results may omit IDs or creation times on later reads. Hash only the
    // objective so page boundaries cannot reset the continuation limit.
    const key = typeof next.objective === "string" && next.objective.trim() ? createHash("sha256").update(next.objective.trim()).digest("hex") : null;
    reading = { state, key, evidence: true };
  };
  for (const item of items) {
    if (item.type === "user_message" && typeof item.text === "string") {
      const text = item.text.trim();
      command = text.startsWith("/goal ") ? text.slice(6).trim() : null;
      if (command && /^(pause|clear|drop|stop)$/i.test(command)) update({ status: /^(clear|drop)$/i.test(command) ? "cleared" : "paused" });
      else if (/^(?:stop|pause|cancel|중지|멈춰|그만|일시\s?중지)(?:[.!\s]|$)/i.test(text) && reading.evidence) update({ status: "paused" });
      continue;
    }
    if (item.type === "assistant_message" && command && typeof item.text === "string") {
      const text = item.text.trim();
      if (text === `Goal set: ${command}`) update({ status: "active", objective: command }, {}, true);
      else if (command.toLowerCase() === "resume" && text === "Goal resumed.") update({ status: "active" });
      else if (text.startsWith("Failed to update goal:")) update({ status: "unknown" });
      command = null;
      continue;
    }
    if (item.type !== "tool_call" || typeof item.name !== "string") continue;
    command = null;
    const name = item.name.replace(/^functions\./, "");
    if (!names.has(name)) continue;
    if (item.status === "running") { update({ status: "unknown" }); continue; }
    if (item.status !== "completed") { if (reading.evidence) update({ status: "unknown" }); continue; }
    const detail = object(item.detail);
    if (name === "omp_goal_updated") {
      const meta = object(item.metadata);
      if (meta?.synthetic !== true || meta.source !== "omp_goal_updated") continue;
      const text = typeof detail?.text === "string" ? detail.text : "";
      if (text === "OMP goal cleared.") { update({ status: "cleared" }); continue; }
      const boundary = text.lastIndexOf("\nStatus: ");
      const objective = boundary >= 0 ? text.slice(0, boundary) : undefined;
      const tokenBudget = [...text.matchAll(/^Token budget: (\d+)$/gm)].at(-1)?.[1];
      const tokensUsed = [...text.matchAll(/^Tokens used: (\d+)$/gm)].at(-1)?.[1];
      update({ status: meta.goalStatus, ...(objective && objective !== "OMP goal updated." ? { objective } : {}),
        ...(tokenBudget ? { tokenBudget: Number(tokenBudget) } : {}), ...(tokensUsed ? { tokensUsed: Number(tokensUsed) } : {}) });
      continue;
    }
    const input = object(detail?.input) ?? {};
    const found = result(detail?.output ?? (detail?.type === "plain_text" ? detail.text : undefined));
    update(found ?? { status: "unknown" }, name === "create_goal" || input.op === "create" ? input : {}, name === "create_goal" || input.op === "create");
  }
  return reading;
}
