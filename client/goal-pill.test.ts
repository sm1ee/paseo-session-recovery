import type { PluginButtonIconProps, PluginClientContext } from "@getpaseo/plugin/client";
import type { FunctionComponent, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goalControlRpc, unwatchGoalRpc, watchGoalRpc, type GoalControl } from "../shared/contracts";
import { actOnGoalRpc } from "../shared/goal-actions";
import { readGoalRpc } from "../shared/goal-editor";
import { contributeGoalPills } from "./goal-pill";
import { goalErrorText, goalPreviewLabel } from "./goal-presentation";
import type { PillAgent } from "./goal-pill-controller";
vi.mock("./goal-pill-icon", () => ({ GoalPillIcon: () => null }));
vi.mock("./goal-editor", () => ({ GoalEditorContent: () => null }));

const agent = { id: "session", workspaceId: "workspace", status: "idle", provider: "codex" };
type PillButton = Parameters<PluginClientContext["addComposerPill"]>[0]["button"];
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
async function fixture(patch: Partial<GoalControl> = {}, agentPatch: Partial<PillAgent> = {}) {
  const observed = { ...agent, ...agentPatch };
  let goal: GoalControl = { id: agent.id, workspaceId: agent.workspaceId, visible: true, state: "active", key: "current-goal", selected: false, canSelect: true,
    automatic: false, attempts: 0, maxAttempts: 10, delaySeconds: 60, note: null, objective: "Finish the fixture", source: "codex", nativeAction: "pause", ...patch };
  let editor: Record<string, unknown> = {};
  const buttons = new Map<string, PillButton>();
  const update = vi.fn(), remove = vi.fn();
  let snapshot!: (value: { entries: Array<{ agent: PillAgent }> }) => void;
  const subscription = { subscribe: vi.fn((handlers) => { snapshot = handlers.snapshot; }) };
  const list = vi.fn(async () => ({ subscription }));
  const rpc = vi.fn(async (contract) => {
    if (contract === goalControlRpc) return { ...goal };
    if (contract === readGoalRpc) return { key: goal.key, source: goal.source, action: goal.nativeAction, nativeStart: goal.nativeStart, reconnect: goal.nativeReconnect, actionTicket: "one-use", ...editor };
    if (contract === actOnGoalRpc) { goal = { ...goal, state: goal.nativeAction === "pause" ? "paused" : "active", nativeAction: goal.nativeAction === "pause" ? "resume" : "pause" }; return { ok: true }; }
    throw new Error("Unexpected RPC");
  });
  const addComposerPill = vi.fn((pill: Parameters<PluginClientContext["addComposerPill"]>[0]) => {
    buttons.set(pill.id, pill.button);
    return { update: (value: Partial<PillButton>) => { update(value); buttons.set(pill.id, { ...buttons.get(pill.id)!, ...value }); }, remove };
  });
  const client = { rpc, addComposerPill, paseo: { agents: { list } } } as unknown as PluginClientContext;
  cleanup = contributeGoalPills(client);
  await vi.waitFor(() => expect(snapshot).toBeTypeOf("function"));
  snapshot({ entries: [{ agent: observed }] });
  expect(rpc).not.toHaveBeenCalled();
  const icon = buttons.get("goal-continuation")!.icon;
  if (typeof icon !== "function") throw new Error("Goal mount observer missing");
  ((icon as FunctionComponent<PluginButtonIconProps>)({} as PluginButtonIconProps) as ReactElement<{ observe(): () => void }>).props.observe();
  await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
  await vi.waitFor(() => expect(buttons.get("goal-continuation")?.label).toBe(goalPreviewLabel(goal, observed)));
  const press = async () => {
    const behavior = buttons.get("goal-playback")?.behavior;
    if (behavior?.kind !== "action") throw new Error("Native playback action missing");
    await behavior.onPress();
  };
  return { list, rpc, buttons, update, remove, press, set: (value: Partial<GoalControl>) => { goal = { ...goal, ...value }; }, setEditor: (value: Record<string, unknown>) => { editor = value; } };
}

describe("목표 미리보기와 네이티브 재생 제어", () => {
  it("별칭과 ACP 제공자는 캐시된 provider 목록으로 진입을 등록하고 Goal은 마운트 후에만 조회한다", async () => {
    let snapshot!: (value: { entries: Array<{ agent: PillAgent }> }) => void;
    const rpc = vi.fn(), remove = vi.fn(), addComposerPill = vi.fn(() => ({ update: vi.fn(), remove: vi.fn() }));
    const providers = { snapshot: vi.fn(async () => ({ entries: [
      { provider: "claude-codex", source: "custom", enabled: true }, { provider: "devin", source: "custom", enabled: true },
      { provider: "disabled", source: "custom", enabled: false },
    ] })), subscribe: vi.fn(() => remove) };
    cleanup = contributeGoalPills({ rpc, addComposerPill, paseo: { providers, agents: { list: vi.fn(async () => ({ subscription: { subscribe: (handlers: { snapshot: typeof snapshot }) => { snapshot = handlers.snapshot; } } })) } } } as unknown as PluginClientContext);
    await vi.waitFor(() => expect(snapshot).toBeTypeOf("function"));
    snapshot({ entries: ["claude-codex", "devin", "disabled"].map(provider => ({ agent: { ...agent, id: provider, provider } })) });
    await vi.waitFor(() => expect(addComposerPill).toHaveBeenCalledTimes(2));
    expect(rpc).not.toHaveBeenCalled();
    cleanup(); cleanup = undefined; expect(remove).toHaveBeenCalledOnce();
  });
  it("본문을 정규화해 줄이고 상태는 추가 이어가기 선택과 독립적으로 표시한다", () => {
    const base = { state: "active", objective: "한글🙂\n".repeat(40), selected: false, automatic: false } as GoalControl;
    const label = goalPreviewLabel(base);
    expect(label).toMatch(/^한글🙂 /); expect(label.endsWith("…")).toBe(true); expect(label).not.toContain("\n");
    expect(label).not.toContain("Off"); expect(label).not.toContain("�");
    expect(goalPreviewLabel(null)).toBe("Goal");
  });
  it("전송 계층의 requestType와 code는 사용자 오류 문구에 노출하지 않는다", () => {
    expect(goalErrorText(new Error("Request failed: The session changed while reading its goal.\nrequestType=plugin.rpc.invoke.request\ncode=handler_error"))).toBe("Changed. Reload.");
  });
  it("활성 Goal과 실제 세션 실행 상태를 구분한다", () => {
    const goal = { state: "active", objective: "Finish the fixture" } as GoalControl;
    expect(goalPreviewLabel(goal, { ...agent, status: "closed" })).toBe("Stopped · Finish the fixture");
    expect(goalPreviewLabel(goal, { ...agent, status: "error", activeTurn: null })).toBe("Error · Finish the fixture");
    expect(goalPreviewLabel(goal, { ...agent, activeTurn: null })).toBe("Idle · Finish the fixture");
    expect(goalPreviewLabel(goal, { ...agent, status: "running", activeTurn: { turnId: "live" } })).toBe("Finish the fixture");
    expect(goalPreviewLabel(goal, { ...agent, status: "running" })).toBe("Finish the fixture");
    expect(goalPreviewLabel({ ...goal, state: "paused" }, { ...agent, status: "closed" })).toBe("Finish the fixture");
  });
  it.each(["omp", "claude", "opencode", "codex"])("%s는 조회 전에 편집 시트 진입을 등록하고 전체 Goal RPC를 보내지 않는다", async (provider) => {
    const rpc = vi.fn(() => new Promise(() => {})), addComposerPill = vi.fn(() => ({ update: vi.fn(), remove: vi.fn() }));
    const subscription = { subscribe: vi.fn((handlers) => handlers.snapshot({ entries: [{ agent: { ...agent, provider } }] })) };
    cleanup = contributeGoalPills({ rpc, addComposerPill, paseo: { agents: { list: vi.fn(async () => ({ subscription })) } } } as unknown as PluginClientContext);
    await vi.waitFor(() => expect(addComposerPill).toHaveBeenCalledOnce());
    const entry = addComposerPill.mock.calls[0] as unknown as [Parameters<PluginClientContext["addComposerPill"]>[0]];
    expect(entry[0].button.behavior.kind).toBe("popover"); expect(rpc).not.toHaveBeenCalled();
  });
  it("목표 문구는 편집 시트를 열며 이어가기를 켜거나 끄지 않는다", async () => {
    const f = await fixture();
    expect(f.buttons.get("goal-continuation")).toMatchObject({ label: "Finish the fixture", behavior: { kind: "popover" } });
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith(goalControlRpc, { id: agent.id, fresh: true, preview: true });
    expect(f.rpc.mock.calls.some(([contract]) => contract === watchGoalRpc || contract === unwatchGoalRpc)).toBe(false);
  });
  it("일시정지는 최신 Goal을 다시 확인해 네이티브 명령을 한 번만 요청한다", async () => {
    const f = await fixture(); await f.press();
    expect(f.rpc).toHaveBeenCalledWith(readGoalRpc, { id: agent.id });
    expect(f.rpc).toHaveBeenCalledWith(actOnGoalRpc, { ticket: "one-use", confirmBudgetReset: false });
    expect(f.rpc.mock.calls.filter(([contract]) => contract === actOnGoalRpc)).toHaveLength(1);
    expect(f.buttons.get("goal-playback")).toMatchObject({ icon: "Play", label: "Resume" });
  });
  it.each(["codex", "omp", "opencode"] as const)("Stopped %s 미리보기 옆에는 연결 복원 Resume와 Play를 표시한다", async (source) => {
    const f = await fixture({ source, nativeAction: "resume", nativeReconnect: true, nativeActionReady: true }, { status: "closed", activeTurn: null });
    expect(f.buttons.get("goal-continuation")?.label).toMatch(/^Stopped/);
    expect(f.buttons.get("goal-playback")).toMatchObject({ label: "Resume", icon: "Play", disabled: false, behavior: { kind: "action" } });
    await f.press(); expect(f.rpc).toHaveBeenCalledWith(actOnGoalRpc, { ticket: "one-use", confirmBudgetReset: false });
  });
  it("Stopped 메타데이터와 오래된 Pause 응답이 섞여도 Pause를 표시하거나 전송하지 않는다", async () => {
    const f = await fixture({ nativeAction: "pause" }, { status: "closed", activeTurn: null });
    expect(f.buttons.get("goal-playback")).toMatchObject({ label: "Resume", icon: "Play", disabled: true });
    await expect(f.press()).rejects.toThrow(); expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc)).toBe(false);
  });
  it("이미 실행을 시작한 메타데이터가 오면 오래된 재연결 Resume를 다시 실행하지 않는다", async () => {
    const f = await fixture({ nativeAction: "resume", nativeReconnect: true }, { status: "running", activeTurn: { turnId: "native-turn" } });
    expect(f.buttons.get("goal-playback")).toMatchObject({ label: "Pause", icon: "Pause", disabled: true });
    await expect(f.press()).rejects.toThrow(); expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc)).toBe(false);
  });
  it("Resume 문구가 같아도 연결 복원과 네이티브 상태 변경 티켓을 섞지 않는다", async () => {
    const f = await fixture({ nativeAction: "resume", nativeReconnect: true }, { status: "closed", activeTurn: null });
    f.setEditor({ reconnect: false }); await expect(f.press()).rejects.toThrow();
    expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc)).toBe(false);
  });
  it.each([{ key: "replacement-goal" }, { action: "resume" }, { actionTicket: null, note: "Waiting for approval" }])("오래되거나 막힌 제어 %j는 다른 목표에 전송하지 않는다", async (editor) => {
    const f = await fixture(); f.setEditor(editor); await expect(f.press()).rejects.toThrow();
    expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc)).toBe(false);
  });
  it("확인되지 않은 제어 명령을 자동 재시도하지 않는다", async () => {
    const f = await fixture(); f.rpc.mockImplementationOnce(async () => ({ key: "current-goal", source: "codex", action: "pause", nativeStart: false, reconnect: false, actionTicket: "one-use" }));
    f.rpc.mockImplementationOnce(async () => { throw new Error("Receipt lost"); });
    await expect(f.press()).rejects.toThrow("Couldn’t confirm. Reload."); expect(f.rpc.mock.calls.filter(([contract]) => contract === actOnGoalRpc)).toHaveLength(1);
  });
  it("OpenCode 재개는 새 예산을 설명하는 편집 시트를 연다", async () => {
    const f = await fixture({ source: "opencode", state: "paused", nativeAction: "resume" });
    expect(f.buttons.get("goal-playback")).toMatchObject({ icon: "Play", label: "Resume", behavior: { kind: "popover" } });
    expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc)).toBe(false);
  });
  it("예전 OMP 요청을 재개로 표시하지 않고 명시적인 Start goal에서만 등록한다", async () => {
    const f = await fixture({ source: "omp", nativeStart: true, nativeAction: "resume" });
    expect(f.buttons.get("goal-playback")).toMatchObject({ title: "Start goal", label: "Start goal" });
    expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc)).toBe(false);
    await f.press(); expect(f.rpc).toHaveBeenCalledWith(actOnGoalRpc, { ticket: "one-use", confirmBudgetReset: false });
  });
  it("OMP 등록 여부가 바뀌면 오래된 Resume 버튼으로 새 목표를 시작하지 않는다", async () => {
    const f = await fixture({ source: "omp", nativeStart: false, nativeAction: "resume" });
    f.setEditor({ nativeStart: true }); await expect(f.press()).rejects.toThrow();
    expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc)).toBe(false);
  });
  it("턴 실행 등 일시적인 제한은 제어 버튼을 숨기는 대신 비활성화한다", async () => {
    const f = await fixture({ source: "opencode", nativeAction: "pause", nativeActionReady: false });
    expect(f.buttons.get("goal-playback")).toMatchObject({ label: "Pause", disabled: true, visible: true });
    expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc)).toBe(false);
  });
  it("비활성화 이유가 바뀌면 툴팁도 갱신하고 해제되면 기본 제목으로 돌아온다", async () => {
    vi.useFakeTimers();
    const f = await fixture({ source: "omp", state: "paused", nativeAction: "resume", nativeActionReady: false,
      nativeActionNote: "Previous command unconfirmed. Check the conversation." });
    expect(f.buttons.get("goal-playback")).toMatchObject({ label: "Resume", disabled: true,
      title: "Resume goal: Previous command unconfirmed. Check the conversation." });
    f.set({ nativeActionNote: "Waiting for your input." });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.buttons.get("goal-playback")?.title).toBe("Resume goal: Waiting for your input.");
    f.set({ nativeActionReady: true, nativeActionNote: null });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.buttons.get("goal-playback")).toMatchObject({ title: "Resume goal", disabled: false });
    expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc || contract === watchGoalRpc)).toBe(false);
  });
  it("구버전 서버에 비활성화 이유가 없으면 Goal 확인 안내를 표시한다", async () => {
    const f = await fixture({ nativeActionReady: false });
    expect(f.buttons.get("goal-playback")?.title).toBe("Pause goal: Controls unavailable. Open Goal to check.");
  });
  it.each(["claude", "timeline"] as const)("%s의 미지원 제어를 재생이나 일시정지로 표시하지 않는다", async (source) => {
    const f = await fixture({ source, nativeAction: null }); expect(f.buttons.has("goal-playback")).toBe(false);
  });
  it("전체 디렉터리는 등록에 사용하고 기본 첫 200개로 잘리지 않는다", async () => {
    const f = await fixture(); expect(f.list).toHaveBeenCalledWith(expect.objectContaining({ scope: "active", sync: {}, subscribe: {} }));
  });
  it("초기 연결 실패 시 관찰을 정리하고 재시도하며 종료 후에는 멈춘다", async () => {
    vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
    const subscription = { subscribe: vi.fn() }, list = vi.fn().mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValue({ subscription });
    cleanup = contributeGoalPills({ rpc: vi.fn(), addComposerPill: vi.fn(), paseo: { agents: { list } } } as unknown as PluginClientContext);
    await vi.advanceTimersByTimeAsync(0); expect(list.mock.calls[0][0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); expect(list).toHaveBeenCalledTimes(2);
    cleanup(); cleanup = undefined; await vi.advanceTimersByTimeAsync(10_000);
    expect(list.mock.calls[1][0].signal.aborted).toBe(true); expect(list).toHaveBeenCalledTimes(2);
  });
});
