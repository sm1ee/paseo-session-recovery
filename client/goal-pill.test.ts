import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goalControlRpc, unwatchGoalRpc, watchGoalRpc, type GoalControl } from "../shared/contracts";
import { contributeGoalPills } from "./goal-pill";

const agent = { id: "session", workspaceId: "workspace", status: "idle" };
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
async function fixture() {
  let goal: GoalControl = { id: agent.id, workspaceId: agent.workspaceId, visible: true, state: "active", key: "old-goal", selected: false, canSelect: true,
    automatic: true, attempts: 0, maxAttempts: 10, delaySeconds: 60, note: null };
  const update = vi.fn(), remove = vi.fn();
  let snapshot!: (value: { entries: Array<{ agent: typeof agent }> }) => void;
  const subscription = { subscribe: vi.fn((handlers) => { snapshot = handlers.snapshot; }) };
  const list = vi.fn(async () => ({ subscription }));
  const rpc = vi.fn(async (contract, input) => {
    if (contract === goalControlRpc) return { ...goal };
    if (contract === watchGoalRpc) { goal = { ...goal, selected: true }; return { ok: true }; }
    if (contract === unwatchGoalRpc) { goal = { ...goal, selected: false }; return { ok: true }; }
    throw new Error("Unexpected RPC");
  });
  const addComposerPill = vi.fn((_pill: Parameters<PluginClientContext["addComposerPill"]>[0]) => ({ update, remove }));
  const client = { rpc, addComposerPill, paseo: { agents: { list } } } as unknown as PluginClientContext;
  cleanup = contributeGoalPills(client);
  await vi.waitFor(() => expect(snapshot).toBeTypeOf("function"));
  snapshot({ entries: [{ agent }] });
  await vi.waitFor(() => expect(addComposerPill).toHaveBeenCalledOnce());
  const behavior = addComposerPill.mock.calls[0][0].button.behavior;
  if (behavior.kind !== "action") throw new Error("The goal pill must be a direct action");
  return { list, rpc, update, press: behavior.onPress, set: (patch: Partial<GoalControl>) => { goal = { ...goal, ...patch }; } };
}
describe("direct goal toggle", () => {
  it("retries a failed initial directory lookup and stops retrying after cleanup", async () => {
    vi.useFakeTimers(); const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const goal: GoalControl = { id: agent.id, workspaceId: agent.workspaceId, visible: true, state: "active", key: "goal", selected: false, canSelect: true,
      automatic: true, attempts: 0, maxAttempts: 10, delaySeconds: 60, note: null };
    const addComposerPill = vi.fn(() => ({ update: vi.fn(), remove: vi.fn() }));
    const subscription = { subscribe: vi.fn((handlers) => handlers.snapshot({ entries: [{ agent }] })) };
    const list = vi.fn().mockRejectedValueOnce(new Error("Mobile connection interrupted")).mockResolvedValue({ subscription });
    const client = { rpc: vi.fn(async () => goal), addComposerPill, paseo: { agents: { list } } } as unknown as PluginClientContext;
    cleanup = contributeGoalPills(client); await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledOnce(); expect(list.mock.calls[0][0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000); expect(list).toHaveBeenCalledTimes(2); expect(addComposerPill).toHaveBeenCalledOnce();
    cleanup(); cleanup = undefined; await vi.advanceTimersByTimeAsync(10_000);
    expect(list.mock.calls[1][0].signal.aborted).toBe(true); expect(list).toHaveBeenCalledTimes(2); errors.mockRestore();
  });
  it("uses the complete active directory instead of the default first 200 sessions", async () => {
    const f = await fixture(); expect(f.list).toHaveBeenCalledWith(expect.objectContaining({ scope: "active", sync: {}, subscribe: {} }));
  });
  it("switches on and off directly without a popover", async () => {
    const f = await fixture(); await f.press();
    expect(f.rpc).toHaveBeenCalledWith(watchGoalRpc, { id: agent.id, key: "old-goal", resetAttempts: false, resumeBlocked: true });
    expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Goal · On" }));
    await f.press(); expect(f.rpc).toHaveBeenCalledWith(unwatchGoalRpc, { id: agent.id });
    expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Goal · Off" }));
  });
  it("reads the current objective again before selecting it", async () => {
    const f = await fixture(); f.set({ key: "new-goal" }); await f.press();
    expect(f.rpc).toHaveBeenCalledWith(watchGoalRpc, { id: agent.id, key: "new-goal", resetAttempts: false, resumeBlocked: true });
  });
  it("allows a selected but unverifiable goal to be turned off", async () => {
    const f = await fixture(); f.set({ state: "unknown", selected: true, canSelect: false, key: null }); await f.press();
    expect(f.rpc).toHaveBeenCalledWith(unwatchGoalRpc, { id: agent.id });
  });
  it("does not select an unavailable goal", async () => {
    const f = await fixture(); f.set({ visible: false, canSelect: false, key: null });
    await expect(f.press()).rejects.toThrow(/unavailable/);
    expect(f.rpc.mock.calls.some(([contract]) => contract === watchGoalRpc || contract === unwatchGoalRpc)).toBe(false);
  });
  it.each([
    [{ state: "blocked" }, "Blocked"], [{ state: "paused" }, "Paused"], [{ state: "limited" }, "Limit"],
    [{ state: "unknown" }, "Review"], [{ state: "active", holdReason: "input" }, "Waiting"],
    [{ state: "active", automatic: false }, "Paused"], [{ state: "active", attempts: 10 }, "Limit"],
  ] as const)("shows a compact %j hold without calling it On", async (patch, text) => {
    const f = await fixture(); f.set(patch); await f.press();
    expect(f.update).toHaveBeenLastCalledWith(expect.objectContaining({ label: `Goal · ${text}` }));
  });
});
