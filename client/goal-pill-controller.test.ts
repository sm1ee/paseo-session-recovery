import { describe, expect, it, vi } from "vitest";
import { createGoalPillController, type PillRegistration } from "./goal-pill-controller";
import type { GoalControl } from "../shared/contracts";

const agent = { id: "session", workspaceId: "workspace", status: "idle" };
const control = (patch: Partial<GoalControl> = {}): GoalControl => ({ id: agent.id, workspaceId: agent.workspaceId, visible: false,
  state: null, key: null, selected: false, canSelect: false, automatic: true, attempts: 0, maxAttempts: 10, delaySeconds: 60, note: null, ...patch });
function fixture() {
  let now = 0, value = control();
  const read = vi.fn(async (_id: string, _fresh: boolean) => value);
  const registrations: Array<PillRegistration & { update: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }> = [];
  const add = vi.fn(() => { const r = { update: vi.fn(), remove: vi.fn() }; registrations.push(r); return r; });
  const controller = createGoalPillController(read, add, () => now);
  controller.upsert(agent);
  return { read, add, registrations, controller, advance: (ms: number) => { now += ms; }, set: (patch: Partial<GoalControl>) => { value = control(patch); } };
}
describe("goal composer pill lifecycle", () => {
  it("has no registration or layout space for a session without a goal", async () => {
    const f = fixture(); await f.controller.poll(); expect(f.read).toHaveBeenCalledOnce(); expect(f.add).not.toHaveBeenCalled();
  });
  it("appears on a verified goal, updates in place, and disappears when it completes", async () => {
    const f = fixture(); f.set({ visible: true, state: "active", key: "goal", canSelect: true }); await f.controller.refresh(agent.id);
    expect(f.add).toHaveBeenCalledOnce(); f.set({ visible: true, state: "active", key: "goal", selected: true }); await f.controller.refresh(agent.id);
    expect(f.add).toHaveBeenCalledOnce(); expect(f.registrations[0].update).toHaveBeenLastCalledWith(expect.objectContaining({ selected: true }));
    f.set({ visible: false, state: "complete", key: "goal" }); await f.controller.refresh(agent.id); expect(f.registrations[0].remove).toHaveBeenCalledOnce();
  });
  it("does not attach a goal to a different workspace", async () => {
    const f = fixture(); f.set({ visible: true, workspaceId: "other" }); await f.controller.poll(); expect(f.add).not.toHaveBeenCalled();
  });
  it("discards a pending lookup after the session is removed", async () => {
    const f = fixture(); let release!: (value: GoalControl) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.controller.refresh(agent.id); f.controller.remove(agent.id); release(control({ visible: true })); await pending;
    expect(f.add).not.toHaveBeenCalled();
  });
  it("discards a pending lookup after the session moves workspaces", async () => {
    const f = fixture(); let release!: (value: GoalControl) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.controller.refresh(agent.id); f.controller.upsert({ ...agent, workspaceId: "other" }); release(control({ visible: true })); await pending;
    expect(f.add).not.toHaveBeenCalled();
  });
  it("removes archived sessions and ignores late results after cleanup", async () => {
    const f = fixture(); f.set({ visible: true }); await f.controller.refresh(agent.id);
    f.controller.upsert({ ...agent, archivedAt: "2026-10-20T00:00:00Z" }); expect(f.registrations[0].remove).toHaveBeenCalledOnce();
    f.controller.upsert(agent); let release!: (value: GoalControl) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.controller.refresh(agent.id); f.controller.stop(); release(control({ visible: true })); await pending;
    f.controller.upsert(agent); await f.controller.poll(); expect(f.add).toHaveBeenCalledOnce();
  });
  it("rebuilds registrations after a reconnect snapshot and removes obsolete sessions", async () => {
    const f = fixture(); f.set({ visible: true }); await f.controller.refresh(agent.id);
    f.controller.snapshot([agent]); await f.controller.refresh(agent.id); expect(f.add).toHaveBeenCalledTimes(2);
    expect(f.registrations[0].remove).toHaveBeenCalledOnce(); f.controller.snapshot([]); expect(f.registrations[1].remove).toHaveBeenCalledOnce();
  });
  it("restores known goal controls before a large directory after reconnect", async () => {
    const f = fixture(); f.set({ visible: true, state: "active", key: "goal" }); await f.controller.refresh(agent.id);
    f.read.mockClear();
    f.read.mockImplementation(async (id) => control({ id, visible: id === agent.id }));
    f.controller.snapshot([...Array.from({ length: 2200 }, (_, i) => ({ ...agent, id: `other-${i}` })), agent]);
    await f.controller.poll();
    expect(f.read.mock.calls[0][0]).toBe(agent.id); expect(f.add).toHaveBeenCalledTimes(2);
  });
  it("serializes background lookups and waits before polling an idle session again", async () => {
    const f = fixture(); let release!: (value: GoalControl) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = f.controller.poll(); await f.controller.poll(); expect(f.read).toHaveBeenCalledOnce();
    release(control()); await first; f.advance(299_999); await f.controller.poll(); expect(f.read).toHaveBeenCalledOnce();
    f.advance(1); await f.controller.poll(); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("refreshes active goals sooner and hides stale controls on a lookup failure", async () => {
    const f = fixture(); f.controller.upsert({ ...agent, status: "running" }); f.set({ visible: true }); await f.controller.poll();
    f.advance(15_000); f.read.mockRejectedValueOnce(new Error("offline")); await f.controller.poll();
    expect(f.registrations[0].remove).toHaveBeenCalledOnce();
  });
  it("느린 조회가 끝난 시점부터 다음 조회 간격을 계산한다", async () => {
    const f = fixture(); let release!: (value: GoalControl) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.controller.poll(); f.advance(400_000); release(control()); await pending;
    await f.controller.poll(); expect(f.read).toHaveBeenCalledOnce();
    f.advance(300_000); await f.controller.poll(); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("refreshes a mode change immediately, bypassing the cached idle result", async () => {
    const f = fixture(); f.controller.upsert({ ...agent, currentModeId: "build" }); await f.controller.poll();
    f.set({ visible: true, key: "native-goal" }); f.controller.upsert({ ...agent, currentModeId: "goal" }); await f.controller.poll();
    expect(f.read).toHaveBeenLastCalledWith(agent.id, true); expect(f.add).toHaveBeenCalledOnce();
  });
  it("does not let a slow session block other goal controls", async () => {
    const f = fixture(); let release!: (value: GoalControl) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    f.controller.upsert({ ...agent, id: "other" }); f.set({ id: "other", visible: true });
    const pending = f.controller.poll();
    await vi.waitFor(() => expect(f.add).toHaveBeenCalledWith("other", agent.workspaceId));
    release(control()); await pending;
  });
  it("keeps the result of a direct toggle when an older background read arrives later", async () => {
    const f = fixture(); let release!: (value: GoalControl) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const old = f.controller.refresh(agent.id, false);
    f.set({ visible: true, selected: true, key: "goal" }); await f.controller.refresh(agent.id, true);
    release(control({ visible: true, selected: false })); await old;
    expect(f.registrations[0].update).toHaveBeenCalledOnce();
    expect(f.registrations[0].update).toHaveBeenLastCalledWith(expect.objectContaining({ selected: true }));
  });
  it("bounds background reads to four concurrent requests", async () => {
    const f = fixture(); const releases: Array<() => void> = []; let active = 0, peak = 0;
    f.read.mockImplementation(async () => { active++; peak = Math.max(peak, active); await new Promise<void>((resolve) => releases.push(resolve)); active--; return control(); });
    f.controller.snapshot(Array.from({ length: 10 }, (_, i) => ({ ...agent, id: `session-${i}` })));
    const pending = f.controller.poll(); expect(f.read).toHaveBeenCalledTimes(4);
    while (f.read.mock.calls.length < 10 || active) {
      releases.splice(0).forEach((release) => release()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    await pending; expect(peak).toBe(4);
  });
});
