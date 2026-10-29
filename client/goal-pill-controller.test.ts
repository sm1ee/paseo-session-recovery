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
  it("등록된 커스텀 제공자만 조회 진입을 만들고 마운트한 세션만 읽는다", async () => {
    const f = fixture();
    f.controller.snapshot(Array.from({ length: 2200 }, (_, i) => ({ ...agent, id: `alias-${i}`, provider: i % 2 ? "claude-codex" : "devin" })));
    expect(f.add).not.toHaveBeenCalled();
    f.controller.providers(["claude-codex", "devin"]);
    expect(f.add).toHaveBeenCalledTimes(2200);
    await f.controller.poll(); expect(f.read).not.toHaveBeenCalled();
    const unmount = f.controller.mount("alias-2199");
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledExactlyOnceWith("alias-2199", true));
    f.controller.providers([]); expect(f.registrations.every(r => r.remove.mock.calls.length === 1)).toBe(true);
    unmount(); f.controller.stop(); f.controller.providers(["claude-codex"]); expect(f.add).toHaveBeenCalledTimes(2200);
  });
  it("Goal 조회 없이 현재 세션 상태를 표시하고 새 턴만 관찰 갱신으로 취급한다", async () => {
    const read = vi.fn(async () => control({ visible: true, state: "active", objective: "Keep working" }));
    const observe = vi.fn(), update = vi.fn();
    const controller = createGoalPillController(read, () => ({ observe, update, remove: vi.fn() }));
    const closed = { ...agent, provider: "codex", status: "closed", activeTurn: null };
    controller.upsert(closed);
    expect(observe).toHaveBeenLastCalledWith(closed);
    await controller.poll(); expect(read).not.toHaveBeenCalled();
    const running = { ...closed, status: "running", activeTurn: { turnId: "turn-1" } };
    controller.upsert(running); expect(observe).toHaveBeenLastCalledWith(running);
    await controller.refresh(agent.id); expect(observe).toHaveBeenLastCalledWith(running);
    const stopped = { ...running, status: "closed", activeTurn: null };
    controller.upsert(stopped); expect(observe).toHaveBeenLastCalledWith(stopped);
    expect(read).toHaveBeenCalledOnce(); controller.stop();
  });
  it("수천 개의 제공자 대화에는 조회 버튼만 등록하고 현재 보이는 composer만 읽는다", async () => {
    const f = fixture();
    f.controller.snapshot(Array.from({ length: 2200 }, (_, i) => ({ ...agent, id: `native-${i}`, provider: ["omp", "claude", "opencode", "codex"][i % 4] })));
    expect(f.add).toHaveBeenCalledTimes(2200);
    await f.controller.poll(); expect(f.read).not.toHaveBeenCalled();
    const unmount = f.controller.mount("native-2199");
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledExactlyOnceWith("native-2199", true));
    unmount(); f.advance(600_000); await f.controller.poll(); expect(f.read).toHaveBeenCalledOnce();
  });
  it("여러 composer가 같은 순간 마운트돼도 진행 중인 점검에 즉시 포함한다", async () => {
    const f = fixture(); f.controller.snapshot([0, 1, 2].map((n) => ({ ...agent, id: `native-${n}`, provider: "omp" })));
    const release = [0, 1, 2].map((n) => f.controller.mount(`native-${n}`));
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(3));
    expect(new Set(f.read.mock.calls.map(([id]) => id))).toEqual(new Set(["native-0", "native-1", "native-2"]));
    release.forEach((stop) => stop());
  });
  it("네이티브 목표가 없거나 조회가 실패해도 조회 진입은 유지하고 이전 토글 상태는 없앤다", async () => {
    const f = fixture(); f.controller.upsert({ ...agent, provider: "omp" });
    const registration = f.registrations[0]; expect(registration.update).toHaveBeenCalledWith(null);
    f.set({ visible: true, selected: true, key: "goal" }); await f.controller.refresh(agent.id);
    expect(registration.update).toHaveBeenLastCalledWith(expect.objectContaining({ selected: true }));
    f.read.mockRejectedValueOnce(new Error("offline")); const unmount = f.controller.mount(agent.id);
    await vi.waitFor(() => expect(registration.update).toHaveBeenLastCalledWith(null));
    expect(registration.remove).not.toHaveBeenCalled(); unmount();
    f.set({ visible: false, state: "complete" }); await f.controller.refresh(agent.id);
    expect(registration.update).toHaveBeenLastCalledWith(null); expect(registration.remove).not.toHaveBeenCalled();
  });
  it("has no registration or layout space for a session without a goal", async () => {
    const f = fixture(); await f.controller.poll(); expect(f.read).not.toHaveBeenCalled(); expect(f.add).not.toHaveBeenCalled();
  });
  it("제공자 정보가 없거나 미지원인 숨겨진 대화는 재접속과 상태 변경 후에도 조회하지 않는다", async () => {
    const f = fixture();
    const agents = Array.from({ length: 2200 }, (_, i) => ({ ...agent, id: `hidden-${i}`, provider: i % 2 ? "other" : undefined }));
    f.controller.snapshot(agents); await f.controller.poll();
    f.controller.snapshot(agents.map((value) => ({ ...value, status: "running", lastUserMessageAt: "2026-10-21T00:00:00Z" })));
    f.advance(600_000); await f.controller.poll();
    expect(f.read).not.toHaveBeenCalled(); expect(f.add).not.toHaveBeenCalled();
  });
  it("appears on a verified goal, updates in place, and disappears when it completes", async () => {
    const f = fixture(); f.set({ visible: true, state: "active", key: "goal", canSelect: true }); await f.controller.refresh(agent.id);
    expect(f.add).toHaveBeenCalledOnce(); f.set({ visible: true, state: "active", key: "goal", selected: true }); await f.controller.refresh(agent.id);
    expect(f.add).toHaveBeenCalledOnce(); expect(f.registrations[0].update).toHaveBeenLastCalledWith(expect.objectContaining({ selected: true }));
    f.set({ visible: false, state: "complete", key: "goal" }); await f.controller.refresh(agent.id); expect(f.registrations[0].remove).toHaveBeenCalledOnce();
  });
  it("does not attach a goal to a different workspace", async () => {
    const f = fixture(); f.set({ visible: true, workspaceId: "other" }); await f.controller.refresh(agent.id); expect(f.add).not.toHaveBeenCalled();
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
  it("재접속 후 다시 마운트된 composer만 복원하고 나머지 목록은 읽지 않는다", async () => {
    const f = fixture(); f.set({ visible: true, state: "active", key: "goal" }); await f.controller.refresh(agent.id);
    f.read.mockClear();
    f.read.mockImplementation(async (id) => control({ id, visible: id === agent.id }));
    f.controller.snapshot([...Array.from({ length: 2200 }, (_, i) => ({ ...agent, id: `other-${i}` })), agent]);
    await f.controller.poll(); expect(f.read).not.toHaveBeenCalled();
    const unmount = f.controller.mount(agent.id);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledExactlyOnceWith(agent.id, true));
    expect(f.add).toHaveBeenCalledTimes(2); unmount();
  });
  it("serializes background lookups and waits before polling an idle session again", async () => {
    const f = fixture(); let release!: (value: GoalControl) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const unmount = f.controller.mount(agent.id); const first = f.controller.poll(); expect(f.read).toHaveBeenCalledOnce();
    release(control()); await first;
    f.advance(299_999); await f.controller.poll(); expect(f.read).toHaveBeenCalledOnce();
    f.advance(1); await f.controller.poll(); expect(f.read).toHaveBeenCalledTimes(2);
    unmount();
  });
  it("refreshes active goals sooner and hides stale controls on a lookup failure", async () => {
    const f = fixture(); f.controller.upsert({ ...agent, status: "running" }); f.set({ visible: true }); const unmount = f.controller.mount(agent.id);
    await vi.waitFor(() => expect(f.add).toHaveBeenCalledOnce());
    f.advance(15_000); f.read.mockRejectedValueOnce(new Error("offline")); await f.controller.poll();
    expect(f.registrations[0].remove).toHaveBeenCalledOnce();
    unmount();
  });
  it("느린 조회가 끝난 시점부터 다음 조회 간격을 계산한다", async () => {
    const f = fixture(); let release!: (value: GoalControl) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const unmount = f.controller.mount(agent.id); f.advance(400_000); release(control());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.controller.poll(); expect(f.read).toHaveBeenCalledOnce();
    f.advance(300_000); await f.controller.poll(); expect(f.read).toHaveBeenCalledTimes(2);
    unmount();
  });
  it("refreshes a mode change immediately, bypassing the cached idle result", async () => {
    const f = fixture(); f.controller.upsert({ ...agent, currentModeId: "build" }); const unmount = f.controller.mount(agent.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.set({ visible: true, key: "native-goal" }); f.controller.upsert({ ...agent, currentModeId: "goal" }); await f.controller.poll();
    expect(f.read).toHaveBeenLastCalledWith(agent.id, true); expect(f.add).toHaveBeenCalledOnce();
    unmount();
  });
  it("does not let a slow session block other goal controls", async () => {
    const f = fixture(); let release!: (value: GoalControl) => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    f.controller.upsert({ ...agent, id: "other" }); f.set({ id: "other", visible: true });
    const unmount = [f.controller.mount(agent.id), f.controller.mount("other")];
    await vi.waitFor(() => expect(f.add).toHaveBeenCalledWith("other", agent.workspaceId));
    release(control()); unmount.forEach((stop) => stop());
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
    const unmount = Array.from({ length: 10 }, (_, i) => f.controller.mount(`session-${i}`));
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(4));
    while (f.read.mock.calls.length < 10 || active) {
      releases.splice(0).forEach((release) => release()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    expect(peak).toBe(4); unmount.forEach((stop) => stop());
  });
});
