import { describe, expect, it, vi } from "vitest";
import { preferences, statusInput } from "../shared/contracts";
import { emptyState, HOUR, holdIds, stateSchema, type Agent, type SavedState, type Workspace } from "../shared/model";
import type { RecoveryHost } from "./host";
import { RecoveryService, type RecoveryEvent } from "./service";
import { RecoveryError } from "./store";
import type { GoalReading } from "./goals";
import type { CodexGoalDetails } from "./codex-goals";
import { OmpGoalPreconditionError } from "./omp-native-goals";

const epoch = Date.parse("2026-10-20T00:00:00Z");
const hook = { id: "session", title: "Test session", provider: "codex", workspaceId: "workspace", parentAgentId: null as string | null };
function fixture(options: Record<string, unknown> = {}) {
  let clock = epoch;
  let saved = emptyState("host");
  let shuttingDown = false;
  let goalReading: GoalReading = { state: "unknown", key: null, evidence: false };
  let service!: RecoveryService;
  const a: Agent = { id: hook.id, title: hook.title, provider: hook.provider, workspaceId: hook.workspaceId, parentId: null,
    status: "running", activeTurn: "turn-1", pendingPermissions: 0, archivedAt: null, lastUserMessageAt: new Date(epoch).toISOString(),
    attentionReason: null, attentionTimestamp: null, persistence: true, internal: false };
  const workspace: Workspace = { id: "workspace", archived: false, archiving: false };
  const others = new Map<string, Agent>();
  const store = { load: vi.fn(async () => structuredClone(saved)), save: vi.fn(async (s: SavedState) => { saved = structuredClone(s); }) };
  const fetch = vi.fn(async (id: string) => structuredClone(id === a.id ? a : others.get(id) ?? null));
  const getWorkspace = vi.fn(async () => structuredClone(workspace));
  const goal = vi.fn(async (_id: string, _options?: { allowTimeline?: boolean }) => structuredClone(goalReading));
  const supportsGoalCommand = vi.fn(async () => true);
  let details: CodexGoalDetails | null = null;
  const goalDetails = vi.fn(async (_id: string) => structuredClone(details));
  const editGoal = vi.fn(async (_id: string, _revision: string, _objective: string, _expected: Agent, check: () => void, _messageId: string, submitted: () => void): Promise<GoalReading> => {
    check(); submitted(); return { state: "active", key: "edited-goal", evidence: true, source: "codex" };
  });
  const controlGoal = vi.fn(async (_id: string, _revision: string, action: "pause" | "resume", _expected: Agent, check: () => void, _messageId: string, submitted: () => void): Promise<GoalReading> => {
    check(); submitted();
    const reading: GoalReading = { ...details!.reading, state: action === "pause" ? "paused" : "active" };
    details = { ...details!, reading }; goalReading = reading;
    return reading;
  });
  const resumeBlockedGoal = vi.fn(async (_id: string, key: string, _expected: Agent, check: () => void, _messageId: string, submitted?: () => void) => {
    check(); if (goalReading.state !== "blocked" || goalReading.key !== key) throw new Error("Goal changed");
    submitted?.();
    goalReading = { ...goalReading, state: "active" }; return structuredClone(goalReading);
  });
  const send = vi.fn(async (_id: string, _prompt: string, _messageId: string, _expected: Agent, check: () => void) => { check(); });
  const connection = vi.fn(async () => "loaded" as "loaded" | "detached" | "unknown");
  const reconnectSession = vi.fn(async (_id: string, _expected: Agent, check: () => void) => { check(); return structuredClone(a); });
  const settings = preferences.schema.parse(options);
  const hosts: RecoveryHost[] = [];
  const create = (bootKey: string) => {
    const host: RecoveryHost = { bootKey, serverId: "host", store, fetch, workspace: getWorkspace,
      shuttingDown: vi.fn(async () => shuttingDown), goal, goalDetails, editGoal, controlGoal, supportsGoalCommand, resumeBlockedGoal, connection, reconnectSession, send, close: vi.fn(async () => {}) };
    hosts.push(host); service = new RecoveryService(async () => host, () => clock, false); return service;
  };
  create("boot-a");
  const event = (value: Omit<RecoveryEvent, "agent">) => service.observe({ ...value, agent: { ...hook, parentAgentId: a.parentId } } as RecoveryEvent);
  return {
    a, others, workspace, settings, store, fetch, getWorkspace, goal, goalDetails, editGoal, controlGoal, supportsGoalCommand, resumeBlockedGoal, connection, reconnectSession, send, hosts,
    setDetails: (value: CodexGoalDetails | null) => { details = value; },
    setGoal: (reading: GoalReading) => { goalReading = reading; },
    get service() { return service; },
    get saved() { return structuredClone(saved); }, setSaved: (s: SavedState) => { saved = structuredClone(s); },
    advance: (n: number) => { clock += n; }, shutdown: (value: boolean) => { shuttingDown = value; },
    event,
    async track() { await service.configure(settings); await event({ kind: "start", turnId: "turn-1" } as Omit<RecoveryEvent, "agent">); clock += 1000; await service.scanNow(); },
    idle() { a.status = "idle"; a.activeTurn = null; },
    async restart(boot = "boot-b") { create(boot); await service.configure(settings); },
    row() { return service.status(statusInput.parse({})).rows[0]; },
  };
}
describe("일시 장애와 데몬 종료 뒤 선택한 Goal 복구", () => {
  const active: GoalReading = { state: "active", key: "fixture-goal", identity: "native-identity", evidence: true, source: "codex" };
  async function selected(options: Record<string, unknown> = {}) {
    const f = fixture({ continueGoals: true, recoverInterruptedGoals: true, ...options });
    f.a.sessionId = "fixture-session"; f.setGoal(active);
    f.setDetails({ reading: active, objective: "Fixture objective", revision: "native", identity: "native-identity", tokenBudget: 100, tokensUsed: 3 });
    await f.track(); await f.service.watchGoal("session", active.key!); return f;
  }
  async function failed(f: Awaited<ReturnType<typeof selected>>, turnId = "turn-1", code = "server_overloaded") {
    f.idle(); f.setGoal({ ...active, state: "blocked" });
    await f.event({ kind: "end", turnId, outcome: { kind: "failed", error: { code } } } as Omit<RecoveryEvent, "agent">);
  }
  it("일시 장애로 blocked가 된 동일 Goal만 지연 뒤 네이티브 재개한다", async () => {
    const f = await selected(); await failed(f);
    expect(f.saved.records.session.goalInterruption).toMatchObject({ key: active.key, cause: "transient_error", identity: active.identity });
    f.advance(59_999); await f.service.scanNow(); expect(f.resumeBlockedGoal).not.toHaveBeenCalled();
    f.advance(1); await f.service.scanNow();
    expect(f.resumeBlockedGoal).toHaveBeenCalledExactlyOnceWith("session", active.key, expect.objectContaining({ sessionId: "fixture-session" }), expect.any(Function), expect.any(String), expect.any(Function), active.identity);
    expect(f.saved.records.session.goal).toMatchObject({ state: "active", selectedKey: active.key, attempts: 1 });
    expect(f.send).not.toHaveBeenCalled(); expect(f.controlGoal).not.toHaveBeenCalled();
  });
  it.each([{ recoverInterruptedGoals: false }, { continueGoals: false }, { enabled: false }])("설정 %j이면 Goal을 자동 재개하지 않는다", async (options) => {
    const f = await selected(options); await failed(f); f.advance(HOUR); await f.service.scanNow();
    expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.reconnectSession).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("오류를 관찰한 뒤 설정을 켜도 새 대기 시간을 준다", async () => {
    const f = await selected({ recoverInterruptedGoals: false }); await failed(f); f.advance(60_000);
    await f.service.configure({ ...f.settings, recoverInterruptedGoals: true });
    expect(f.saved.records.session.reason).toBe("transient_error"); expect(f.resumeBlockedGoal).not.toHaveBeenCalled();
    f.advance(60_000); await f.service.scanNow(); expect(f.resumeBlockedGoal).toHaveBeenCalledOnce();
  });
  it("구버전에서 선택한 Goal도 명령 전에 현재 네이티브 식별자를 고정한다", async () => {
    const f = await selected(), saved = f.saved;
    delete saved.records.session.goal!.identity; f.setSaved(saved); await f.restart("boot-a");
    await failed(f); f.advance(60_000); await f.service.scanNow();
    expect(f.resumeBlockedGoal).toHaveBeenCalledExactlyOnceWith("session", active.key, expect.any(Object), expect.any(Function), expect.any(String), expect.any(Function), active.identity);
  });
  it.each(["usage_limit_reached", "authentication_failed", "model_not_found", "429"])("%s 오류는 일시 장애 재개로 우회하지 않는다", async (code) => {
    const f = await selected(); await failed(f, "turn-1", code); f.advance(HOUR); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("provider_error"); expect(f.resumeBlockedGoal).not.toHaveBeenCalled();
  });
  it.each(["paused", "limited", "complete", "cleared", "unknown"] as const)("장애 뒤 %s Goal은 재개하지 않는다", async (state) => {
    const f = await selected(); await failed(f); f.setGoal({ ...active, state }); f.advance(60_000); await f.service.scanNow();
    expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.reconnectSession).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["key", "identity"] as const)("같은 세션의 %s 변경을 이전 Goal의 장애로 처리하지 않는다", async (field) => {
    const f = await selected(); await failed(f); f.setGoal({ ...active, state: "blocked", [field]: "replacement" });
    f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("new_activity"); expect(f.saved.records.session.goal?.selectedKey).toBeNull(); expect(f.resumeBlockedGoal).not.toHaveBeenCalled();
  });
  it.each(["stop", "permission", "message", "unwatch", "exclude", "disable"] as const)("대기 중 %s가 오면 재개하지 않는다", async (action) => {
    const f = await selected(); await failed(f);
    if (action === "stop") await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
    if (action === "permission") await f.event({ kind: "permission", requestId: "approval" } as Omit<RecoveryEvent, "agent">);
    if (action === "message") f.a.lastUserMessageAt = new Date(epoch + 30_000).toISOString();
    if (action === "unwatch") await f.service.unwatchGoal("session");
    if (action === "exclude") await f.service.exclude("session", true);
    if (action === "disable") await f.service.configure({ ...f.settings, recoverInterruptedGoals: false });
    f.advance(HOUR); await f.service.scanNow();
    expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.reconnectSession).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("일시 오류 근거 없이 blocked가 된 목표는 새 설정으로도 재개하지 않는다", async () => {
    const f = await selected(); f.idle(); f.setGoal({ ...active, state: "blocked" });
    await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "completed" } } as Omit<RecoveryEvent, "agent">);
    f.advance(HOUR); await f.service.scanNow(); await f.restart(); f.advance(HOUR); await f.service.scanNow();
    expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("반복 장애의 backoff와 횟수는 턴과 데몬 재시작을 넘어 유지된다", async () => {
    const f = await selected({ maxAttempts: 2 }); await failed(f); f.advance(60_000); await f.service.scanNow();
    await f.event({ kind: "start", turnId: "turn-2" } as Omit<RecoveryEvent, "agent">); await failed(f, "turn-2");
    await f.restart(); f.advance(119_999); await f.service.scanNow(); expect(f.resumeBlockedGoal).toHaveBeenCalledTimes(1);
    f.advance(1); await f.service.scanNow(); expect(f.resumeBlockedGoal).toHaveBeenCalledTimes(2);
    await f.event({ kind: "start", turnId: "turn-3" } as Omit<RecoveryEvent, "agent">); await failed(f, "turn-3");
    f.advance(HOUR); await f.service.scanNow(); expect(f.saved.records.session.reason).toBe("attempt_limit");
    await f.restart("boot-c"); f.advance(HOUR); await f.service.scanNow(); expect(f.resumeBlockedGoal).toHaveBeenCalledTimes(2);
    expect(f.saved.records.session.goal?.attempts).toBe(2);
  });
  it("수신 확인을 잃은 Goal 재개는 데몬 재시작 후에도 반복하지 않는다", async () => {
    const f = await selected(); await failed(f);
    f.resumeBlockedGoal.mockImplementationOnce(async (_id, _key, _expected, check, _messageId, submitted) => { check(); submitted?.(); throw new Error("Receipt lost"); });
    f.advance(60_000); await f.service.scanNow(); expect(f.saved.records.session.reason).toBe("uncertain_send");
    await f.restart(); f.advance(HOUR); await f.service.scanNow(); expect(f.resumeBlockedGoal).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it("데몬이 죽으면 실행 중인 턴이 없던 선택 Goal도 기존 세션에 재연결한다", async () => {
    const f = await selected(); f.idle(); await f.service.scanNow();
    f.a.status = "closed"; f.connection.mockResolvedValue("detached");
    await f.restart(); expect(f.saved.records.session.reason).toBe("daemon_restart");
    f.advance(60_000); await f.service.scanNow();
    expect(f.reconnectSession).toHaveBeenCalledOnce(); expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.controlGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(f.saved.records.session.goal).toMatchObject({ selectedKey: active.key, attempts: 1 });
  });
  it.each(["codex", "omp", "opencode", "claude"] as const)("데몬 종료 뒤 %s Goal은 예산을 초기화하지 않고 재연결한다", async (source) => {
    const f = await selected(); const reading = { ...active, source, nativeContinuation: source !== "codex" };
    f.setGoal(reading); f.setDetails({ reading, objective: "Fixture objective", revision: "native", identity: active.identity, tokenBudget: 100, tokensUsed: 3 });
    f.a.status = "closed"; f.a.activeTurn = null; f.connection.mockResolvedValue("detached");
    await f.restart(); f.advance(60_000); await f.service.scanNow();
    expect(f.reconnectSession).toHaveBeenCalledOnce(); expect(f.controlGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("재연결 중 예산 초기화는 성공으로 처리하지 않고 반복을 차단한다", async () => {
    const f = await selected(); f.a.status = "closed"; f.a.activeTurn = null; f.connection.mockResolvedValue("detached");
    f.reconnectSession.mockImplementationOnce(async () => { f.setDetails({ reading: active, objective: "Fixture objective", revision: "native", identity: active.identity, tokenBudget: 100, tokensUsed: 0 }); return structuredClone(f.a); });
    await f.restart(); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("uncertain_send"); await f.restart("boot-c"); f.advance(HOUR); await f.service.scanNow();
    expect(f.reconnectSession).toHaveBeenCalledOnce();
  });
  it("수동 중지한 Goal은 데몬이 바뀌어도 다시 연결하지 않는다", async () => {
    const f = await selected(); f.idle(); await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
    f.a.status = "closed"; f.connection.mockResolvedValue("detached"); await f.restart(); f.advance(HOUR); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("user_stop"); expect(f.reconnectSession).not.toHaveBeenCalled();
  });
  it("여러 Goal이 멈춰도 한 번의 스캔에서 복구를 세 개까지만 시작한다", async () => {
    const f = await selected(); f.a.status = "closed"; f.a.activeTurn = null; f.connection.mockResolvedValue("detached");
    const saved = f.saved, original = saved.records.session;
    for (let i = 1; i < 12; i++) {
      const id = `session-${i}`; saved.records[id] = { ...structuredClone(original), id };
      f.others.set(id, { ...structuredClone(f.a), id });
    }
    f.setSaved(saved); f.reconnectSession.mockImplementation(async (id, _expected, check) => { check(); return structuredClone(id === "session" ? f.a : f.others.get(id)!); });
    await f.restart(); f.advance(60_000); f.fetch.mockClear(); await f.service.scanNow();
    expect(f.reconnectSession).toHaveBeenCalledTimes(3);
    expect(new Set(f.fetch.mock.calls.map(([id]) => id)).size).toBe(3);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("대기 중 네이티브 Pause를 직접 누르면 일반 세션 복구로도 재실행하지 않는다", async () => {
    const f = await selected(); await failed(f);
    // 네이티브 Goal은 아직 active인 채 연결 오류로 턴만 끝난 경우.
    f.setGoal(active); const view = await f.service.readGoalEditor("session");
    expect(view.action).toBe("pause"); await f.service.actOnGoal({ ticket: view.actionTicket! });
    f.advance(HOUR); await f.service.scanNow(); await f.restart(); f.advance(HOUR); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("goal_paused"); expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("전체 복구를 다시 켜도 기존 장애에 새 대기 시간을 적용한다", async () => {
    const f = await selected({ enabled: false }); await failed(f); f.advance(HOUR); await f.service.scanNow();
    await f.service.configure({ ...f.settings, enabled: true }); expect(f.resumeBlockedGoal).not.toHaveBeenCalled();
    f.advance(60_000); await f.service.scanNow(); expect(f.resumeBlockedGoal).toHaveBeenCalledOnce();
  });
});
describe("목표 미리보기와 명시적인 네이티브 제어", () => {
  async function controls(source: "codex" | "opencode" | "claude" | "omp" = "codex", state: GoalReading["state"] = "active") {
    const f = fixture({ enabled: false, continueGoals: false }); f.a.provider = source; f.a.sessionId = "native-fixture"; f.idle();
    const reading: GoalReading = { state, key: "original-goal", evidence: true, source };
    f.setGoal(reading); f.setDetails({ reading, objective: "Private fixture objective", revision: "native-revision", tokenBudget: 100, tokensUsed: 3 });
    await f.service.configure(f.settings); return f;
  }
  it.each(["codex", "opencode", "omp"] as const)("멈춘 %s 세션의 active Goal은 Pause 대신 연결 복원용 Resume를 제공한다", async (source) => {
    const f = await controls(source); f.a.status = "closed"; f.a.activeTurn = null; f.connection.mockResolvedValue("detached");
    if (source === "omp") f.setDetails({ reading: { state: "active", key: "original-goal", evidence: true, source: "omp", nativeContinuation: true },
      objective: "Fixture", revision: "native", tokenBudget: 100, tokensUsed: 4, nativeControls: true });
    const view = await f.service.readGoalEditor("session");
    expect(view).toMatchObject({ action: "resume", reconnect: true, actionTicket: expect.any(String) });
    expect(await f.service.goalControl("session", true, false, true)).toMatchObject({ nativeAction: "resume", nativeReconnect: true, nativeActionReady: true });
    expect(f.reconnectSession).not.toHaveBeenCalled(); expect(f.saved.records).toEqual({});
    await f.service.actOnGoal({ ticket: view.actionTicket! });
    expect(f.reconnectSession).toHaveBeenCalledExactlyOnceWith("session", expect.objectContaining({ status: "closed", sessionId: "native-fixture" }), expect.any(Function));
    expect(f.controlGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(f.saved.history.at(-1)).toMatchObject({ action: "resume", reason: "reconnected" });
    expect(f.saved.records.session.goal).toMatchObject({ state: "active", selectedKey: null });
    await expect(f.service.actOnGoal({ ticket: view.actionTicket! })).rejects.toThrow(/expired/);
  });
  it("재연결 중 시작된 네이티브 턴을 같은 세션에서 관찰하며 Goal 명령은 보내지 않는다", async () => {
    const f = await controls(); f.a.status = "closed"; f.a.activeTurn = null; f.connection.mockResolvedValue("detached");
    const view = await f.service.readGoalEditor("session"); let start: Promise<void> | undefined;
    f.reconnectSession.mockImplementationOnce(async (_id, _expected, check) => {
      expect(f.saved.records.session.phase).toBe("sending"); f.a.status = "running"; f.a.activeTurn = "reconnected-turn";
      start = f.event({ kind: "start", turnId: "reconnected-turn" } as Omit<RecoveryEvent, "agent">); check(); return structuredClone(f.a);
    });
    await f.service.actOnGoal({ ticket: view.actionTicket! }); await start;
    expect(f.saved.records.session).toMatchObject({ phase: "watching", turnId: "reconnected-turn" });
    expect(f.controlGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("수동 재연결은 이미 선택한 추가 이어가기를 끄거나 횟수를 초기화하지 않는다", async () => {
    const f = await controls(); await f.service.watchGoal("session", "original-goal");
    f.a.status = "closed"; f.a.activeTurn = null; f.connection.mockResolvedValue("detached");
    const view = await f.service.readGoalEditor("session"); await f.service.actOnGoal({ ticket: view.actionTicket! });
    expect(f.saved.records.session.goal).toMatchObject({ key: "original-goal", selectedKey: "original-goal", attempts: 0 });
  });
  it("동반 모듈이 없으면 멈춘 Goal을 Pause로 표시하지 않고 Resume를 비활성화한다", async () => {
    const f = await controls(); f.a.status = "closed"; f.a.activeTurn = undefined; f.connection.mockResolvedValue("unknown");
    expect(await f.service.readGoalEditor("session")).toMatchObject({ action: "resume", reconnect: true, actionTicket: null });
    expect(await f.service.goalControl("session", true, false, true)).toMatchObject({ nativeAction: "resume", nativeReconnect: true, nativeActionReady: false });
    expect(f.reconnectSession).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["goal", "permission", "running", "receipt", "budget"] as const)("재연결의 %s 변경이나 불확실성은 재실행으로 우회하지 않는다", async (block) => {
    const f = await controls(); f.a.status = "closed"; f.a.activeTurn = null; f.connection.mockResolvedValue("detached");
    const view = await f.service.readGoalEditor("session");
    if (block === "goal") f.setDetails({ reading: { state: "paused", key: "original-goal", evidence: true, source: "codex" }, objective: "Private fixture objective", revision: "changed", tokenBudget: 100, tokensUsed: 3 });
    if (block === "permission") await f.event({ kind: "permission", requestId: "approval" } as Omit<RecoveryEvent, "agent">);
    if (block === "running") f.connection.mockResolvedValue("loaded");
    if (block === "receipt") f.reconnectSession.mockRejectedValueOnce(new Error("Lost acknowledgement"));
    if (block === "budget") f.reconnectSession.mockImplementationOnce(async () => { f.setDetails({ reading: { state: "active", key: "original-goal", evidence: true, source: "codex" }, objective: "Private fixture objective", revision: "native-revision", tokenBudget: 200, tokensUsed: 0 }); return structuredClone(f.a); });
    await expect(f.service.actOnGoal({ ticket: view.actionTicket! })).rejects.toThrow();
    if (["receipt", "budget"].includes(block)) expect(f.saved.records.session.reason).toBe("uncertain_send");
    else expect(f.reconnectSession).not.toHaveBeenCalled();
    expect(f.controlGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("OMP 네이티브 Goal은 실행 중에도 API 일시정지 티켓을 내고 대화 메시지를 보내지 않는다", async () => {
    const f = await controls("omp");
    f.setDetails({ reading: { state: "active", key: "original-goal", evidence: true, source: "omp", nativeContinuation: true }, objective: "Fixture", revision: "native", tokenBudget: 100, tokensUsed: 4, nativeControls: true });
    f.a.status = "running"; f.a.activeTurn = "turn-1";
    const view = await f.service.readGoalEditor("session");
    expect(view).toMatchObject({ source: "omp", sessionControls: false, action: "pause", actionTicket: expect.any(String), ticket: null });
    expect(await f.service.goalControl("session", true, false, true)).toMatchObject({ nativeAction: "pause", nativeActionReady: true });
    await f.service.actOnGoal({ ticket: view.actionTicket! }); expect(f.controlGoal).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it("네이티브 요청 전 모델 복원이 실패하면 전송 불명 상태로 잠그지 않는다", async () => {
    const f = await controls("omp");
    f.setDetails({ reading: { state: "paused", key: "original-goal", evidence: true, source: "omp" }, objective: "Fixture", revision: "native", tokenBudget: null, tokensUsed: null, nativeControls: true });
    f.controlGoal.mockImplementationOnce(async () => { throw new OmpGoalPreconditionError("The saved OMP model is unavailable."); });
    const view = await f.service.readGoalEditor("session");
    await expect(f.service.actOnGoal({ ticket: view.actionTicket! })).rejects.toThrow(/model is unavailable/);
    expect(f.saved.records.session).toBeUndefined(); expect(f.send).not.toHaveBeenCalled();
  });
  it("예전 OMP 목표 요청은 조회로 실행하지 않고 명시적인 Start 티켓만 낸다", async () => {
    const f = await controls("omp");
    f.setDetails({ reading: { state: "active", key: "original-goal", evidence: true, source: "omp" }, objective: "Fixture", revision: "native", tokenBudget: null, tokensUsed: null, nativeControls: true, nativeStart: true });
    expect(await f.service.readGoalEditor("session")).toMatchObject({ nativeStart: true, action: "resume", actionTicket: expect.any(String), ticket: null });
    expect(await f.service.goalControl("session", true, false, true)).toMatchObject({ nativeAction: "resume", nativeActionReady: true, nativeStart: true });
    expect(f.controlGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    f.a.status = "running"; f.a.activeTurn = "turn-1";
    expect((await f.service.readGoalEditor("session")).actionTicket).toBeNull();
    expect(await f.service.goalControl("session", true, false, true)).toMatchObject({ nativeActionReady: false });
  });
  it("이전 버전에서 선택한 비네이티브 OMP 목표에도 일반 이어가기 메시지를 보내지 않는다", async () => {
    const f = fixture({ continueGoals: true, goalDelaySeconds: 30 }); f.a.provider = "omp"; f.a.sessionId = "native-fixture"; f.idle();
    const reading: GoalReading = { state: "active", key: "request", evidence: true };
    f.setGoal(reading); await f.service.configure(f.settings); await f.service.watchGoal("session", "request");
    f.setGoal({ ...reading, source: "omp" }); f.advance(40_000); await f.service.scanNow();
    expect(f.saved.records.session).toMatchObject({ phase: "review", reason: "goal_unknown" });
    expect(f.send).not.toHaveBeenCalled();
    await expect(f.service.watchGoal("session", "request")).rejects.toThrow(/Start goal/);
  });
  it("느린 네이티브 상태 변경 중에도 Goal 본문과 미리보기를 읽고 중복 제어는 잠근다", async () => {
    const f = await controls(), view = await f.service.readGoalEditor("session");
    const original = f.controlGoal.getMockImplementation()!;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    f.controlGoal.mockImplementationOnce(async (...args) => { entered(); await blocked; return original(...args); });
    const action = f.service.actOnGoal({ ticket: view.actionTicket! }); await started;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const reads = Promise.all([f.service.readGoalEditor("session"), f.service.goalControl("session", true, false, true)]);
      const [editor, preview] = await Promise.race([reads, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("조회가 상태 변경 대기열에서 기다림")), 300); })]);
      expect(editor).toMatchObject({ objective: "Private fixture objective", ticket: null, actionTicket: null });
      expect(preview).toMatchObject({ objective: "Private fixture objective", nativeActionReady: false });
      expect(f.controlGoal).toHaveBeenCalledOnce();
    } finally { clearTimeout(timeout); release(); await action; }
  });
  it("미리보기를 읽는 동안 상태 변경이 시작되면 이전 기록으로 제어를 다시 열지 않는다", async () => {
    const f = await controls(), view = await f.service.readGoalEditor("session");
    let releaseRead!: (value: CodexGoalDetails) => void;
    f.goalDetails.mockImplementationOnce(() => new Promise((resolve) => { releaseRead = resolve; }));
    const preview = f.service.goalControl("session", true, false, true);
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf("function"));
    const original = f.controlGoal.getMockImplementation()!; let releaseAction!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseAction = resolve; });
    f.controlGoal.mockImplementationOnce(async (...args) => { entered(); await blocked; return original(...args); });
    const action = f.service.actOnGoal({ ticket: view.actionTicket! }); await started;
    try {
      releaseRead({ reading: { state: "active", key: "original-goal", evidence: true, source: "codex" }, objective: "Private fixture objective", revision: "native-revision", tokenBudget: 100, tokensUsed: 3 });
      expect(await preview).toMatchObject({ nativeActionReady: false });
      expect(f.controlGoal).toHaveBeenCalledOnce();
    } finally { releaseAction(); await action; }
  });
  it("마운트된 미리보기만 복원 없이 본문을 읽고 수동 조회와 캐시를 구분한다", async () => {
    const f = await controls(), before = f.saved;
    await f.service.goalControl("session"); expect(f.goalDetails).not.toHaveBeenCalled();
    expect(await f.service.goalControl("session", false, false, true)).toMatchObject({ objective: "Private fixture objective", nativeAction: "pause", source: "codex" });
    expect(f.goalDetails).toHaveBeenCalledExactlyOnceWith("session", { allowTimeline: false });
    expect(f.saved).toEqual(before); expect(f.controlGoal).not.toHaveBeenCalled();
    expect(JSON.stringify(f.saved)).not.toContain("Private fixture objective");
  });
  it("여러 화면의 같은 fresh 미리보기는 진행 중인 네이티브 읽기를 공유한다", async () => {
    const f = await controls(); let release!: (value: CodexGoalDetails | null) => void;
    f.goalDetails.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = f.service.goalControl("session", true, false, true);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const second = f.service.goalControl("session", true, false, true);
    expect(second).toBe(first);
    release({ reading: { state: "active", key: "shared", evidence: true, source: "codex" }, objective: "Synthetic", revision: "native", tokenBudget: null, tokensUsed: null });
    await Promise.all([first, second]); expect(f.goalDetails).toHaveBeenCalledOnce(); expect(f.editGoal).not.toHaveBeenCalled();
  });
  it("자동 이어가기가 꺼져 있어도 사용자가 네이티브 Goal을 일시정지할 수 있다", async () => {
    const f = await controls(), view = await f.service.readGoalEditor("session");
    expect(view).toMatchObject({ action: "pause", actionTicket: expect.any(String), key: "original-goal" });
    await f.service.actOnGoal({ ticket: view.actionTicket! });
    expect(f.controlGoal).toHaveBeenCalledOnce(); expect(f.saved.records.session.goal).toMatchObject({ state: "paused", selectedKey: null });
    f.advance(120_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    expect(JSON.stringify(f.saved)).not.toContain(view.actionTicket!); expect(JSON.stringify(f.saved)).not.toContain("Private fixture objective");
  });
  it("재개는 네이티브 Goal만 재개하며 Paseo 추가 이어가기를 선택하지 않는다", async () => {
    const f = await controls("codex", "paused"), view = await f.service.readGoalEditor("session");
    expect(view.action).toBe("resume"); await f.service.actOnGoal({ ticket: view.actionTicket! });
    expect(f.saved.records.session.goal).toMatchObject({ state: "active", selectedKey: null }); expect(f.send).not.toHaveBeenCalled();
    await expect(f.service.actOnGoal({ ticket: view.actionTicket! })).rejects.toThrow(/expired/); expect(f.controlGoal).toHaveBeenCalledOnce();
  });
  it("명시적인 OpenCode 재개만 새 예산 창을 승인한다", async () => {
    const f = await controls("opencode", "paused"), first = await f.service.readGoalEditor("session");
    expect(first.actionNote).toContain("budget window");
    await expect(f.service.actOnGoal({ ticket: first.actionTicket! })).rejects.toThrow(/confirm/); expect(f.controlGoal).not.toHaveBeenCalled();
    const view = await f.service.readGoalEditor("session"); await f.service.actOnGoal({ ticket: view.actionTicket!, confirmBudgetReset: true });
    expect(f.controlGoal).toHaveBeenCalledOnce();
  });
  it.each(["codex", "opencode"] as const)("%s 수동 제어는 사용량이나 네이티브 limited 상태만으로 잠그지 않는다", async (source) => {
    const f = await controls(source, "limited");
    f.setDetails({ reading: { state: "limited", key: "original-goal", evidence: true, source }, objective: "Fixture", revision: "native", tokenBudget: 100, tokensUsed: 934916 });
    const view = await f.service.readGoalEditor("session");
    expect(view).toMatchObject({ ticket: expect.any(String), action: "resume", actionTicket: expect.any(String) });
    expect(await f.service.goalControl("session", true, false, true)).toMatchObject({ nativeAction: "resume", nativeActionReady: true });
    expect(f.controlGoal).not.toHaveBeenCalled(); expect(f.editGoal).not.toHaveBeenCalled();
  });
  it("OpenCode 턴 실행 중에도 제어를 숨기지 않고 사용할 수 없는 상태로 표시한다", async () => {
    const f = await controls("opencode"); f.a.status = "running"; f.a.activeTurn = "current";
    expect(await f.service.goalControl("session", true, false, true)).toMatchObject({ nativeAction: "pause", nativeActionReady: false });
    expect(await f.service.readGoalEditor("session")).toMatchObject({ ticket: null, action: "pause", actionTicket: null, note: expect.stringContaining("current turn") });
    expect(f.controlGoal).not.toHaveBeenCalled();
  });
  it.each(["claude", "timeline"] as const)("%s의 미지원 pause/resume 티켓을 발행하지 않는다", async (source) => {
    const f = await controls(); f.setDetails({ reading: { state: "active", key: "original-goal", evidence: true, source }, objective: "Fixture", revision: "native", tokenBudget: null, tokensUsed: null });
    const view = await f.service.readGoalEditor("session"); expect(view.objective).toBe("Fixture"); expect(view.actionTicket).toBeNull();
    if (source === "timeline") expect(view.ticket).toBeNull();
    expect(f.controlGoal).not.toHaveBeenCalled();
  });
  it.each(["claude", "omp"] as const)("%s 목표의 Pause와 Resume은 실행 상태를 따르고 읽기만으로 작업을 시작하지 않는다", async (source) => {
    const f = await controls(); f.a.provider = source;
    f.setDetails({ reading: { state: "active", key: "original-goal", evidence: true, source }, objective: "Fixture", revision: "native", tokenBudget: null, tokensUsed: null, sessionControls: true });
    let view = await f.service.readGoalEditor("session");
    expect(view).toMatchObject({ source, sessionControls: true, action: "resume", actionTicket: expect.any(String) });
    expect(await f.service.goalControl("session", true, false, true)).toMatchObject({ source, nativeAction: "resume", nativeActionReady: true });
    f.a.status = "running"; f.a.activeTurn = "current";
    view = await f.service.readGoalEditor("session");
    expect(view).toMatchObject({ action: "pause", actionTicket: expect.any(String), ticket: null });
    expect(await f.service.goalControl("session", true, false, true)).toMatchObject({ nativeAction: "pause", nativeActionReady: true });
    expect(f.controlGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.saved.records).toEqual({});
  });
  it("Claude의 실제 중지 이벤트를 확인하고 자동 복구나 추가 이어가기로 다시 켜지 않는다", async () => {
    const f = await controls("claude"); f.a.status = "running"; f.a.activeTurn = "current";
    const reading: GoalReading = { state: "active", key: "original-goal", evidence: true, source: "claude", nativeContinuation: true };
    f.setDetails({ reading, objective: "Fixture", revision: "native", tokenBudget: null, tokensUsed: null, sessionControls: true });
    const view = await f.service.readGoalEditor("session"); let canceled: Promise<void> | undefined;
    f.controlGoal.mockImplementationOnce(async (_id, _revision, _action, _expected, check, _messageId, submitted) => {
      check(); submitted(); f.idle(); canceled = f.event({ kind: "end", turnId: "current", outcome: { kind: "canceled", reason: "Interrupted" } } as Omit<RecoveryEvent, "agent">); check(); return reading;
    });
    await f.service.actOnGoal({ ticket: view.actionTicket! }); await canceled;
    expect(f.saved.records.session).toMatchObject({ phase: "stopped", reason: "user_stop", goal: { selectedKey: null } });
    f.advance(120_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    expect((await f.service.readGoalEditor("session")).action).toBe("resume");
  });
  it("휴면 Claude 세션은 읽기 중 복원하지 않고 명시적인 Resume 제어만 제공한다", async () => {
    const f = await controls("claude"); f.a.status = "closed"; f.a.activeTurn = undefined;
    f.setDetails({ reading: { state: "active", key: "original-goal", evidence: true, source: "claude" }, objective: "Fixture", revision: "native", tokenBudget: null, tokensUsed: null, sessionControls: true });
    expect(await f.service.readGoalEditor("session")).toMatchObject({ action: "resume", actionTicket: expect.any(String) });
    expect(await f.service.goalControl("session", true, false, true)).toMatchObject({ nativeAction: "resume", nativeActionReady: true });
    expect(f.controlGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.supportsGoalCommand).not.toHaveBeenCalled();
  });
  it("새 턴, 만료, 설정 변경 또는 대기 중 승인이 이전 제어를 막는다", async () => {
    for (const mode of ["start", "expire", "settings", "permission"]) {
      const f = await controls(), view = await f.service.readGoalEditor("session");
      if (mode === "start") await f.event({ kind: "start", turnId: "different" } as Omit<RecoveryEvent, "agent">);
      if (mode === "expire") f.advance(300_000);
      if (mode === "settings") await f.service.configure(f.settings);
      if (mode === "permission") await f.event({ kind: "permission", requestId: "approval" } as Omit<RecoveryEvent, "agent">);
      await expect(f.service.actOnGoal({ ticket: view.actionTicket! })).rejects.toThrow(); expect(f.controlGoal).not.toHaveBeenCalled();
    }
  });
  it("전송 의도를 디스크에 먼저 저장하고 불확실한 제어는 재시작 후에도 재전송하지 않는다", async () => {
    const f = await controls(), view = await f.service.readGoalEditor("session");
    f.controlGoal.mockImplementationOnce(async (_id, _revision, _action, _expected, guard, _messageId, submitted) => {
      guard(); expect(f.saved.records.session.phase).toBe("sending"); submitted(); throw new Error("Receipt lost");
    });
    await expect(f.service.actOnGoal({ ticket: view.actionTicket! })).rejects.toThrow("Receipt lost");
    expect(f.saved.records.session.reason).toBe("uncertain_send"); await f.restart(); f.advance(60_000); await f.service.scanNow();
    expect((await f.service.readGoalEditor("session")).actionTicket).toBeNull(); expect(f.controlGoal).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it("제출 전 거부된 제어는 기존 기록을 복원한다", async () => {
    const f = await controls(), before = f.saved, view = await f.service.readGoalEditor("session");
    f.controlGoal.mockRejectedValueOnce(new Error("Changed before submission"));
    await expect(f.service.actOnGoal({ ticket: view.actionTicket! })).rejects.toThrow(); expect(f.saved).toEqual(before);
  });
  it("네이티브 일시정지는 별도로 관찰하던 중단 복구 기록을 지우지 않는다", async () => {
    const f = await controls();
    await f.event({ kind: "start", turnId: "interruption" } as Omit<RecoveryEvent, "agent">);
    await f.event({ kind: "end", turnId: "interruption", outcome: { kind: "failed", error: { code: "ECONNRESET" } } } as Omit<RecoveryEvent, "agent">);
    const previous = f.saved.records.session, view = await f.service.readGoalEditor("session");
    await f.service.actOnGoal({ ticket: view.actionTicket! });
    expect(f.saved.records.session).toMatchObject({ phase: previous.phase, reason: previous.reason, attempts: previous.attempts, goal: { state: "paused", selectedKey: null } });
  });
});
describe("명시적인 Goal 편집", () => {
  async function editor() {
    const f = fixture({ continueGoals: true }); f.a.sessionId = "native-fixture"; f.idle();
    const reading: GoalReading = { state: "active", key: "original-goal", evidence: true, source: "codex" };
    f.setGoal(reading); f.setDetails({ reading, objective: "Original fixture", revision: "native-revision", tokenBudget: 100, tokensUsed: 3 });
    await f.service.configure(f.settings); return f;
  }
  it("편집창을 볼 때만 본문을 읽고 본문이나 수정 티켓을 디스크에 저장하지 않는다", async () => {
    const f = await editor(), before = f.saved;
    await f.service.goalControl("session"); expect(f.goalDetails).not.toHaveBeenCalled();
    expect(await f.service.readGoalEditor("session")).toMatchObject({ supported: true, objective: "Original fixture", ticket: expect.any(String) });
    expect(f.goalDetails).toHaveBeenCalledExactlyOnceWith("session", { allowTimeline: false }); expect(f.saved).toEqual(before);
    expect(f.supportsGoalCommand).not.toHaveBeenCalled();
    expect(f.editGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("같은 편집창의 동시 조회는 한 번만 읽고 명령 목록이나 대화를 복원하지 않는다", async () => {
    const f = await editor();
    const first = f.service.readGoalEditor("session"), second = f.service.readGoalEditor("session");
    expect(first).toBe(second); await first;
    expect(f.goalDetails).toHaveBeenCalledExactlyOnceWith("session", { allowTimeline: false });
    expect(f.supportsGoalCommand).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("조회 중 네이티브 Goal의 다음 턴이 시작돼도 본문을 보여주고 최신 턴으로 티켓을 발행한다", async () => {
    const f = await editor();
    f.goalDetails.mockImplementationOnce(async () => {
      f.a.status = "running"; f.a.activeTurn = "native-next-turn";
      await f.event({ kind: "start", turnId: "native-next-turn" } as Omit<RecoveryEvent, "agent">);
      return { reading: { state: "active", key: "original-goal", evidence: true, source: "codex" }, objective: "Original fixture", revision: "native-revision", tokenBudget: 100, tokensUsed: 3 };
    });
    const view = await f.service.readGoalEditor("session"); expect(view).toMatchObject({ objective: "Original fixture", ticket: expect.any(String), actionTicket: expect.any(String) });
    await f.service.editGoal({ ticket: view.ticket!, objective: "Edited fixture" }); expect(f.editGoal.mock.calls[0][3].activeTurn).toBe("native-next-turn");
  });
  it.each(["stop", "permission", "message"])("조회 도중 %s가 오면 본문은 읽기 전용으로 보여주고 오류나 수정 권한을 만들지 않는다", async (change) => {
    const f = await editor();
    f.goalDetails.mockImplementationOnce(async () => {
      if (change === "stop") await f.event({ kind: "end", turnId: null, outcome: { kind: "canceled", reason: "user_stop" } } as Omit<RecoveryEvent, "agent">);
      if (change === "permission") await f.event({ kind: "permission", requestId: "approval" } as Omit<RecoveryEvent, "agent">);
      if (change === "message") { f.a.lastUserMessageAt = new Date(epoch + 1).toISOString(); await f.event({ kind: "start", turnId: "user-turn" } as Omit<RecoveryEvent, "agent">); }
      return { reading: { state: "active", key: "original-goal", evidence: true, source: "codex" }, objective: "Original fixture", revision: "native-revision", tokenBudget: 100, tokensUsed: 3 };
    });
    expect(await f.service.readGoalEditor("session")).toMatchObject({ objective: "Original fixture", ticket: null, actionTicket: null });
    expect(f.editGoal).not.toHaveBeenCalled(); expect(f.controlGoal).not.toHaveBeenCalled();
  });
  it("새 목표를 자동 선택하지 않고 이전 목표의 예약된 진행을 취소한다", async () => {
    const f = await editor(); await f.service.watchGoal("session");
    const view = await f.service.readGoalEditor("session");
    await f.service.editGoal({ ticket: view.ticket!, objective: "Edited fixture" });
    expect(f.editGoal).toHaveBeenCalledOnce(); expect(f.saved.records.session.goal).toMatchObject({ key: "edited-goal", selectedKey: null, attempts: 0 });
    expect(f.saved.records.session.phase).toBe("completed"); f.advance(120_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    expect(JSON.stringify(f.saved)).not.toContain("Edited fixture"); expect(JSON.stringify(f.saved)).not.toContain(view.ticket!);
  });
  it("다른 클라이언트가 편집기를 읽어도 기존 편집 티켓은 유효하다", async () => {
    const f = await editor(), first = await f.service.readGoalEditor("session"), second = await f.service.readGoalEditor("session");
    expect(first.ticket).not.toBe(second.ticket);
    await f.service.editGoal({ ticket: first.ticket!, objective: "Edited fixture" });
    await expect(f.service.editGoal({ ticket: second.ticket!, objective: "Other edit" })).rejects.toThrow(/session changed/);
    expect(f.editGoal).toHaveBeenCalledOnce();
  });
  it("명시적인 저장으로 Codex의 자체 Goal 턴이 시작돼도 중복 진행을 보내지 않는다", async () => {
    const f = await editor(); await f.service.watchGoal("session"); const view = await f.service.readGoalEditor("session");
    let started!: Promise<void>;
    f.editGoal.mockImplementationOnce(async (_id, _revision, _objective, _expected, guard, _messageId, submitted) => {
      guard(); submitted(); f.a.status = "running"; f.a.activeTurn = "native-goal-turn";
      started = f.event({ kind: "start", turnId: "native-goal-turn" } as Omit<RecoveryEvent, "agent">); guard();
      return { state: "active", key: "edited-goal", evidence: true, source: "codex" };
    });
    await expect(f.service.editGoal({ ticket: view.ticket!, objective: "Edited fixture" })).resolves.toEqual({ ok: true });
    await started; expect(f.saved.records.session.goal?.selectedKey).toBeNull(); expect(f.send).not.toHaveBeenCalled();
  });
  it("설정 변경과 만료 후에는 이전 편집을 제출하지 않는다", async () => {
    const f = await editor(); let view = await f.service.readGoalEditor("session"); f.advance(300_000);
    await expect(f.service.editGoal({ ticket: view.ticket!, objective: "Edited fixture" })).rejects.toThrow(/expired/);
    view = await f.service.readGoalEditor("session"); await f.service.configure(f.settings);
    await expect(f.service.editGoal({ ticket: view.ticket!, objective: "Edited fixture" })).rejects.toThrow(/expired/);
    expect(f.editGoal).not.toHaveBeenCalled();
  });
  it("새 턴이나 사용자 중지가 오면 오래된 편집을 제출하지 않는다", async () => {
    const f = await editor(), view = await f.service.readGoalEditor("session");
    await f.event({ kind: "start", turnId: "new-turn" } as Omit<RecoveryEvent, "agent">);
    await expect(f.service.editGoal({ ticket: view.ticket!, objective: "Edited fixture" })).rejects.toThrow(/session changed/);
    expect(f.editGoal).not.toHaveBeenCalled();
  });
  it("제출 이후 확인되지 않은 편집은 선택을 해제하고 자동 재전송하지 않는다", async () => {
    const f = await editor(); await f.service.watchGoal("session"); const view = await f.service.readGoalEditor("session");
    f.editGoal.mockImplementationOnce(async (_id, _revision, _objective, _expected, guard, _messageId, submitted) => { guard(); submitted(); throw new Error("Receipt lost"); });
    await expect(f.service.editGoal({ ticket: view.ticket!, objective: "Edited fixture" })).rejects.toThrow("Receipt lost");
    await expect(f.service.editGoal({ ticket: view.ticket!, objective: "Edited fixture" })).rejects.toThrow(/expired/);
    expect(f.saved.records.session.goal?.selectedKey).toBeNull(); expect(f.saved.records.session.reason).toBe("uncertain_send");
    f.advance(120_000); await f.service.scanNow(); expect(f.editGoal).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it("다른 제공자에서는 본문을 복원하거나 변경하지 않는다", async () => {
    const f = await editor(); f.a.provider = "omp"; f.setDetails(null);
    expect(await f.service.readGoalEditor("session")).toMatchObject({ supported: false, ticket: null });
    expect(f.goal).not.toHaveBeenCalled(); expect(f.editGoal).not.toHaveBeenCalled();
  });
  it.each(["opencode", "claude"] as const)("%s의 확인된 네이티브 목표만 편집하며 턴 실행 중에는 기다린다", async (source) => {
    const f = await editor(); f.a.provider = source;
    const reading: GoalReading = { state: "active", key: "provider-goal", evidence: true, source };
    f.setDetails({ reading, objective: "Original fixture", revision: "provider-revision", tokenBudget: source === "claude" ? null : 100, tokensUsed: null });
    let view = await f.service.readGoalEditor("session");
    expect(view).toMatchObject({ supported: true, source, objective: "Original fixture", ticket: expect.any(String) });
    expect(f.supportsGoalCommand).not.toHaveBeenCalled();
    expect(view.note).toContain(source === "claude" ? "resets its goal timer" : "preserves turn/token/time budgets");
    f.a.status = "running"; f.a.activeTurn = "current-turn";
    view = await f.service.readGoalEditor("session"); expect(view.ticket).toBeNull(); expect(view.note).toContain("Wait");
    expect(f.editGoal).not.toHaveBeenCalled();
  });
  it("승인을 기다리거나 완료된 Goal은 읽기 전용이다", async () => {
    const f = await editor(); f.a.pendingPermissions = 1;
    expect(await f.service.readGoalEditor("session")).toMatchObject({ ticket: null, objective: "Original fixture" });
    f.a.pendingPermissions = 0; f.setDetails({ reading: { state: "complete", key: "original-goal", evidence: true, source: "codex" }, objective: "Original fixture", revision: "native-revision", tokenBudget: 100, tokensUsed: 100 });
    expect(await f.service.readGoalEditor("session")).toMatchObject({ ticket: null, state: "complete" });
    expect(f.editGoal).not.toHaveBeenCalled();
  });
});
describe("goal composer inspection", () => {
  const active: GoalReading = { state: "active", key: "current-goal", evidence: true };
  it.each(["omp", "claude"])("%s Goal 화면에서만 기록을 검사하고 선택이나 실행을 하지 않는다", async (provider) => {
    const f = fixture(); f.a.provider = provider; f.idle(); await f.service.configure(f.settings);
    f.goal.mockImplementation(async (_id, options) => options?.allowTimeline ? active : { state: "unknown", key: null, evidence: false, source: "timeline" });
    expect(await f.service.goalControl("session")).toMatchObject({ visible: false });
    const before = f.saved;
    expect(await f.service.goalControl("session", true, true)).toMatchObject({ visible: true, key: active.key, selected: false, canSelect: true });
    expect(f.goal).toHaveBeenLastCalledWith("session", { allowTimeline: true });
    expect(f.saved).toEqual(before); expect(f.send).not.toHaveBeenCalled(); expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.editGoal).not.toHaveBeenCalled();
  });
  it("수동 새로고침을 포함한 표시 조회는 대화 복원을 요청하지 않는다", async () => {
    const f = fixture(); await f.service.configure(f.settings);
    await f.service.goalControl("session"); await f.service.goalControl("session", true);
    expect(f.goal).toHaveBeenCalledTimes(2);
    expect(f.goal.mock.calls.every(([, options]) => options?.allowTimeline === false)).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("여러 클라이언트의 같은 대화 조회를 공유한다", async () => {
    const f = fixture(); await f.service.configure(f.settings);
    let release!: (reading: GoalReading) => void;
    f.goal.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = f.service.goalControl("session");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const second = f.service.goalControl("session");
    release(active);
    expect(await second).toEqual(await first);
    expect(f.goal).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("Goal이 없는 대화의 결과를 캐시하고 직접 조회 시 갱신한다", async () => {
    const f = fixture(); await f.service.configure(f.settings);
    await f.service.goalControl("session");
    f.advance(299_999); f.setGoal(active);
    expect(await f.service.goalControl("session")).toMatchObject({ visible: false });
    expect(f.goal).toHaveBeenCalledOnce();
    expect(await f.service.goalControl("session", true)).toMatchObject({ visible: true, key: active.key });
    expect(f.goal).toHaveBeenCalledTimes(2);
  });
  it("선택된 OMP Goal을 배경에서 복원하지 않고 현재 상태가 미확인이면 전송을 보류한다", async () => {
    const f = fixture({ continueGoals: true }); f.a.provider = "omp"; f.idle(); f.setGoal(active);
    await f.service.configure(f.settings); await f.service.watchGoal("session");
    f.goal.mockImplementation(async (_id, options) => options?.allowTimeline === false ? { state: "unknown", key: null, evidence: false, source: "timeline" } : active);
    expect(await f.service.goalControl("session")).toMatchObject({ visible: true, state: "active", selected: true, canSelect: false, note: expect.stringContaining("last checked") });
    f.goal.mockClear(); f.advance(60_000); await f.service.scanNow();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.goal).toHaveBeenCalledWith("session", { allowTimeline: false, inspectOmp: true });
    expect(f.saved.records.session.goal?.selectedKey).toBe(active.key);
    expect(f.saved.records.session.reason).toBe("goal_unknown");
  });
  it("does not show a pill or track a session without goal evidence", async () => {
    const f = fixture(); await f.service.configure(f.settings);
    expect(await f.service.goalControl("session")).toMatchObject({ visible: false, selected: false, canSelect: false });
    expect(f.saved.records).toEqual({}); expect(holdIds(f.saved)).toEqual([]); expect(f.send).not.toHaveBeenCalled();
  });
  it("finds a goal on an existing session without selecting, scheduling, or persisting it", async () => {
    const f = fixture(); f.idle(); f.setGoal(active); await f.service.configure(f.settings); const before = f.saved;
    expect(await f.service.goalControl("session")).toMatchObject({ visible: true, selected: false, canSelect: true, automatic: false, key: active.key });
    expect(f.saved).toEqual(before); expect(f.send).not.toHaveBeenCalled(); expect(f.fetch.mock.calls.every(([id]) => id === "session")).toBe(true);
  });
  it("identifies a raced goal lookup so the client can inspect the stable state again", async () => {
    const f = fixture(); f.idle(); f.setGoal(active); await f.service.configure(f.settings);
    let release!: (reading: GoalReading) => void;
    f.goal.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.service.goalControl("session", true);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.a.status = "running"; f.a.activeTurn = "next-turn";
    await f.event({ kind: "start", turnId: "next-turn" } as Omit<RecoveryEvent, "agent">);
    release(active);
    expect(await pending).toMatchObject({ visible: false, canSelect: false, state: null, note: expect.stringContaining("session changed") });
    expect(await f.service.goalControl("session", true)).toMatchObject({ visible: true, canSelect: true, state: "active" });
    expect(f.send).not.toHaveBeenCalled(); expect(f.resumeBlockedGoal).not.toHaveBeenCalled();
  });
  it.each(["complete", "cleared"] as const)("hides the pill for a %s goal", async (state) => {
    const f = fixture(); f.setGoal(active); f.idle(); await f.service.configure(f.settings); await f.service.watchGoal("session");
    f.setGoal({ ...active, state }); expect(await f.service.goalControl("session", true)).toMatchObject({ visible: false, selected: false, canSelect: false });
  });
  it.each(["paused", "blocked", "limited"] as const)("allows selecting a %s goal without continuing it", async (state) => {
    const f = fixture(); f.idle(); f.setGoal({ ...active, state }); await f.service.configure(f.settings);
    expect(await f.service.goalControl("session")).toMatchObject({ visible: true, selected: false, canSelect: true, state });
    await f.service.watchGoal("session", active.key!);
    expect(await f.service.goalControl("session")).toMatchObject({ selected: true, state });
    await f.service.configure({ ...f.settings, continueGoals: true }); f.advance(60_000); await f.service.scanNow();
    expect(f.send).not.toHaveBeenCalled();
    await f.service.unwatchGoal("session"); expect(await f.service.goalControl("session")).toMatchObject({ selected: false });
  });
  it("continues a selected blocked goal only after a later turn makes it active", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked" }); await f.service.configure(f.settings);
    await f.service.watchGoal("session", active.key!); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("goal_blocked"); expect(f.send).not.toHaveBeenCalled();
    f.setGoal(active); f.a.status = "running"; f.a.activeTurn = "turn-2";
    await f.event({ kind: "start", turnId: "turn-2" } as Omit<RecoveryEvent, "agent">);
    f.idle(); await f.event({ kind: "end", turnId: "turn-2", outcome: { kind: "completed" } } as Omit<RecoveryEvent, "agent">);
    await f.service.scanNow(); expect(f.saved.records.session.reason).toBe("goal_active");
    f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("resumes a blocked Codex goal only when the user explicitly enables that behavior", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.service.configure(f.settings);
    await f.service.watchGoal("session", active.key!);
    expect(f.resumeBlockedGoal).not.toHaveBeenCalled();
    await f.service.unwatchGoal("session"); await f.service.watchGoal("session", active.key!, false, true);
    expect(f.resumeBlockedGoal).toHaveBeenCalledOnce();
    expect(f.saved.records.session).toMatchObject({ phase: "scheduled", reason: "goal_active", goal: { selectedKey: active.key, state: "active", attempts: 0 } });
    f.advance(59_999); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    f.advance(1); await f.service.scanNow(); expect(f.send).toHaveBeenCalledOnce();
    expect(f.saved.records.session.goal?.attempts).toBe(1);
  });
  it("accepts a blocked-goal toggle during a running turn and waits for that turn to finish", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.track();
    await f.service.watchGoal("session", active.key!, false, true);
    expect(f.resumeBlockedGoal).toHaveBeenCalledOnce();
    expect(f.saved.records.session).toMatchObject({ phase: "watching", reason: "active", turnId: "turn-1", goal: { state: "active", selectedKey: active.key } });
    f.advance(60_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    f.idle(); await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "completed" } } as Omit<RecoveryEvent, "agent">);
    await f.service.scanNow(); f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("does not send or persist a resume command when the session did not advertise native goal support", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.service.configure(f.settings);
    f.supportsGoalCommand.mockResolvedValue(false);
    await expect(f.service.watchGoal("session", active.key!, false, true)).rejects.toThrow(/not enabled/);
    expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.saved.records).toEqual({});
  });
  it("accepts Codex's own turn starting after the native resume command is submitted", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.service.configure(f.settings);
    let started!: Promise<void>;
    f.resumeBlockedGoal.mockImplementationOnce(async (_id, _key, _expected, check, _messageId, submitted) => {
      check(); submitted?.(); f.setGoal({ ...active, source: "codex" }); f.a.status = "running"; f.a.activeTurn = "native-goal-turn";
      started = f.event({ kind: "start", turnId: "native-goal-turn" } as Omit<RecoveryEvent, "agent">);
      check(); return { ...active, source: "codex" };
    });
    await f.service.watchGoal("session", active.key!, false, true); await started;
    expect(f.saved.records.session).toMatchObject({ phase: "watching", reason: "active", goal: { state: "active", selectedKey: active.key, attempts: 0 } });
    f.advance(60_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    f.idle(); await f.event({ kind: "end", turnId: "native-goal-turn", outcome: { kind: "completed" } } as Omit<RecoveryEvent, "agent">);
    await f.service.scanNow(); f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledOnce();
  });
  it.each(["stop", "permission", "unwatch"] as const)("still honors a %s after a native goal turn starts", async (block) => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.service.configure(f.settings);
    const pending: Array<Promise<unknown>> = [];
    f.resumeBlockedGoal.mockImplementationOnce(async (_id, _key, _expected, check, _messageId, submitted) => {
      check(); submitted?.(); f.setGoal({ ...active, source: "codex" }); f.a.status = "running"; f.a.activeTurn = "native-goal-turn";
      pending.push(f.event({ kind: "start", turnId: "native-goal-turn" } as Omit<RecoveryEvent, "agent">));
      if (block === "stop") { f.idle(); pending.push(f.event({ kind: "end", turnId: "native-goal-turn", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">)); }
      else if (block === "permission") { f.a.pendingPermissions = 1; pending.push(f.event({ kind: "permission", requestId: "approval" } as Omit<RecoveryEvent, "agent">)); }
      else pending.push(f.service.unwatchGoal("session"));
      check(); return { ...active, source: "codex" };
    });
    await expect(f.service.watchGoal("session", active.key!, false, true)).rejects.toThrow(/changed/); await Promise.all(pending);
    f.advance(60_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled(); expect(f.resumeBlockedGoal).toHaveBeenCalledOnce();
    if (block === "stop") expect(f.saved.records.session.reason).toBe("user_stop");
    if (block === "permission") expect(f.saved.records.session.humanRequired).toBe(true);
    if (block === "unwatch") expect(f.saved.records.session.goal?.selectedKey).toBeNull();
  });
  it.each(["starting", "no-history"])("waits for %s session metadata before changing a goal", async (state) => {
    const f = fixture({ continueGoals: true }); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.track();
    if (state === "starting") f.a.status = "initializing";
    if (state === "no-history") f.a.persistence = false;
    await expect(f.service.watchGoal("session", active.key!, false, true)).rejects.toThrow(/ready/);
    expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("allows the native command with an omitted turn ID but still blocks an unverifiable continuation", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.track(); f.a.activeTurn = undefined;
    await f.service.watchGoal("session", active.key!, false, true); expect(f.resumeBlockedGoal).toHaveBeenCalledOnce();
    f.a.status = "idle"; await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "completed" } } as Omit<RecoveryEvent, "agent">);
    await f.service.scanNow(); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("unknown_state"); expect(f.send).not.toHaveBeenCalled();
  });
  it("replaces an old observation gap after an explicit blocked-goal resume", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.track(); f.idle(); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("unknown_end");
    await f.service.watchGoal("session", active.key!, false, true);
    expect(f.saved.records.session.reason).toBe("goal_active");
    f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("persists the resume-command intent and follows its updated conversation timestamp", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.service.configure(f.settings);
    f.resumeBlockedGoal.mockImplementationOnce(async (_id, key, _expected, check) => {
      expect(f.saved.records.session).toMatchObject({ phase: "sending", reason: "goal_blocked", attemptMessageId: expect.stringMatching(/^session-recovery-goal-/) });
      check(); f.a.lastUserMessageAt = new Date(epoch + 1).toISOString(); f.setGoal({ ...active, source: "codex" });
      return { ...active, key, source: "codex" };
    });
    await f.service.watchGoal("session", active.key!, false, true);
    expect(f.saved.records.session.messageAt).toBe(f.a.lastUserMessageAt);
    f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("keeps an unconfirmed native resume command in review without replaying it", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.service.configure(f.settings);
    f.resumeBlockedGoal.mockImplementationOnce(async (_id, _key, _expected, _check, _messageId, submitted) => { submitted?.(); throw new Error("Receipt lost"); });
    await expect(f.service.watchGoal("session", active.key!, false, true)).rejects.toThrow("Receipt lost");
    expect(f.saved.records.session.reason).toBe("uncertain_send");
    await f.restart("boot-a"); f.advance(60_000); await f.service.scanNow();
    expect(f.resumeBlockedGoal).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it("removes an unsent native goal intent and allows an explicit retry", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.service.configure(f.settings);
    f.resumeBlockedGoal.mockRejectedValueOnce(new RecoveryError("Preflight changed"));
    await expect(f.service.watchGoal("session", active.key!, false, true)).rejects.toThrow("Preflight changed");
    expect(f.saved.records.session).toBeUndefined(); expect(f.saved.history.some((h) => h.reason === "uncertain_send")).toBe(false);
    expect(await f.service.goalControl("session", true)).toMatchObject({ selected: false, canSelect: true });
    await f.service.watchGoal("session", active.key!, false, true); expect(f.resumeBlockedGoal).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("restores the previous goal record after an unsent command, previously selected: %s", async (selected) => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.service.configure(f.settings);
    await f.service.watchGoal("session", active.key!); if (!selected) await f.service.unwatchGoal("session");
    const saved = f.saved; saved.records.session.attempts = 2; saved.records.session.goal!.attempts = 1; f.setSaved(saved); await f.restart("boot-a");
    const before = f.saved.records.session;
    f.resumeBlockedGoal.mockRejectedValueOnce(new RecoveryError("Preflight changed"));
    await expect(f.service.watchGoal("session", active.key!, true, true)).rejects.toThrow("Preflight changed");
    expect(f.saved.records.session).toEqual(before);
  });
  it.each(["stop", "permission", "unwatch"] as const)("preserves a queued %s after an unsent first goal toggle", async (block) => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.service.configure(f.settings);
    let pending!: Promise<unknown>;
    f.resumeBlockedGoal.mockImplementationOnce(async (_id, _key, _expected, check) => {
      if (block === "stop") pending = f.event({ kind: "end", turnId: "fixture-turn", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
      else if (block === "permission") { f.a.pendingPermissions = 1; pending = f.event({ kind: "permission", requestId: "approval" } as Omit<RecoveryEvent, "agent">); }
      else pending = f.service.unwatchGoal("session");
      check(); throw new Error("Expected guard failure");
    });
    await expect(f.service.watchGoal("session", active.key!, false, true)).rejects.toThrow(/changed/); await pending;
    expect(f.saved.records.session.attemptMessageId).toBeNull(); expect(f.saved.records.session.reason).not.toBe("uncertain_send");
    if (block === "stop") expect(f.saved.records.session.reason).toBe("user_stop");
    if (block === "permission") expect(f.saved.records.session).toMatchObject({ humanRequired: true, pendingIds: ["approval"] });
    expect(f.saved.records.session.goal?.selectedKey).toBeNull();
    f.advance(60_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["stop", "permission", "unwatch"] as const)("preserves a queued %s after an unsent goal toggle with a closed previous record", async (block) => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.service.configure(f.settings);
    await f.service.watchGoal("session", active.key!); await f.service.unwatchGoal("session");
    const saved = f.saved; saved.records.session.turnId = "previous-turn"; saved.records.session.attempts = 2; saved.records.session.goal!.attempts = 1;
    f.setSaved(saved); await f.restart("boot-a");
    let pending!: Promise<unknown>;
    f.resumeBlockedGoal.mockImplementationOnce(async (_id, _key, _expected, check) => {
      if (block === "stop") pending = f.event({ kind: "end", turnId: "current-turn", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
      else if (block === "permission") { f.a.pendingPermissions = 1; pending = f.event({ kind: "permission", requestId: "approval" } as Omit<RecoveryEvent, "agent">); }
      else pending = f.service.unwatchGoal("session");
      check(); throw new Error("Expected guard failure");
    });
    await expect(f.service.watchGoal("session", active.key!, true, true)).rejects.toThrow(/changed/); await pending;
    expect(f.saved.records.session).toMatchObject({ attemptMessageId: null, attempts: 2, goal: { attempts: 1, selectedKey: null } });
    if (block === "stop") expect(f.saved.records.session.reason).toBe("user_stop");
    if (block === "permission") expect(f.saved.records.session).toMatchObject({ humanRequired: true, pendingIds: ["approval"] });
    f.advance(60_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["paused", "limited", "unknown"] as const)("does not reactivate a native %s goal from the toggle", async (state) => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, source: "codex", state }); await f.service.configure(f.settings);
    await f.service.watchGoal("session", active.key!, false, true); f.advance(60_000); await f.service.scanNow();
    expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("keeps OpenCode's blocked goal under its native control", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state: "blocked", source: "opencode" }); await f.service.configure(f.settings);
    await f.service.watchGoal("session", active.key!, false, true);
    expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.saved.records.session.reason).toBe("goal_blocked");
  });
  it.each(["input", "stop", "limit", "disabled", "workspace"])("does not reactivate a blocked goal past a %s guard", async (block) => {
    const f = fixture({ continueGoals: true, goalMaxAttempts: 1 }); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.track(); f.idle();
    if (block === "input") await f.event({ kind: "permission", requestId: "approval" } as Omit<RecoveryEvent, "agent">);
    if (block === "stop") await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
    if (block === "limit") { const saved = f.saved; saved.records.session.goal = { ...active, selectedKey: active.key, attempts: 1 }; f.setSaved(saved); await f.restart(); }
    if (block === "disabled") await f.service.configure({ ...f.settings, continueGoals: false });
    if (block === "workspace") f.workspace.archiving = true;
    await expect(f.service.watchGoal("session", active.key!, false, true)).rejects.toThrow();
    expect(f.resumeBlockedGoal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("cancels native reactivation if a stop arrives during its final check", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal({ ...active, state: "blocked", source: "codex" }); await f.track(); f.idle();
    let stop!: Promise<void>;
    f.resumeBlockedGoal.mockImplementationOnce(async (_id, _key, _expected, check) => {
      stop = f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
      check(); return active;
    });
    await expect(f.service.watchGoal("session", active.key!, false, true)).rejects.toThrow(/changed/); await stop;
    expect(f.saved.records.session.reason).toBe("user_stop"); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["blocked", "paused", "limited", "unknown"] as const)("notices when a selected %s goal becomes active without a new turn", async (state) => {
    const f = fixture({ continueGoals: true }); f.idle(); f.setGoal({ ...active, state }); await f.service.configure(f.settings); await f.service.watchGoal("session");
    const history = f.saved.history.length; f.advance(10_000); await f.service.scanNow(); expect(f.saved.history).toHaveLength(history);
    f.setGoal(active); await f.service.scanNow(); expect(f.saved.records.session.reason).toBe("goal_active");
    f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledOnce(); expect(f.resumeBlockedGoal).not.toHaveBeenCalled();
  });
  it("checks a selected goal after a missed completion event instead of silently ending the watch", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await f.track(); await f.service.watchGoal("session");
    f.idle(); f.a.attentionReason = "finished"; f.a.attentionTimestamp = new Date(epoch + 1000).toISOString();
    await f.restart("boot-a"); expect(f.saved.records.session.reason).toBe("goal_active");
    f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("can select an OpenCode goal paused by user intervention without resuming or resetting it", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.a.modeId = "goal";
    f.setGoal({ ...active, source: "opencode", modeId: "goal", state: "paused" }); await f.service.configure(f.settings);
    expect(await f.service.goalControl("session")).toMatchObject({ visible: true, state: "paused", canSelect: true });
    await f.service.watchGoal("session", active.key!);
    expect(await f.service.goalControl("session")).toMatchObject({ selected: true, note: expect.stringContaining("does not resume") });
    f.advance(120_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("leaves a native OpenCode continuation claim to its existing loop", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.a.modeId = "goal";
    f.setGoal({ ...active, source: "opencode", modeId: "goal", nativeContinuation: true }); await f.service.configure(f.settings);
    await f.service.watchGoal("session", active.key!);
    f.advance(60_000); await f.service.scanNow(); f.advance(60_000); await f.service.scanNow();
    expect(f.send).not.toHaveBeenCalled(); expect(f.saved.records.session.goal?.attempts).toBe(0);
    expect(await f.service.goalControl("session", true)).toMatchObject({ selected: true, state: "active", note: expect.stringContaining("OpenCode is managing") });
  });
  it("blocks a continuation if OpenCode leaves Goal mode between the goal read and final session check", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.a.modeId = "goal";
    f.setGoal({ ...active, source: "opencode", modeId: "goal" }); await f.service.configure(f.settings); await f.service.watchGoal("session", active.key!);
    f.a.modeId = "build"; f.advance(60_000); await f.service.scanNow();
    expect(f.send).not.toHaveBeenCalled(); expect(f.saved.records.session.reason).toBe("unknown_state");
  });
  it("removes an OpenCode selection when its mode no longer exposes the current goal", async () => {
    const f = fixture({ continueGoals: true }); f.idle(); f.a.modeId = "goal";
    f.setGoal({ ...active, source: "opencode", modeId: "goal" }); await f.service.configure(f.settings); await f.service.watchGoal("session", active.key!);
    f.a.modeId = "build"; f.setGoal({ state: "cleared", key: null, evidence: false, source: "opencode" });
    await f.service.scanNow();
    expect(await f.service.goalControl("session", true)).toMatchObject({ visible: false, selected: false });
    expect(f.saved.records.session.goal?.selectedKey).toBeNull(); expect(f.send).not.toHaveBeenCalled();
  });
  it("shows an unverified selected goal only so its selection can be turned off", async () => {
    const f = fixture(); f.setGoal(active); await f.track(); await f.service.watchGoal("session");
    f.setGoal({ state: "unknown", key: null, evidence: false });
    expect(await f.service.goalControl("session", true)).toMatchObject({ visible: true, selected: true, canSelect: false, state: "unknown" });
    await f.service.unwatchGoal("session"); expect(await f.service.goalControl("session")).toMatchObject({ visible: false });
  });
  it("shows a replacement objective as off before the next turn ends", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await f.track(); await f.service.watchGoal("session");
    f.setGoal({ ...active, key: "new-goal" });
    expect(await f.service.goalControl("session", true)).toMatchObject({ visible: true, selected: false, canSelect: true, key: "new-goal" });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("caches discovery briefly and invalidates the cache on a toggle or settings change", async () => {
    const f = fixture(); f.setGoal(active); await f.service.configure(f.settings);
    await f.service.goalControl("session"); await f.service.goalControl("session"); expect(f.goal).toHaveBeenCalledOnce();
    await f.service.watchGoal("session"); expect(await f.service.goalControl("session")).toMatchObject({ selected: true });
    await f.service.configure({ ...f.settings, continueGoals: true });
    expect(await f.service.goalControl("session")).toMatchObject({ automatic: true });
  });
  it("does not enable excluded sessions and hides archived or missing sessions", async () => {
    const f = fixture(); f.setGoal(active); await f.service.configure(f.settings); await f.service.exclude("session", true);
    expect(await f.service.goalControl("session")).toMatchObject({ visible: true, canSelect: false });
    f.a.archivedAt = "2026-10-20T00:00:00Z";
    expect(await f.service.goalControl("session", true)).toMatchObject({ visible: false });
    expect(await f.service.goalControl("missing", true)).toMatchObject({ visible: false });
  });
  it("discards a goal reading if a stop arrives during discovery", async () => {
    const f = fixture(); await f.track(); let release!: (value: GoalReading) => void;
    f.goal.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const reading = f.service.goalControl("session");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stop = f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
    release(active); expect(await reading).toMatchObject({ visible: false, selected: false }); await stop;
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not delay recovery actions while a visibility lookup waits on the provider", async () => {
    const f = fixture(); await f.track(); let release!: (value: GoalReading) => void;
    f.goal.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const reading = f.service.goalControl("session");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.service.exclude("session", true);
    release(active); await expect(reading).rejects.toThrow(/changed/);
    expect(f.saved.excluded).toEqual(["session"]); expect(f.send).not.toHaveBeenCalled();
  });
  it("does not queue another session's control behind a slow provider lookup", async () => {
    const f = fixture(); await f.service.configure(f.settings); f.others.set("other", { ...f.a, id: "other" });
    let release!: (value: GoalReading) => void;
    f.goal.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.service.goalControl("session", true);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    let other: unknown; const second = f.service.goalControl("other", true).then((value) => { other = value; });
    await vi.waitFor(() => expect(other).toMatchObject({ id: "other" }));
    release(active); await pending; await second; expect(f.send).not.toHaveBeenCalled();
  });
  it("does not cache an older reading over a newer result for the same session", async () => {
    const f = fixture(); await f.service.configure(f.settings); let release!: (value: GoalReading) => void;
    f.goal.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const old = f.service.goalControl("session", true);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.setGoal({ ...active, key: "latest-goal" }); await f.service.goalControl("session", true);
    release(active); await old;
    expect(await f.service.goalControl("session")).toMatchObject({ key: "latest-goal" });
  });
});
describe("goal continuation", () => {
  const active: GoalReading = { state: "active", key: "goal-fingerprint", evidence: true };
  async function select(f: ReturnType<typeof fixture>) { await f.track(); await f.service.watchGoal("session"); }
  async function ended(f: ReturnType<typeof fixture>, turnId = "turn-1") {
    f.idle(); f.a.attentionReason = "finished"; f.a.attentionTimestamp = new Date(epoch + 1000).toISOString();
    await f.event({ kind: "end", turnId, outcome: { kind: "completed" } } as Omit<RecoveryEvent, "agent">);
    await f.service.scanNow();
  }
  it("discovers an active goal without selecting or protecting it", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await f.track(); await ended(f);
    const row = f.service.status(statusInput.parse({ view: "goals" })).rows[0];
    expect(row.goalSelected).toBe(false); expect(row.reason).toBe("goal_unselected");
    expect(holdIds(f.saved)).toEqual([]); f.advance(HOUR); await f.service.scanNow();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("keeps a selection made during a turn while the master switch is off", async () => {
    const f = fixture(); f.setGoal(active); await select(f); await ended(f);
    expect(f.saved.records.session.reason).toBe("goal_disabled");
    await f.service.configure({ ...f.settings, continueGoals: true });
    f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("does not inherit an old selection if the objective changes with the master off", async () => {
    const f = fixture(); f.setGoal(active); await select(f);
    f.setGoal({ ...active, key: "new-objective" }); await ended(f);
    await f.service.configure({ ...f.settings, continueGoals: true });
    f.advance(60_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    expect(f.saved.records.session.goal?.selectedKey).toBeNull();
  });
  it("uses the goal delay when automatic recovery is switched back on", async () => {
    const f = fixture({ enabled: false, continueGoals: true, delaySeconds: 30, goalDelaySeconds: 120 });
    f.setGoal(active); await select(f); await ended(f);
    await f.service.configure({ ...f.settings, enabled: true });
    f.advance(30_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    f.advance(90_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("continues only the selected session when several have active goals", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f);
    f.others.set("other", { ...f.a, id: "other", status: "idle", activeTurn: null });
    await f.service.observe({ kind: "start", agent: { ...hook, id: "other" }, turnId: "other-turn" });
    await f.service.observe({ kind: "end", agent: { ...hook, id: "other" }, turnId: "other-turn", outcome: { kind: "completed" } });
    await ended(f); f.advance(60_000); await f.service.scanNow();
    expect(f.send.mock.calls.map(([id]) => id)).toEqual(["session"]);
    expect(f.service.status().counts.selectedGoals).toBe(1);
  });
  it("does not carry a selection into a different objective during the delay", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    f.setGoal({ ...active, key: "different-objective" }); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.goal?.selectedKey).toBeNull();
    expect(f.saved.records.session.reason).toBe("goal_unselected"); expect(holdIds(f.saved)).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not carry a selection into a different objective in a later turn", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    f.a.status = "running"; f.a.activeTurn = "turn-2";
    await f.event({ kind: "start", turnId: "turn-2" } as Omit<RecoveryEvent, "agent">);
    f.setGoal({ ...active, key: "different-objective" }); await ended(f, "turn-2");
    expect(f.saved.records.session.goal?.selectedKey).toBeNull();
    f.advance(60_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects a toggle based on a goal that has since changed", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await f.track(); await ended(f);
    f.setGoal({ ...active, key: "new-objective" });
    await expect(f.service.watchGoal("session", active.key!)).rejects.toThrow(/goal changed/);
    expect(f.saved.records.session.goal?.selectedKey).toBeNull(); expect(f.send).not.toHaveBeenCalled();
  });
  it("turning the session toggle off cancels the goal and releases its cleanup hold", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    await f.service.unwatchGoal("session");
    expect(holdIds(f.saved)).toEqual([]); expect(f.saved.records.session.goal?.selectedKey).toBeNull();
    f.advance(60_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("turning the toggle off does not cancel daemon-restart recovery", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); f.idle(); await f.restart();
    expect(f.saved.records.session.reason).toBe("daemon_restart");
    await f.service.unwatchGoal("session"); expect(f.saved.records.session.reason).toBe("daemon_restart");
    expect(holdIds(f.saved)).toEqual(["session"]); f.advance(60_000); await f.service.scanNow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][1]).toBe(f.settings.prompt);
  });
  it("selecting a goal preserves an existing interruption requiring review", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await f.track(); f.idle();
    await f.event({ kind: "closed" }); await f.service.watchGoal("session");
    expect(f.saved.records.session.reason).toBe("runtime_closed");
    expect(f.saved.records.session.goal?.selectedKey).toBe(active.key);
    f.advance(60_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("keeps uncertain delivery protected when the goal toggle is turned off", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    f.send.mockRejectedValueOnce(new Error("response lost")); f.advance(60_000); await f.service.scanNow();
    await f.service.unwatchGoal("session");
    expect(f.saved.records.session.reason).toBe("uncertain_send"); expect(holdIds(f.saved)).toEqual(["session"]);
    await f.restart(); f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("cancels an in-flight verification when the toggle is turned off", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f); f.advance(60_000);
    let release!: (w: Workspace) => void; let began!: () => void;
    const reading = new Promise<void>((resolve) => { began = resolve; });
    f.getWorkspace.mockImplementationOnce(async () => { began(); return new Promise((resolve) => { release = resolve; }); });
    const scan = f.service.scanNow(); await reading;
    const off = f.service.unwatchGoal("session"); release(f.workspace);
    await expect(scan).rejects.toThrow(/changed/); await off;
    expect(f.send).not.toHaveBeenCalled(); expect(holdIds(f.saved)).toEqual([]);
  });
  it("does not reset the continuation count when a toggle is cycled", async () => {
    const f = fixture({ continueGoals: true, goalMaxAttempts: 1 }); f.setGoal(active); await select(f); await ended(f);
    f.advance(60_000); await f.service.scanNow();
    f.a.status = "running"; f.a.activeTurn = "turn-2";
    await f.event({ kind: "start", turnId: "turn-2" } as Omit<RecoveryEvent, "agent">); await ended(f, "turn-2");
    await f.service.unwatchGoal("session"); await f.service.watchGoal("session"); await f.service.scanNow();
    expect(f.saved.records.session.goal?.attempts).toBe(1); expect(f.saved.records.session.reason).toBe("goal_limit");
    await f.service.watchGoal("session", active.key!, true);
    expect(f.saved.records.session.goal?.attempts).toBe(0); f.advance(60_000); await f.service.scanNow();
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("clears selection when the goal completes, even if its objective is reused", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    f.setGoal({ ...active, state: "complete" }); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.goal?.selectedKey).toBeNull();
    f.a.status = "running"; f.a.activeTurn = "turn-2";
    await f.event({ kind: "start", turnId: "turn-2" } as Omit<RecoveryEvent, "agent">);
    f.setGoal(active); await ended(f, "turn-2"); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("goal_unselected"); expect(f.send).not.toHaveBeenCalled();
  });
  it("keeps a selected but unverifiable goal for review and preserves its fingerprint", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    f.setGoal({ state: "unknown", key: null, evidence: false }); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("goal_unknown"); expect(holdIds(f.saved)).toEqual(["session"]);
    expect(f.saved.records.session.goal?.key).toBe(active.key);
    await f.service.unwatchGoal("session"); expect(holdIds(f.saved)).toEqual([]); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["goal_active", "goal_disabled", "goal_limit", "goal_unknown"] as const)("does not select a legacy %s record on upgrade", async (reason) => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    const legacy = f.saved;
    Reflect.deleteProperty(legacy.records.session.goal!, "selectedKey");
    legacy.records.session.reason = reason; legacy.records.session.phase = reason === "goal_active" ? "scheduled" : "review";
    const migrated = stateSchema.parse(legacy); expect(migrated.records.session.goal?.selectedKey).toBeNull();
    f.setSaved(migrated); await f.restart(); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("goal_unselected"); expect(holdIds(f.saved)).toEqual([]); expect(f.send).not.toHaveBeenCalled();
  });
  it("continues a completed turn with an active goal after the configured delay", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    expect(f.saved.records.session.reason).toBe("goal_active"); expect(holdIds(f.saved)).toContain("session");
    f.advance(59_999); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    f.advance(1); await f.service.scanNow(); await f.service.scanNow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][1]).toContain("goal was still active");
    expect(f.saved.records.session.goal?.attempts).toBe(1);
  });
  it("does not treat an old finished marker as completion of an unobserved continuation", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    f.advance(60_000); await f.service.scanNow();
    f.advance(30_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("uncertain_send");
    f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("does not read conversations or change completed turns unless enabled", async () => {
    const f = fixture(); f.setGoal(active); await f.track(); await ended(f); f.advance(HOUR); await f.service.scanNow();
    expect(f.goal).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["complete", "paused", "blocked", "limited", "cleared", "unknown"] as const)("does not restart a goal with state %s", async (state) => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); f.setGoal({ ...active, state }); await ended(f);
    f.advance(HOUR); await f.service.scanNow();
    expect(f.send).not.toHaveBeenCalled(); expect(f.saved.records.session.goal?.state).toBe(state);
    expect(f.service.status(statusInput.parse({ view: "goals" })).rows[0].canResume).toBe(false);
  });
  it("does not treat the absence of a goal as unfinished work", async () => {
    const f = fixture({ continueGoals: true }); await f.track(); await ended(f); f.advance(HOUR); await f.service.scanNow();
    expect(f.saved.records.session.phase).toBe("completed"); expect(f.send).not.toHaveBeenCalled();
  });
  it("rechecks completion during the grace period", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    f.setGoal({ ...active, state: "complete" }); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("goal_complete"); expect(f.send).not.toHaveBeenCalled();
  });
  it("lets the provider's own continuation start first", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    f.a.activeTurn = "native-turn"; f.a.status = "running";
    f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.phase).toBe("watching"); expect(f.send).not.toHaveBeenCalled();
  });
  it("honors a stop while a goal continuation is scheduled", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
    f.advance(HOUR); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("user_stop"); expect(f.send).not.toHaveBeenCalled();
  });
  it("holds questions and approvals for the user", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f);
    await f.event({ kind: "permission", requestId: "question" } as Omit<RecoveryEvent, "agent">); await ended(f);
    f.advance(HOUR); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("input"); expect(f.send).not.toHaveBeenCalled();
  });
  it("preserves the per-goal limit across turns and restarts", async () => {
    const f = fixture({ continueGoals: true, goalMaxAttempts: 1 }); f.setGoal(active); await select(f); await ended(f);
    f.advance(60_000); await f.service.scanNow();
    f.a.status = "running"; f.a.activeTurn = "turn-2";
    await f.event({ kind: "start", turnId: "turn-2" } as Omit<RecoveryEvent, "agent">);
    await ended(f, "turn-2");
    expect(f.saved.records.session.reason).toBe("goal_limit");
    await f.restart(); f.advance(HOUR); await f.service.scanNow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.saved.records.session.goal?.attempts).toBe(1);
  });
  it("does not reuse a queued continuation after the user changes the conversation", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    f.a.lastUserMessageAt = new Date(epoch + 60_000).toISOString(); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("new_activity"); expect(f.send).not.toHaveBeenCalled();
  });
  it("can explicitly watch an existing idle goal without discovering other sessions", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); f.idle(); await f.service.configure(f.settings);
    await f.service.watchGoal("session"); f.advance(60_000); await f.service.scanNow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.saved.records.session.goal?.attempts).toBe(1);
    expect(f.fetch.mock.calls.every(([id]) => id === "session")).toBe(true);
  });
  it("allows manual preview with automation off but does not send automatically", async () => {
    const f = fixture(); f.setGoal(active); f.idle(); await f.service.configure(f.settings); await f.service.watchGoal("session");
    expect(f.saved.records.session.reason).toBe("goal_disabled");
    const preview = await f.service.prepare("session"); expect(preview.prompt).toContain("goal was still active");
    f.advance(HOUR); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("schedules a watched goal when its setting is enabled", async () => {
    const f = fixture(); f.setGoal(active); f.idle(); await f.service.configure(f.settings); await f.service.watchGoal("session");
    await f.service.configure({ ...f.settings, continueGoals: true });
    expect(f.saved.records.session.reason).toBe("goal_active");
    f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("keeps goal continuations dormant while overall recovery is off", async () => {
    const f = fixture({ enabled: false, continueGoals: true }); f.setGoal(active); f.idle(); await f.service.configure(f.settings); await f.service.watchGoal("session");
    f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.phase).toBe("scheduled"); expect(f.send).not.toHaveBeenCalled();
    await f.service.configure({ ...f.settings, enabled: true });
    f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("keeps uncertain delivery protected and blocks Watch goal from bypassing it", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await select(f); await ended(f);
    f.send.mockRejectedValueOnce(new Error("lost response")); f.advance(60_000); await f.service.scanNow();
    await expect(f.service.watchGoal("session")).rejects.toThrow(/uncertain delivery/);
    await f.restart(); f.advance(HOUR); await f.service.scanNow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(holdIds(f.saved)).toContain("session");
  });
  it("does not read an excluded session's goal", async () => {
    const f = fixture({ continueGoals: true }); f.setGoal(active); await f.track(); await f.service.exclude("session", true);
    await expect(f.service.watchGoal("session")).rejects.toThrow(/excluded/);
    expect(f.goal).not.toHaveBeenCalled();
  });
});
describe("restart recovery", () => {
  async function selectedRecovery(source: "codex" | "omp" | "claude" = "codex") {
    const f = fixture({ continueGoals: true, goalDelaySeconds: 30 }); f.a.provider = source; f.a.sessionId = "original-thread";
    const reading: GoalReading = { state: "active", key: "selected-objective", evidence: true, source,
      ...(source !== "codex" ? { nativeContinuation: true } : {}) };
    f.setGoal(reading); await f.track(); await f.service.watchGoal("session", reading.key!); f.idle(); await f.restart();
    const connection = vi.fn(async () => "detached" as "loaded" | "detached" | "unknown");
    const reconnect = vi.fn(async (_id: string, _expected: Agent, guard: () => void) => { guard(); connection.mockResolvedValue("loaded"); return structuredClone(f.a); });
    Object.assign(f.hosts.at(-1)!, { connection, reconnectSession: reconnect });
    return Object.assign(f, { connection, reconnect, reading });
  }
  it.each(["codex", "omp", "claude"] as const)("선택한 %s Goal의 소유 연결을 먼저 복원하고 같은 스캔에 메시지나 Goal 명령을 보내지 않는다", async (source) => {
    const f = await selectedRecovery(source); f.advance(60_000);
    await f.service.scanNow();
    expect(f.reconnect).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled(); expect(f.controlGoal).not.toHaveBeenCalled();
    expect(f.saved.records.session.goal).toMatchObject({ key: f.reading.key, selectedKey: f.reading.key, attempts: 1 });
    expect(f.saved.history.at(-1)).toMatchObject({ action: "resume", reason: "reconnected" });
  });
  it("재연결로 시작된 네이티브 턴을 인정하고 추가 요청을 보내지 않는다", async () => {
    const f = await selectedRecovery(); let started: Promise<void> | undefined;
    f.reconnect.mockImplementationOnce(async (_id, _expected, guard) => {
      expect(f.saved.records.session).toMatchObject({ phase: "sending", expectingStart: true });
      f.a.status = "running"; f.a.activeTurn = "native-turn";
      started = f.event({ kind: "start", turnId: "native-turn" } as Omit<RecoveryEvent, "agent">); guard();
      return structuredClone(f.a);
    });
    f.advance(60_000); await f.service.scanNow(); await started; f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session).toMatchObject({ phase: "watching", turnId: "native-turn" });
    expect(f.reconnect).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["codex", "claude"] as const)("%s 재연결 후 실제로 쉬고 있을 때만 별도 유예시간 뒤 이어간다", async (source) => {
    const f = await selectedRecovery(source); f.advance(60_000); await f.service.scanNow();
    await f.service.scanNow(); f.advance(29_999); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    f.advance(1); await f.service.scanNow(); await f.service.scanNow();
    expect(f.reconnect).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0][1]).toContain("Read the current goal"); expect(f.controlGoal).not.toHaveBeenCalled();
  });
  it.each(["paused", "blocked", "limited", "complete"] as const)("복구 전에 %s로 바뀐 Goal은 연결을 열지 않는다", async (state) => {
    const f = await selectedRecovery(); f.setGoal({ ...f.reading, state }); f.advance(60_000); await f.service.scanNow();
    expect(f.reconnect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["stop", "permission", "unwatch", "unknown", "message"] as const)("재연결 전에 %s가 있으면 자동으로 다시 실행하지 않는다", async (block) => {
    const f = await selectedRecovery();
    if (block === "stop") await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
    if (block === "permission") f.a.pendingPermissions = 1;
    if (block === "unwatch") await f.service.unwatchGoal("session");
    if (block === "unknown") f.a.activeTurn = undefined;
    if (block === "message") f.a.lastUserMessageAt = new Date(epoch + 2_000).toISOString();
    f.advance(60_000); await f.service.scanNow();
    expect(f.reconnect).not.toHaveBeenCalled();
    // Unselecting a goal preserves ordinary daemon-restart recovery.
    if (block !== "unwatch") expect(f.send).not.toHaveBeenCalled();
  });
  it("재연결 응답을 잃으면 다음 스캔이나 재시작에서 자동으로 반복하지 않는다", async () => {
    const f = await selectedRecovery(); f.reconnect.mockRejectedValueOnce(new Error("Lost acknowledgement"));
    f.advance(60_000); await f.service.scanNow(); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe("uncertain_send"); expect(f.reconnect).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
    await f.restart(); f.advance(60_000); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("플러그인 관찰 공백 뒤 선택한 Goal만 다시 검사하고 복구한다", async () => {
    const f = await selectedRecovery();
    // This fixture's new service is the second boot; reload it without changing boot identity.
    await f.restart("boot-b"); Object.assign(f.hosts.at(-1)!, { connection: f.connection, reconnectSession: f.reconnect });
    f.advance(60_000); await f.service.scanNow(); await f.service.scanNow();
    expect(f.reconnect).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it("does not scan or resume pre-existing sessions on first install", async () => {
    const f = fixture(); f.idle(); await f.service.configure(f.settings); f.advance(HOUR); await f.service.scanNow();
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.saved.records).toEqual({});
  });
  it("waits through the grace period, saves the intent, and sends one continuation", async () => {
    const f = fixture(); await f.track(); f.idle(); await f.restart();
    expect(f.row()?.reason).toBe("daemon_restart"); expect(f.send).not.toHaveBeenCalled();
    f.send.mockImplementationOnce(async (id, prompt, messageId, _a, check) => {
      check(); expect(f.saved.records[id].phase).toBe("sending"); expect(f.saved.records[id].attemptMessageId).toBe(messageId);
      expect(holdIds(f.saved)).toContain(id); expect(prompt).toContain("before repeating");
    });
    f.advance(59_999); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
    f.advance(1); await f.service.scanNow(); await f.service.scanNow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.saved.records.session.phase).toBe("resumed");
  });
  it.each(["completed", "canceled"] as const)("never restarts an explicitly %s turn", async (kind) => {
    const f = fixture(); await f.track();
    await f.event({ kind: "end", turnId: "turn-1", outcome: kind === "completed" ? { kind } : { kind, reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
    f.idle(); await f.restart(); f.advance(HOUR); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled(); expect(holdIds(f.saved)).toEqual([]);
  });
  it("distinguishes graceful daemon shutdown from a manual stop", async () => {
    const f = fixture(); await f.track(); f.shutdown(true);
    await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
    await f.event({ kind: "closed" }); expect(f.saved.records.session.phase).toBe("interrupted");
    f.shutdown(false); f.idle(); await f.restart(); f.advance(60_000); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("treats a plugin reload in the same daemon as a review candidate", async () => {
    const f = fixture(); await f.track(); f.idle(); await f.restart("boot-a"); f.advance(HOUR); await f.service.scanNow();
    expect(f.row()?.reason).toBe("monitor_gap"); expect(f.send).not.toHaveBeenCalled();
  });
  it("does not mistake an unexplained runtime close for a daemon interruption", async () => {
    const f = fixture(); await f.track(); await f.event({ kind: "closed" }); f.idle(); await f.restart(); f.advance(HOUR); await f.service.scanNow();
    expect(f.row()?.reason).toBe("runtime_closed"); expect(f.send).not.toHaveBeenCalled();
  });
  it("leaves old interruptions for review", async () => {
    const f = fixture(); await f.track(); f.idle(); f.advance(25 * HOUR); await f.restart();
    expect(f.row()?.reason).toBe("too_old"); expect(f.send).not.toHaveBeenCalled();
  });
  it("preserves questions across a crash even when the daemon loses its pending request", async () => {
    const f = fixture(); await f.track(); await f.event({ kind: "permission", requestId: "approval" } as Omit<RecoveryEvent, "agent">);
    f.idle(); await f.restart(); f.advance(HOUR); await f.service.scanNow();
    expect(f.row()?.reason).toBe("input"); expect(f.row()?.canResume).toBe(false); expect(f.send).not.toHaveBeenCalled();
  });
  it("keeps multiple approvals pending until they are allowed", async () => {
    const f = fixture(); await f.track();
    for (const id of ["one", "two"]) await f.event({ kind: "permission", requestId: id } as Omit<RecoveryEvent, "agent">);
    await f.event({ kind: "resolution", requestId: "one", allowed: true } as Omit<RecoveryEvent, "agent">);
    expect(f.saved.records.session.humanRequired).toBe(true);
    await f.event({ kind: "resolution", requestId: "two", allowed: true } as Omit<RecoveryEvent, "agent">);
    expect(f.saved.records.session.humanRequired).toBe(false);
  });
  it("excludes subagents from automatic recovery by default", async () => {
    const f = fixture(); f.a.parentId = "parent"; await f.track(); f.idle(); await f.restart();
    expect(f.row()?.reason).toBe("subagent"); expect(f.send).not.toHaveBeenCalled();
  });
  it("checks all parents before recovering an opted-in subagent", async () => {
    const f = fixture({ recoverSubagents: true }); f.a.parentId = "parent";
    f.others.set("parent", { ...f.a, id: "parent", parentId: null, activeTurn: "parent-turn" });
    await f.track(); f.idle(); await f.restart(); f.advance(60_000); await f.service.scanNow();
    expect(f.row()?.reason).toBe("parent_unavailable"); expect(f.send).not.toHaveBeenCalled();
  });
  it.each([
    ["archivedAt", "2026-10-20T00:00:01Z", "archived"], ["persistence", false, "no_history"],
    ["activeTurn", undefined, "unknown_state"], ["pendingPermissions", -1, "unknown_state"],
    ["lastUserMessageAt", "2026-10-20T00:00:30Z", "new_activity"],
  ] as const)("does not resume when %s changes", async (field, value, expected) => {
    const f = fixture(); await f.track(); f.idle(); Object.assign(f.a, { [field]: value }); await f.restart(); f.advance(60_000); await f.service.scanNow();
    expect(f.saved.records.session.reason).toBe(expected); expect(f.send).not.toHaveBeenCalled();
  });
  it("honors completion found in the snapshot after a lost hook", async () => {
    const f = fixture(); await f.track(); f.idle(); f.a.attentionReason = "finished"; f.a.attentionTimestamp = new Date(epoch + 500).toISOString();
    await f.restart(); f.advance(HOUR); await f.service.scanNow(); expect(f.saved.records.session.phase).toBe("completed"); expect(f.send).not.toHaveBeenCalled();
  });
  it("does not interrupt a turn that is already active after reconnection", async () => {
    const f = fixture(); await f.track(); await f.restart(); f.advance(HOUR); await f.service.scanNow();
    expect(f.saved.records.session.phase).toBe("watching"); expect(f.send).not.toHaveBeenCalled();
  });
  it("keeps monitoring while automatic recovery is off", async () => {
    const f = fixture({ enabled: false }); await f.track(); f.idle(); await f.restart(); f.advance(HOUR); await f.service.scanNow();
    expect(f.service.status().state).toBe("paused"); expect(f.send).not.toHaveBeenCalled();
  });
});
describe("bounded attempts and delivery", () => {
  it("retries a normalized Codex capacity failure with bounded backoff in the same session", async () => {
    const f = fixture({ retryTransientErrors: true, maxAttempts: 2 }); await f.track(); f.idle();
    for (const [index, delay] of [60_000, 120_000].entries()) {
      const turnId = `turn-${index + 1}`;
      if (index) await f.event({ kind: "start", turnId } as Omit<RecoveryEvent, "agent">);
      await f.event({ kind: "end", turnId, outcome: { kind: "failed", error: { code: "server_overloaded" } } } as Omit<RecoveryEvent, "agent">);
      expect(f.row()?.reason).toBe("transient_error");
      f.advance(delay - 1); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(index);
      f.advance(1); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(index + 1);
      expect(f.send.mock.calls[index]![0]).toBe("session");
      expect(f.send.mock.calls[index]![3].provider).toBe("codex");
    }
    await f.event({ kind: "start", turnId: "turn-3" } as Omit<RecoveryEvent, "agent">);
    await f.event({ kind: "end", turnId: "turn-3", outcome: { kind: "failed", error: { code: "server_overloaded" } } } as Omit<RecoveryEvent, "agent">);
    f.advance(HOUR); await f.service.scanNow(); expect(f.row()?.reason).toBe("attempt_limit"); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("keeps normalized capacity failures in review until transient retries are enabled", async () => {
    const f = fixture(); await f.track(); f.idle();
    await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "failed", error: { code: "server_overloaded" } } } as Omit<RecoveryEvent, "agent">);
    f.advance(HOUR); await f.service.scanNow(); expect(f.row()?.reason).toBe("provider_error"); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["stop", "permission", "message"] as const)("blocks a scheduled capacity retry after %s", async (action) => {
    const f = fixture({ retryTransientErrors: true }); await f.track(); f.idle();
    await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "failed", error: { code: "server_overloaded" } } } as Omit<RecoveryEvent, "agent">);
    expect(f.row()?.reason).toBe("transient_error");
    if (action === "stop") await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
    else if (action === "permission") await f.event({ kind: "permission", requestId: "approval" } as Omit<RecoveryEvent, "agent">);
    else f.a.lastUserMessageAt = new Date(epoch + 30_000).toISOString();
    f.advance(HOUR); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("never automatically repeats a submission with an unknown result", async () => {
    const f = fixture(); await f.track(); f.idle(); await f.restart();
    f.send.mockRejectedValueOnce(new Error("response lost")); f.advance(60_000); await f.service.scanNow();
    expect(f.row()?.reason).toBe("uncertain_send"); expect(f.row()?.canResume).toBe(false);
    await f.restart("boot-c"); f.advance(HOUR); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("preserves the attempt budget and increases backoff across continued turns", async () => {
    const f = fixture({ retryTransientErrors: true, maxAttempts: 2 }); await f.track(); f.idle(); await f.restart();
    f.advance(60_000); await f.service.scanNow();
    await f.event({ kind: "start", turnId: "turn-2" } as Omit<RecoveryEvent, "agent">);
    await f.event({ kind: "end", turnId: "turn-2", outcome: { kind: "failed", error: { code: "ETIMEDOUT" } } } as Omit<RecoveryEvent, "agent">);
    expect(f.saved.records.session.attempts).toBe(1);
    f.advance(119_999); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(1); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(2);
    await f.event({ kind: "start", turnId: "turn-3" } as Omit<RecoveryEvent, "agent">);
    await f.event({ kind: "end", turnId: "turn-3", outcome: { kind: "failed", error: { code: "ETIMEDOUT" } } } as Omit<RecoveryEvent, "agent">);
    await f.service.scanNow(); expect(f.row()?.reason).toBe("attempt_limit"); f.advance(HOUR); await f.service.scanNow(); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("sends unknown provider errors to review even if transient retries are enabled", async () => {
    const f = fixture({ retryTransientErrors: true }); await f.track(); f.idle();
    await f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "failed", error: { code: "authentication_failed" } } } as Omit<RecoveryEvent, "agent">);
    f.advance(HOUR); await f.service.scanNow(); expect(f.row()?.reason).toBe("provider_error"); expect(f.send).not.toHaveBeenCalled();
  });
  it("does not send when durable intent storage fails", async () => {
    const f = fixture(); await f.track(); f.idle(); await f.restart(); f.advance(60_000);
    f.store.save.mockRejectedValueOnce(new RecoveryError("disk full")); await expect(f.service.scanNow()).rejects.toThrow("disk full");
    await expect(f.service.scanNow()).rejects.toThrow(/paused/); expect(f.send).not.toHaveBeenCalled();
  });
  it("does not guess after unreadable history", async () => {
    const f = fixture(); f.store.load.mockRejectedValueOnce(new RecoveryError("unreadable history"));
    await expect(f.service.configure(f.settings)).rejects.toThrow("unreadable"); expect(f.service.status().state).toBe("error"); expect(f.send).not.toHaveBeenCalled();
  });
  it("ignores a terminal event from an earlier turn", async () => {
    const f = fixture(); await f.track();
    await f.event({ kind: "end", turnId: "turn-old", outcome: { kind: "completed" } } as Omit<RecoveryEvent, "agent">);
    expect(f.saved.records.session.phase).toBe("watching");
  });
});
describe("manual review and concurrent changes", () => {
  it("does not report a manual validation error as paused automation", async () => {
    const f = fixture(); await f.service.configure(f.settings);
    await expect(f.service.prepare("missing")).rejects.toThrow(/does not have/);
    expect(f.service.status().state).toBe("running");
  });
  it("does not clear a pending question with an unrelated resolution", async () => {
    const f = fixture(); await f.track(); f.a.pendingPermissions = 1; await f.service.scanNow();
    await f.event({ kind: "resolution", requestId: "unobserved-request", allowed: true } as Omit<RecoveryEvent, "agent">);
    expect(f.saved.records.session.humanRequired).toBe(true); f.idle(); f.a.pendingPermissions = 0;
    await f.restart(); f.advance(HOUR); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("previews the actual continuation and consumes the ticket once", async () => {
    const f = fixture(); await f.track(); f.idle(); await f.event({ kind: "closed" });
    const preview = await f.service.prepare("session"); expect(preview.prompt).toBe(f.settings.prompt);
    await f.service.resume(preview.token); await expect(f.service.resume(preview.token)).rejects.toThrow(/expired/); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("rejects a preview when the conversation changes", async () => {
    const f = fixture(); await f.track(); f.idle(); await f.event({ kind: "closed" }); const preview = await f.service.prepare("session");
    f.a.title = "Changed"; await expect(f.service.resume(preview.token)).rejects.toThrow(/changed/); expect(f.send).not.toHaveBeenCalled();
  });
  it("expires manual recovery previews", async () => {
    const f = fixture(); await f.track(); f.idle(); await f.event({ kind: "closed" }); const preview = await f.service.prepare("session");
    f.advance(60_000); await expect(f.service.resume(preview.token)).rejects.toThrow(/expired/); expect(f.send).not.toHaveBeenCalled();
  });
  it("dismisses a candidate and releases cleanup protection", async () => {
    const f = fixture(); await f.track(); f.idle(); await f.restart(); expect(holdIds(f.saved)).toEqual(["session"]);
    await f.service.dismiss("session"); expect(holdIds(f.saved)).toEqual([]); f.advance(HOUR); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("supports excluding a session before its first observed turn", async () => {
    const f = fixture(); await f.service.configure(f.settings); await f.service.exclude("session", true); await f.track(); f.idle(); await f.restart(); f.advance(HOUR); await f.service.scanNow();
    expect(holdIds(f.saved)).toEqual([]); expect(f.send).not.toHaveBeenCalled();
    await f.service.exclude("session", false); await f.service.scanNow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("cancels automatic recovery when settings change during verification", async () => {
    const f = fixture(); await f.track(); f.idle(); await f.restart(); f.advance(60_000);
    let release!: (w: Workspace) => void; let began!: () => void;
    const reading = new Promise<void>((resolve) => { began = resolve; });
    f.getWorkspace.mockImplementationOnce(async () => { began(); return new Promise((resolve) => { release = resolve; }); });
    const scan = f.service.scanNow(); await reading; const pause = f.service.configure({ ...f.settings, enabled: false }); release(f.workspace);
    await expect(scan).rejects.toThrow(/changed/); await pause; expect(f.send).not.toHaveBeenCalled();
  });
  it("honors a stop event while verification is in flight", async () => {
    const f = fixture(); await f.track(); f.idle(); await f.restart(); f.advance(60_000);
    let release!: (w: Workspace) => void; let began!: () => void;
    const reading = new Promise<void>((resolve) => { began = resolve; });
    f.getWorkspace.mockImplementationOnce(async () => { began(); return new Promise((resolve) => { release = resolve; }); });
    const scan = f.service.scanNow(); await reading;
    const stopped = f.event({ kind: "end", turnId: "turn-1", outcome: { kind: "canceled", reason: "interrupted" } } as Omit<RecoveryEvent, "agent">);
    release(f.workspace); await expect(scan).rejects.toThrow(/changed/); await stopped;
    expect(f.send).not.toHaveBeenCalled(); expect(f.saved.records.session.phase).toBe("stopped");
  });
  it("invalid settings block further recovery actions", async () => {
    const f = fixture(); await f.track(); await f.service.invalidSettings();
    await expect(f.service.scanNow()).rejects.toThrow(/paused/); await expect(f.service.exclude("session", true)).rejects.toThrow(/paused/); expect(f.send).not.toHaveBeenCalled();
  });
});
