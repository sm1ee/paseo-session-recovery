import { describe, expect, it, vi } from "vitest";
import type { PaseoAgent } from "@getpaseo/client";
import type { Agent } from "../shared/model";
import { CONNECTION_RPC, installSessionConnectionBridge, invokeSessionConnection, storedSessionPayload } from "./session-connection";

function fixture() {
  const expected: Agent = { id: "fixture", provider: "codex", title: "Fixture", workspaceId: "workspace", parentId: null,
    status: "closed", activeTurn: null, pendingPermissions: 0, archivedAt: null, lastUserMessageAt: null,
    attentionReason: null, attentionTimestamp: null, persistence: true, sessionId: "thread", internal: false, modeId: null };
  const agent = { ...expected, labels: {}, persistence: { sessionId: "thread" }, pendingPermissions: [], currentModeId: null } as unknown as PaseoAgent;
  let live: { lifecycle: string; activeTurnId: string | null } | null = null;
  const manager = { getAgent: vi.fn(() => live), listProviderSubagentActivity: vi.fn(() => [{ parentAgentId: "fixture" }]) };
  const session = { clientId: "session-recovery-fixture", pluginRuntime: {}, agentManager: manager,
    getAgentPayloadById: vi.fn(async () => structuredClone(agent)), emit: vi.fn() };
  const restore = vi.fn(async () => { live = { lifecycle: "running", activeTurnId: "native-turn" };
    agent.status = "running"; agent.activeTurn = { turnId: "native-turn", startedAt: null }; });
  return { expected, agent, session, manager, restore, loaded: () => { live = { lifecycle: "idle", activeTurnId: null }; },
    input: () => ({ op: "reconnect" as const, id: "fixture", expected }) };
}
describe("세션 연결 복원", () => {
  it("조회는 저장된 세션을 열거나 Goal을 변경하지 않는다", async () => {
    const f = fixture();
    expect(await invokeSessionConnection(f.session, { op: "inspect", id: "fixture" }, f.restore)).toMatchObject({ state: "detached" });
    expect(f.restore).not.toHaveBeenCalled();
  });
  it("동시 재연결은 표준 loader를 한 번만 쓰고 기존 ID와 새 네이티브 턴을 반환한다", async () => {
    const f = fixture();
    const results = await Promise.all([invokeSessionConnection(f.session, f.input(), f.restore), invokeSessionConnection(f.session, f.input(), f.restore)]);
    expect(f.restore).toHaveBeenCalledExactlyOnceWith("fixture", f.session);
    expect(results.map((r) => r.restored)).toEqual([true, false]);
    expect(results[0]).toMatchObject({ state: "loaded", agent: { id: "fixture", persistence: { sessionId: "thread" }, activeTurn: { turnId: "native-turn" } } });
  });
  it("실행 중이거나 이미 열린 provider를 reload하거나 중단하지 않는다", async () => {
    const f = fixture(); f.loaded();
    expect(await invokeSessionConnection(f.session, f.input(), f.restore)).toMatchObject({ state: "loaded", restored: false });
    expect(f.restore).not.toHaveBeenCalled();
  });
  it.each(["pending", "archived", "message", "thread", "workspace", "provider", "mode", "internal", "unknown-turn", "running"])("%s 변경은 연결 복원 전에 차단한다", async (kind) => {
    const f = fixture();
    if (kind === "pending") f.agent.pendingPermissions = [{}] as PaseoAgent["pendingPermissions"];
    if (kind === "archived") f.agent.archivedAt = "2026-10-20T00:00:00Z";
    if (kind === "message") f.agent.lastUserMessageAt = "2026-10-20T00:00:00Z";
    if (kind === "thread") f.agent.persistence!.sessionId = "other-thread";
    if (kind === "workspace") f.agent.workspaceId = "other-workspace";
    if (kind === "provider") f.agent.provider = "other-provider";
    if (kind === "mode") f.agent.currentModeId = "plan";
    if (kind === "internal") Object.assign(f.agent, { internal: true });
    if (kind === "unknown-turn") f.agent.activeTurn = undefined;
    if (kind === "running") f.agent.status = "running";
    await expect(invokeSessionConnection(f.session, f.input(), f.restore)).rejects.toThrow(); expect(f.restore).not.toHaveBeenCalled();
  });
  it("저장 상태는 wire에서만 보정하고 원본 기록과 attention은 보존한다", () => {
    const record = { status: "running", attentionReason: "permission", updatedAt: "fixture-time" };
    expect(storedSessionPayload(record)).toEqual({ ...record, status: "closed", activeTurn: null });
    expect(record.status).toBe("running");
    expect(storedSessionPayload({ status: "error" }).status).toBe("error");
  });
  it("다른 RPC와 작업공간 갱신 큐를 유지하고 휴면 하위에이전트를 실행 집계에서 제외한다", async () => {
    const f = fixture(), originalDispatch = vi.fn(), queue = vi.fn();
    class Session {
      clientId = f.session.clientId; pluginRuntime = {}; agentManager = f.manager; emit = f.session.emit;
      getAgentPayloadById = f.session.getAgentPayloadById;
      workspaceDirectory = { deps: {} as Record<string, unknown>, buildDescriptorMap: vi.fn() };
      dispatchPluginMessage(message: unknown) { return originalDispatch(message); }
      buildStoredAgentPayload(_record: unknown, _providers?: unknown) { return f.agent; }
      buildWorkspaceDescriptorMap(_options?: unknown) {}
      handleFetchWorkspacesRequest(_request?: unknown) { return this.workspaceDirectory.buildDescriptorMap(); }
      enqueueWorkspaceUpdates = queue;
    }
    const Class = Session as unknown as Parameters<typeof installSessionConnectionBridge>[0];
    const originalMethod = Class.prototype.dispatchPluginMessage;
    const states = vi.fn(async () => [{ id: "fixture", status: "running" }]);
    const remove = installSessionConnectionBridge(Class, f.restore, states);
    expect(installSessionConnectionBridge(Class)).toBe(remove);
    const session = new Session();
    const dispatch = Class.prototype.dispatchPluginMessage;
    await dispatch.call(session, { type: "other" }); expect(originalDispatch).toHaveBeenCalledOnce();
    await dispatch.call(session, { type: "plugin.rpc.invoke.request", pluginId: "session-recovery", method: CONNECTION_RPC, input: { op: "inspect", id: "fixture" } });
    expect(session.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "plugin.rpc.invoke.response" }));
    // A first directory snapshot must be corrected before any incremental update.
    session.handleFetchWorkspacesRequest({});
    expect(await (session.workspaceDirectory.deps.listAgentPayloads as () => Promise<unknown>)()).toEqual([{ id: "fixture", status: "closed", activeTurn: null }]);
    expect(await (session.workspaceDirectory.deps.listProviderSubagentActivity as () => Promise<unknown>)()).toEqual([]);
    f.loaded(); session.buildWorkspaceDescriptorMap();
    expect(await (session.workspaceDirectory.deps.listProviderSubagentActivity as () => Promise<unknown>)()).toEqual([{ parentAgentId: "fixture" }]);
    expect(session.enqueueWorkspaceUpdates).toBe(queue); expect(f.restore).not.toHaveBeenCalled();
    remove(); expect(Class.prototype.dispatchPluginMessage).toBe(originalMethod);
  });
});
