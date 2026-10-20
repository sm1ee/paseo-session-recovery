import { describe, expect, it } from "vitest";
import { readGoal, type GoalItem } from "./goals";

const objective = "Finish the fixture and verify the result";
function call(name: string, output: unknown, input: unknown = {}, status = "completed"): GoalItem {
  return { type: "tool_call", name, callId: "test-call", status, detail: { type: "unknown", input, output } };
}
describe("goal evidence in conversation history", () => {
  it("reads Codex's JSON content blocks without retaining the objective", () => {
    const reading = readGoal([call("functions.create_goal", { content: [{ type: "text", text: JSON.stringify({ objective, status: "active", token_budget: 100, tokens_used: 3 }) }] })]);
    expect(reading).toMatchObject({ state: "active", evidence: true, key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(reading)).not.toContain(objective);
  });
  it("reads OMP's goal details", () => {
    expect(readGoal([call("goal", { content: [{ type: "text", text: "display text" }], details: { op: "create", goal: { id: "fixture", objective, status: "active" } } }, { op: "create", objective })]).state).toBe("active");
  });
  it("uses OMP's synthetic goal updates for completion and budget changes between tool calls", () => {
    const create = call("goal", { details: { goal: { objective, status: "active" } } });
    const update = { type: "tool_call", name: "omp_goal_updated", status: "completed", detail: { type: "plain_text", text: `${objective}\nStatus: budget-limited\nTokens used: 20\nToken budget: 20` }, metadata: { synthetic: true, source: "omp_goal_updated", goalStatus: "budget-limited" } };
    expect(readGoal([create, update]).state).toBe("limited");
    expect(readGoal([create, { ...update, detail: { type: "plain_text", text: "OMP goal cleared." } }]).state).toBe("cleared");
  });
  it("reads Pi goal extension details", () => {
    expect(readGoal([call("get_goal", { details: { version: 3, goal: { objective, status: "paused" } } })]).state).toBe("paused");
  });
  it.each([["paused", "paused"], ["blocked", "blocked"], ["complete", "complete"], ["completed", "complete"], ["budgetLimited", "limited"], ["budget-limited", "limited"], ["usage_limited", "limited"], ["dropped", "cleared"], ["unexpected", "unknown"]])("normalizes %s as %s", (status, expected) => {
    expect(readGoal([call("get_goal", { objective, status })]).state).toBe(expected);
  });
  it("checks remaining budget even if a result still says active", () => {
    expect(readGoal([call("get_goal", { objective, status: "active", tokenBudget: 100, tokensUsed: 100 })]).state).toBe("limited");
  });
  it("preserves an objective across a status-only update", () => {
    const created = call("create_goal", { objective, status: "active" });
    expect(readGoal([created, call("update_goal", { status: "complete" })])).toEqual({ ...readGoal([created]), state: "complete" });
  });
  it("keeps the same key when optional result metadata appears or disappears", () => {
    expect(readGoal([call("get_goal", { objective, status: "active", id: "fixture", createdAt: 12 })]).key).toBe(readGoal([call("get_goal", { objective, status: "active" })]).key);
  });
  it("does not infer goals from chat, shell output, arbitrary tools, or completed to-dos", () => {
    expect(readGoal([{ type: "assistant_message", text: JSON.stringify({ objective, status: "active" }) }, call("exec", { objective, status: "active" }), { type: "todo", items: [{ completed: true }] }]).evidence).toBe(false);
  });
  it("does not treat a failed create call as a new goal", () => {
    expect(readGoal([call("create_goal", { objective, status: "active" }, {}, "failed")]).evidence).toBe(false);
  });
  it("pauses for in-flight or error results instead of using stale active state", () => {
    const create = call("create_goal", { objective, status: "active" });
    expect(readGoal([create, call("update_goal", null, {}, "running")]).state).toBe("unknown");
    expect(readGoal([create, call("get_goal", { isError: true, content: [{ text: JSON.stringify({ objective, status: "active" }) }] })]).state).toBe("unknown");
  });
  it("does not guess active state from a successful call with an unrecognized result", () => {
    expect(readGoal([call("create_goal", "something changed", { objective })]).state).toBe("unknown");
  });
  it("uses acknowledged native /goal commands and respects a later pause", () => {
    const items: GoalItem[] = [{ type: "user_message", text: `/goal ${objective}` }, { type: "assistant_message", text: `Goal set: ${objective}\n\n` }];
    expect(readGoal(items).state).toBe("active");
    expect(readGoal([...items, { type: "user_message", text: "/goal pause" }]).state).toBe("paused");
    expect(readGoal([...items, { type: "user_message", text: "/goal clear" }]).state).toBe("cleared");
  });
  it("requires an acknowledgement before treating a goal command as active", () => {
    expect(readGoal([{ type: "user_message", text: `/goal ${objective}` }]).evidence).toBe(false);
  });
  it("honors a direct stop request after goal creation", () => {
    expect(readGoal([call("create_goal", { objective, status: "active" }), { type: "user_message", text: "중지" }]).state).toBe("paused");
  });
  it("treats a cleared structured goal as terminal", () => {
    expect(readGoal([call("get_goal", { goal: null })]).state).toBe("cleared");
  });
});
