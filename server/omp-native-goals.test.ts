import { describe, expect, it, vi } from "vitest";
import type { PaseoAgent } from "@getpaseo/client";
import type { Agent } from "../shared/model";
import { installOmpNativeBridge, installOmpSessionTracking, invokeOmpNative, ompNativeDetails, OmpNativeGoals, OMP_GOAL_RPC, rememberOmpSessions } from "./omp-native-goals";

function response(status = "active", used = 4, objective = "Finish the fixture") {
  const goal = { id: "native-goal", objective, status, tokensUsed: used, tokenBudget: 200 };
  return { goal, state: { enabled: status === "active", goal } };
}
function fixture(native: ReturnType<typeof response> | { goal: null; state: null } = response()) {
  const expected: Agent = { id: "agent", title: "Fixture", provider: "omp", workspaceId: "workspace", parentId: null, status: "idle", activeTurn: null,
    pendingPermissions: 0, archivedAt: null, lastUserMessageAt: null, attentionReason: null, attentionTimestamp: null, persistence: true, sessionId: "session", internal: false, modeId: "default" };
  const agent = { ...expected, labels: {}, persistence: { sessionId: "session" }, currentModeId: "default", pendingPermissions: [] } as unknown as PaseoAgent;
  let data = native;
  const request = vi.fn(async (command: Record<string, unknown>) => {
    if (command.op === "pause") data = response("paused");
    if (command.op === "resume") data = response("active");
    if (command.op === "create") data = response("active", 0, String(command.objective));
    return structuredClone(data);
  });
  const runtime = { process: { request }, getState: vi.fn(async () => ({ sessionId: "session" })) };
  const live = { provider: "omp", session: { runtimeSession: runtime } };
  const manager = { getAgent: vi.fn(() => live as typeof live | null) };
  const session = { clientId: "session-recovery-fixture", agentManager: manager, getAgentPayloadById: vi.fn(async () => agent), pluginRuntime: {}, emit: vi.fn() };
  const input = (op: "pause" | "resume" | "create") => ({ id: "agent", sessionId: "session", op, expected, revision: ompNativeDetails("session", data).revision, operationId: "fixture-operation", objective: "Finish the fixture" });
  return { session, manager, live, agent, expected, request, runtime, input };
}

describe("OMP 네이티브 Goal 응답", () => {
  it("상태·목표·예산·사용량을 네이티브 응답에서 읽는다", () => {
    expect(ompNativeDetails("session", response())).toMatchObject({ objective: "Finish the fixture", identity: "native-goal", tokenBudget: 200, tokensUsed: 4,
      reading: { source: "omp", state: "active", nativeContinuation: true } });
    expect(ompNativeDetails("session", { goal: null, state: null }).objective).toBeNull();
  });
  it("사용량 증가는 티켓을 바꾸지 않고 목표·상태·예산 변경은 바꾼다", () => {
    const first = ompNativeDetails("session", response());
    expect(ompNativeDetails("session", response("active", 8)).revision).toBe(first.revision);
    expect(ompNativeDetails("session", response("paused")).revision).not.toBe(first.revision);
    expect(ompNativeDetails("other", response()).revision).not.toBe(first.revision);
  });
  it.each([undefined, {}, { goal: null }, { ...response(), state: null }, response("invalid"), response("active", -1), response("active", 2, "")])("불완전하거나 불일치하는 응답을 Goal 없음으로 오인하지 않는다", (data) => {
    expect(() => ompNativeDetails("session", data)).toThrow();
  });
});

describe("기존 OMP 연결의 RPC 전달", () => {
  it("조회와 일시정지는 기존 transport를 쓰며 모델 턴을 중단하지 않는다", async () => {
    const f = fixture();
    expect(await invokeOmpNative(f.session, { op: "get", id: "agent", sessionId: "session" })).toMatchObject({ available: true, details: { reading: { state: "active" } } });
    expect(await invokeOmpNative(f.session, f.input("pause"))).toMatchObject({ available: true, details: { identity: "native-goal", tokenBudget: 200, tokensUsed: 4, reading: { state: "paused" } } });
    expect(f.request.mock.calls.map(([c]) => c)).toEqual([{ type: "goal", op: "get" }, { type: "goal", op: "get" }, { type: "goal", op: "pause" }]);
  });
  it("명시적인 생성 요청에서만 네이티브 목표를 만든다", async () => {
    const f = fixture({ goal: null, state: null });
    await invokeOmpNative(f.session, { op: "get", id: "agent", sessionId: "session" });
    expect(f.request).toHaveBeenCalledOnce();
    expect(await invokeOmpNative(f.session, f.input("create"))).toMatchObject({ details: { objective: "Finish the fixture", reading: { state: "active" } } });
  });
  it("없는 연결은 조회만 unavailable로 반환하고 복원하지 않는다", async () => {
    const f = fixture(); f.manager.getAgent.mockReturnValue(null);
    expect(await invokeOmpNative(f.session, { op: "get", id: "agent", sessionId: "session" })).toEqual({ protocol: 1, available: false });
    await expect(invokeOmpNative(f.session, f.input("pause"))).rejects.toThrow(/Open this/);
    expect(f.runtime.getState).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it("Paseo가 감싼 세션에서도 등록된 원본 연결 하나만 사용한다", async () => {
    const f = fixture();
    const describePersistence = () => ({ sessionId: "session", nativeHandle: "/fixture/session.jsonl" });
    const raw = { provider: "omp", runtimeSession: f.runtime, describePersistence, closed: false };
    const owner = { describePersistence };
    f.manager.getAgent.mockReturnValue({ provider: "omp", session: owner } as unknown as typeof f.live);
    rememberOmpSessions([raw]); rememberOmpSessions([raw]);
    try {
      expect(await invokeOmpNative(f.session, { op: "get", id: "agent", sessionId: "session" })).toMatchObject({ available: true });
      expect(f.request).toHaveBeenCalledOnce();
    } finally { raw.closed = true; rememberOmpSessions([]); }
  });
  it("조회는 휴면 상태를 유지하고 사용자 동작에서만 표준 loader를 호출한다", async () => {
    const f = fixture(response("paused")); f.manager.getAgent.mockReturnValue(null);
    const restore = vi.fn(async () => { f.manager.getAgent.mockReturnValue(f.live); });
    expect(await invokeOmpNative(f.session, { op: "get", id: "agent", sessionId: "session" }, restore)).toMatchObject({ available: false });
    expect(restore).not.toHaveBeenCalled();
    expect(await invokeOmpNative(f.session, f.input("resume"), restore)).toMatchObject({ details: { reading: { state: "active" } } });
    expect(restore).toHaveBeenCalledOnce();
  });
  it("새로 열리는 OMP 연결은 한 번 등록하고 기존 factory 동작을 유지한다", async () => {
    const f = fixture(), raw = { provider: "omp", runtimeSession: f.runtime, describePersistence: () => ({ sessionId: "session" }), closed: false };
    class Client { async createSession(..._args: unknown[]) { return raw; } async resumeSession(..._args: unknown[]) { return raw; } }
    const original = Client.prototype.createSession, remove = installOmpSessionTracking(Client);
    expect(installOmpSessionTracking(Client)).toBe(remove);
    expect(await new Client().createSession()).toBe(raw); expect(await new Client().resumeSession()).toBe(raw);
    remove(); expect(Client.prototype.createSession).toBe(original); raw.closed = true; rememberOmpSessions([]);
  });
  it.each(["session", "revision", "permission", "user", "connection"])("%s 변경 시 쓰기를 거부한다", async (change) => {
    const f = fixture(), input = f.input("pause");
    if (change === "session") f.runtime.getState.mockResolvedValue({ sessionId: "other" });
    if (change === "revision") input.revision = "old";
    if (change === "permission") f.agent.pendingPermissions.push({} as never);
    if (change === "user") f.agent.lastUserMessageAt = new Date().toISOString();
    if (change === "connection") f.runtime.getState.mockImplementationOnce(async () => { f.live.session = { runtimeSession: { ...f.runtime } }; return { sessionId: "session" }; });
    await expect(invokeOmpNative(f.session, input)).rejects.toThrow();
    expect(f.request.mock.calls.some(([c]) => c.op !== "get")).toBe(false);
  });
  it("응답이 불확실한 작업을 같은 ID로 재전송하지 않는다", async () => {
    const f = fixture(), input = f.input("pause"), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (command) => { if (command.op === "pause") throw Error("Lost response"); return original(command); });
    await expect(invokeOmpNative(f.session, input)).rejects.toThrow(/Lost response/);
    await expect(invokeOmpNative(f.session, input)).rejects.toThrow(/already submitted/);
    expect(f.request.mock.calls.filter(([c]) => c.op === "pause")).toHaveLength(1);
  });
  it("다른 플러그인 RPC를 원래 dispatcher에 넘기고 설치·제거는 중복 안전하다", async () => {
    const original = vi.fn((_message: { type: string; pluginId?: string; method?: string; input?: unknown; requestId?: string }) => "original");
    class Session { dispatchPluginMessage = original; }
    // 실제 런타임과 같이 prototype 메서드에 설치한다.
    Session.prototype.dispatchPluginMessage = original;
    const remove = installOmpNativeBridge(Session);
    expect(installOmpNativeBridge(Session)).toBe(remove);
    const f = fixture(), dispatch = Session.prototype.dispatchPluginMessage;
    expect(dispatch.call(f.session, { type: "other" })).toBe("original");
    await dispatch.call(f.session, { type: "plugin.rpc.invoke.request", pluginId: "session-recovery", method: OMP_GOAL_RPC, requestId: "request", input: { op: "capabilities" } });
    expect(f.session.emit).toHaveBeenCalledWith({ type: "plugin.rpc.invoke.response", payload: { requestId: "request", output: { protocol: 1, available: true } } });
    expect(() => dispatch.call({ ...f.session, clientId: "remote-client" }, { type: "plugin.rpc.invoke.request", pluginId: "session-recovery", method: OMP_GOAL_RPC, input: { op: "capabilities" } })).toThrow(/local recovery/);
    remove(); remove(); expect(Session.prototype.dispatchPluginMessage).toBe(original);
  });
  it("모델 복원 실패는 Goal 요청 미전송으로 응답하고 모델을 자동 교체하지 않는다", async () => {
    const f = fixture(); f.manager.getAgent.mockReturnValue(null);
    const original = vi.fn((_message: { type: string; pluginId?: string; method?: string; input?: unknown; requestId?: string }) => undefined);
    class Session { dispatchPluginMessage = original; }
    Session.prototype.dispatchPluginMessage = original;
    const remove = installOmpNativeBridge(Session, async () => { throw Error("Could not restore model fixture/free-model"); });
    try {
      await Session.prototype.dispatchPluginMessage.call(f.session, { type: "plugin.rpc.invoke.request", pluginId: "session-recovery", method: OMP_GOAL_RPC, requestId: "request", input: f.input("pause") });
      expect(f.session.emit).toHaveBeenCalledWith({ type: "plugin.rpc.invoke.response", payload: { requestId: "request", output: { protocol: 1, available: false, notSubmitted: true,
        error: "The saved OMP model is unavailable. Choose another model in Paseo and retry." } } });
      expect(f.request).not.toHaveBeenCalled();
    } finally { remove(); }
  });
  it("동시 읽기를 합치고 bridge가 없는 호스트에서는 provider를 띄우지 않는다", async () => {
    const f = fixture(), rpc = vi.fn((input) => invokeOmpNative(f.session, input));
    const client = new OmpNativeGoals(rpc);
    await Promise.all([client.details(f.agent), client.details(f.agent), client.details(f.agent)]);
    expect(rpc.mock.calls.filter(([c]) => c.op === "capabilities")).toHaveLength(1);
    expect(f.request).toHaveBeenCalledOnce();
    const absent = vi.fn(async () => ({ protocol: 1 as const, available: false }));
    const unsupported = new OmpNativeGoals(absent);
    expect(await unsupported.details(f.agent)).toBeNull(); expect(await unsupported.details(f.agent)).toBeNull(); expect(absent).toHaveBeenCalledOnce();
  });
});
