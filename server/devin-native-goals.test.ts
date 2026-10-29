import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent } from "@getpaseo/client";
import type { Agent } from "../shared/model";
import { DEVIN_GOAL_RPC, DevinGoals, devinNativeDetails, installDevinNativeBridge, installDevinSessionTracking, invokeDevinNative, isDevinProvider, rememberDevinSessions } from "./devin-native-goals";

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const config = { agents: { providers: { devin: { extends: "acp", command: ["/fixture/devin", "acp"] }, alias: { extends: "devin" } } } };
function native(status = "running", turns = 2) { return { goal: { id: "0", objective: "Finish the fixture", status, turns } }; }
function fixture() {
  const raw = { closed: false, sessionId: "native", connection: { extMethod: vi.fn(async () => native()) }, describePersistence: () => ({ sessionId: "native", nativeHandle: "native" }) };
  const live = { provider: "devin", session: raw, archivedAt: null as string | null, internal: false };
  const manager = { getAgent: vi.fn(() => live as typeof live | null) };
  const session = { clientId: "session-recovery-fixture", pluginRuntime: {}, agentManager: manager, emit: vi.fn() };
  return { raw, live, session, manager, input: { op: "get" as const, id: "agent", sessionId: "native", provider: "devin" } };
}
async function reader(status = "running") {
  const home = await mkdtemp(join(tmpdir(), "paseo-devin-test-")); dirs.push(home);
  await writeFile(join(home, "config.json"), JSON.stringify(config));
  let data = native(status);
  const rpc = vi.fn(async (input: { op: string }) => ({ protocol: 1 as const, available: true, ...(input.op === "get" ? { details: devinNativeDetails("native", data) } : {}) }));
  const goals = new DevinGoals(home, rpc);
  const expected: Agent = { id: "agent", title: "Fixture", provider: "devin", workspaceId: "workspace", parentId: null, status: status === "running" ? "running" : "idle",
    activeTurn: status === "running" ? "turn" : null, pendingPermissions: 0, archivedAt: null, lastUserMessageAt: "before", attentionReason: null, attentionTimestamp: null,
    sessionId: "native", persistence: true, internal: false, modeId: "normal" };
  const current = { ...expected };
  const agent = { ...expected, persistence: { sessionId: "native" }, labels: {}, pendingPermissions: [] } as unknown as PaseoAgent;
  const io = { guard: vi.fn(), submitted: vi.fn(), fetch: vi.fn(async () => ({ ...current })),
    pause: vi.fn(async () => { data = native("paused", 3); current.status = "idle"; current.activeTurn = null; }),
    resume: vi.fn(async () => { data = native("running", 3); current.status = "running"; current.activeTurn = "next"; current.lastUserMessageAt = "after"; }) };
  return { goals, expected, current, agent, io, rpc, get data() { return data; }, set data(value) { data = value; },
    revision: () => devinNativeDetails("native", data).revision };
}

describe("Devin의 실제 Goal 응답 형식", () => {
  it("running과 턴 수를 읽고 사용량이나 예산을 추정하지 않는다", () => {
    expect(devinNativeDetails("native", native())).toMatchObject({ objective: "Finish the fixture", identity: "0", nativeTurns: 2, tokenBudget: null, tokensUsed: null,
      nativeControls: true, sessionControls: true, reading: { source: "devin", state: "active", nativeContinuation: true } });
    expect(devinNativeDetails("native", {}).reading).toMatchObject({ state: "cleared", evidence: true, key: null });
  });
  it.each(["paused", "blocked", "complete", "cleared"])("%s 상태를 그대로 반영한다", status => expect(devinNativeDetails("native", native(status)).reading.state).toBe(status));
  it("턴 증가는 티켓을 깨지 않고 새 목표와 상태 변경은 구분한다", () => {
    const a = devinNativeDetails("native", native());
    expect(devinNativeDetails("native", native("running", 50)).revision).toBe(a.revision);
    expect(devinNativeDetails("native", native("paused")).revision).not.toBe(a.revision);
    expect(devinNativeDetails("native", { goal: { ...native().goal, id: "1" } }).reading.key).not.toBe(a.reading.key);
  });
  it.each([null, [], { status: "running" }, { error: "offline", goal: null }, { goal: {} }, native("invalid"), native("running", -1), native("running", 1.5)])("불완전한 응답을 목표 없음으로 표시하지 않는다", value => expect(() => devinNativeDetails("native", value)).toThrow());
  it("provider 상속과 명시된 Devin ACP를 지원하고 다른 provider 및 cloud는 제외한다", () => {
    expect(isDevinProvider(config, "alias")).toBe(true);
    expect(isDevinProvider({ agents: { providers: { ...config.agents.providers, alias: { extends: "devin", command: ["other", "acp"] } } } }, "alias")).toBe(false); expect(isDevinProvider(config, "codex")).toBe(false);
    expect(isDevinProvider({ agents: { providers: { other: { extends: "acp", command: ["devin", "acp"] } } } }, "other")).toBe(true);
    expect(isDevinProvider({ agents: { providers: { devin: { extends: "acp", command: ["devin", "acp", "--cloud"] } } } }, "devin")).toBe(false);
    expect(isDevinProvider({ agents: { providers: { devin: { extends: "devin" } } } }, "devin")).toBe(false);
  });
});

describe("기존 ACP 연결의 읽기 전용 전달", () => {
  it("명시한 세션의 기존 연결에만 정확한 확장 메서드를 전송한다", async () => {
    const f = fixture(); expect(await invokeDevinNative(f.session, f.input)).toMatchObject({ available: true, details: { reading: { source: "devin", state: "active" } } });
    expect(f.raw.connection.extMethod).toHaveBeenCalledExactlyOnceWith("_cognition.ai/goal/get", { sessionId: "native" });
  });
  it("실제 Paseo처럼 새 snapshot 복사본을 반환해도 동일 연결이면 읽는다", async () => {
    const f = fixture(); f.manager.getAgent.mockImplementation(() => ({ ...f.live }));
    expect(await invokeDevinNative(f.session, f.input)).toMatchObject({ available: true, details: { reading: { state: "active" } } });
    expect(f.raw.connection.extMethod).toHaveBeenCalledOnce();
  });
  it("동시 조회를 합치며 조회 시 세션 생성이나 복원을 하지 않는다", async () => {
    const f = fixture(); await Promise.all(Array.from({ length: 100 }, () => invokeDevinNative(f.session, f.input)));
    expect(f.raw.connection.extMethod).toHaveBeenCalledOnce(); f.manager.getAgent.mockReturnValue(null);
    expect(await invokeDevinNative(f.session, f.input)).toEqual({ protocol: 1, available: false });
    expect(f.raw.connection.extMethod).toHaveBeenCalledOnce();
  });
  it.each(["provider", "archived", "internal", "closed", "native-id"])("%s가 다르면 native 요청을 하지 않는다", async change => {
    const f = fixture(); if (change === "provider") f.live.provider = "other";
    if (change === "archived") f.live.archivedAt = "now"; if (change === "internal") f.live.internal = true;
    if (change === "closed") f.raw.closed = true; if (change === "native-id") f.input.sessionId = "other";
    expect((await invokeDevinNative(f.session, f.input)).available).toBe(false); expect(f.raw.connection.extMethod).not.toHaveBeenCalled();
  });
  it("Paseo가 감싼 연결은 등록된 원본 하나만 선택한다", async () => {
    const f = fixture(), owner = { describePersistence: f.raw.describePersistence };
    rememberDevinSessions([f.raw]); f.live.session = owner as typeof f.raw;
    try { expect((await invokeDevinNative(f.session, f.input)).available).toBe(true); }
    finally { f.raw.closed = true; rememberDevinSessions([]); }
  });
  it("요청 도중 연결이 바뀌면 결과를 버린다", async () => {
    const f = fixture(); f.raw.connection.extMethod.mockImplementationOnce(async () => { f.live.session = { ...f.raw }; return native(); });
    await expect(invokeDevinNative(f.session, f.input)).rejects.toThrow(/connection changed/);
  });
  it("응답이 멈추어도 연결을 죽이지 않고 4초 뒤 조회만 실패한다", async () => {
    vi.useFakeTimers(); const f = fixture(); f.raw.connection.extMethod.mockImplementation(() => new Promise(() => {}));
    const result = expect(invokeDevinNative(f.session, f.input)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(4000); await result; expect(f.raw.closed).toBe(false);
  });
  it("tracking은 기존 factory 반환값을 유지하고 중복 설치 및 해제가 안전하다", async () => {
    const f = fixture(); class Client { async createSession() { return f.raw; } async resumeSession() { return f.raw; } }
    const original = Client.prototype.createSession, remove = installDevinSessionTracking(Client);
    expect(installDevinSessionTracking(Client)).toBe(remove); expect(await new Client().createSession()).toBe(f.raw);
    expect(await new Client().resumeSession()).toBe(f.raw); remove(); expect(Client.prototype.createSession).toBe(original);
    f.raw.closed = true; rememberDevinSessions([]);
  });
  it("bridge는 recovery 로컬 연결만 허용하고 임의 확장이나 쓰기 명령은 노출하지 않는다", async () => {
    const f = fixture(), fallback = vi.fn();
    class Session { dispatchPluginMessage(_message: unknown): unknown { return fallback(_message); } }
    const original = Session.prototype.dispatchPluginMessage;
    const remove = installDevinNativeBridge(Session);
    const msg = { type: "plugin.rpc.invoke.request", pluginId: "session-recovery", method: DEVIN_GOAL_RPC, requestId: "request", input: f.input };
    try {
      await Session.prototype.dispatchPluginMessage.call(f.session, msg); expect(f.session.emit).toHaveBeenCalledOnce();
      expect(() => Session.prototype.dispatchPluginMessage.call({ ...f.session, clientId: "external" }, msg)).toThrow(/local recovery/);
      await expect(invokeDevinNative(f.session, { ...f.input, op: "resume" } as never)).rejects.toThrow(/Invalid/);
    } finally { remove(); }
    expect(Session.prototype.dispatchPluginMessage).toBe(original);
  });
});

describe("Devin 명시적 Pause 및 Resume", () => {
  it("현재 턴을 취소하고 실제 native paused 전이를 확인한다", async () => {
    const f = await reader(); expect(await f.goals.control(f.agent, f.revision(), "pause", f.expected, f.io)).toMatchObject({ source: "devin", state: "paused" });
    expect(f.io.pause).toHaveBeenCalledOnce(); expect(f.io.resume).not.toHaveBeenCalled(); expect(f.io.submitted).toHaveBeenCalledOnce();
  });
  it.each(["paused", "blocked"])("%s 목표는 명시적 native resume으로만 재개한다", async state => {
    const f = await reader(state); expect(await f.goals.control(f.agent, f.revision(), "resume", f.expected, f.io)).toMatchObject({ state: "active" });
    expect(f.io.resume).toHaveBeenCalledOnce(); expect(f.io.pause).not.toHaveBeenCalled();
  });
  it("재개 직후 곧바로 blocked가 되어도 턴 증가와 전송 증거가 있으면 실제 상태를 반환한다", async () => {
    const f = await reader("paused"); f.io.resume.mockImplementationOnce(async () => { f.data = native("blocked", 3); f.current.lastUserMessageAt = "after"; });
    expect((await f.goals.control(f.agent, f.revision(), "resume", f.expected, f.io)).state).toBe("blocked");
  });
  it.each(["revision", "permission", "new-message", "turn", "goal-state"])("%s 변경 시 명령을 보내지 않는다", async change => {
    const f = await reader(); let revision = f.revision();
    if (change === "revision") revision = "old"; if (change === "permission") f.current.pendingPermissions = 1;
    if (change === "new-message") f.current.lastUserMessageAt = "new"; if (change === "turn") f.current.activeTurn = "other";
    if (change === "goal-state") f.data = native("complete");
    await expect(f.goals.control(f.agent, revision, "pause", f.expected, f.io)).rejects.toThrow();
    expect(f.io.pause).not.toHaveBeenCalled(); expect(f.io.resume).not.toHaveBeenCalled();
  });
  it("불확실한 전송은 자동 재시도하지 않는다", async () => {
    const f = await reader("paused"); f.io.resume.mockRejectedValue(new Error("Receipt unavailable"));
    await expect(f.goals.control(f.agent, f.revision(), "resume", f.expected, f.io)).rejects.toThrow(/Receipt/);
    expect(f.io.resume).toHaveBeenCalledOnce(); expect(f.io.submitted).toHaveBeenCalledOnce();
  });
  it("다른 provider 조회에는 native RPC를 보내지 않는다", async () => {
    const f = await reader(); expect(await f.goals.details({ ...f.agent, provider: "codex" })).toBeNull(); expect(f.rpc).not.toHaveBeenCalled();
  });
});
