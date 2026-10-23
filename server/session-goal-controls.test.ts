import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../shared/model";
import type { GoalDetails } from "./goals";
import { controlSessionGoal } from "./session-goal-controls";

function fixture(action: "pause" | "resume") {
  const expected: Agent = { id: "fixture", title: "Fixture", provider: "claude", workspaceId: "workspace", parentId: null,
    status: action === "pause" ? "running" : "idle", activeTurn: action === "pause" ? "turn" : null,
    pendingPermissions: 0, archivedAt: null, lastUserMessageAt: "original", attentionReason: null, attentionTimestamp: null, persistence: true, sessionId: "native", internal: false };
  let current = structuredClone(expected);
  const details: GoalDetails = { reading: { state: "active", key: "goal", evidence: true, source: "claude", nativeContinuation: true },
    objective: "Private fixture objective", revision: "revision", tokenBudget: null, tokensUsed: 3, sessionControls: true };
  const fetch = vi.fn(async () => structuredClone(current)), read = vi.fn(async () => structuredClone(details));
  const pause = vi.fn(async () => { current.status = "idle"; current.activeTurn = null; });
  const resume = vi.fn(async () => { current.status = "running"; current.activeTurn = "next"; current.lastUserMessageAt = "submitted"; });
  const submitted = vi.fn(), guard = vi.fn();
  return { expected, details, fetch, read, pause, resume, submitted, guard, get current() { return current; },
    run: () => controlSessionGoal({ expected, revision: "revision", action, fetch, details: read, pause, resume, submitted, guard }) };
}
describe("목표를 바꾸지 않는 제공자 실행 제어", () => {
  it("Pause는 소유 세션의 현재 턴을 중지하고 실제 idle 상태를 확인한다", async () => {
    const f = fixture("pause"), before = structuredClone(f.details);
    expect(await f.run()).toEqual(before.reading);
    expect(f.pause).toHaveBeenCalledOnce(); expect(f.resume).not.toHaveBeenCalled(); expect(f.submitted).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledTimes(3); expect(f.details).toEqual(before);
  });
  it("Resume은 기존 목표의 다음 턴을 시작하고 목표를 다시 설정하지 않는다", async () => {
    const f = fixture("resume"); expect(await f.run()).toEqual(f.details.reading);
    expect(f.resume).toHaveBeenCalledOnce(); expect(f.pause).not.toHaveBeenCalled(); expect(f.details.objective).toBe("Private fixture objective");
  });
  it("명시적으로 closed인 휴면 세션은 추가 복원 조회 없이 사용자 Resume으로 시작한다", async () => {
    const f = fixture("resume"); f.expected.status = f.current.status = "closed"; f.expected.activeTurn = f.current.activeTurn = undefined;
    expect(await f.run()).toEqual(f.details.reading); expect(f.resume).toHaveBeenCalledOnce();
  });
  it.each(["permission", "turn", "session", "message", "archived", "unknown"] as const)("%s 변경 후에는 제어 요청을 보내지 않는다", async (change) => {
    const f = fixture("pause");
    if (change === "permission") f.current.pendingPermissions = 1;
    if (change === "turn") f.current.activeTurn = "new-turn";
    if (change === "session") f.current.sessionId = "other-session";
    if (change === "message") f.current.lastUserMessageAt = "new-message";
    if (change === "archived") f.current.archivedAt = "now";
    if (change === "unknown") f.current.activeTurn = undefined;
    await expect(f.run()).rejects.toThrow(/changed/); expect(f.pause).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled();
  });
  it("목표 교체와 네이티브 OMP 상태에는 세션용 제어를 보내지 않는다", async () => {
    for (const change of ["revision", "native"] as const) {
      const f = fixture("resume"); if (change === "revision") f.details.revision = "replacement"; else f.details.sessionControls = false;
      await expect(f.run()).rejects.toThrow(/goal changed/); expect(f.resume).not.toHaveBeenCalled();
    }
  });
  it("수신 확인을 잃은 제어는 다시 보내지 않는다", async () => {
    const f = fixture("resume"); f.resume.mockRejectedValueOnce(new Error("Receipt lost"));
    await expect(f.run()).rejects.toThrow("Receipt lost"); expect(f.resume).toHaveBeenCalledOnce();
  });
});
