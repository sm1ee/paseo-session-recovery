import type { PluginButton, PluginButtonIconProps, PluginClientContext } from "@getpaseo/plugin/client";
import type { FunctionComponent, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goalControlRpc, unwatchGoalRpc, watchGoalRpc, type GoalControl } from "../shared/contracts";
import { actOnGoalRpc } from "../shared/goal-actions";
import { readGoalRpc } from "../shared/goal-editor";
import { contributeGoalPills } from "./goal-pill";
import { goalErrorText, goalPreviewLabel } from "./goal-presentation";
vi.mock("./goal-pill-icon", () => ({ GoalPillIcon: () => null }));
vi.mock("./goal-editor", () => ({ GoalEditorContent: () => null }));

const agent = { id: "session", workspaceId: "workspace", status: "idle", provider: "codex" };
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
async function fixture(patch: Partial<GoalControl> = {}) {
  let goal: GoalControl = { id: agent.id, workspaceId: agent.workspaceId, visible: true, state: "active", key: "current-goal", selected: false, canSelect: true,
    automatic: false, attempts: 0, maxAttempts: 10, delaySeconds: 60, note: null, objective: "Finish the fixture", source: "codex", nativeAction: "pause", ...patch };
  let editor: Record<string, unknown> = {};
  const buttons = new Map<string, PluginButton>();
  const update = vi.fn(), remove = vi.fn();
  let snapshot!: (value: { entries: Array<{ agent: typeof agent }> }) => void;
  const subscription = { subscribe: vi.fn((handlers) => { snapshot = handlers.snapshot; }) };
  const list = vi.fn(async () => ({ subscription }));
  const rpc = vi.fn(async (contract) => {
    if (contract === goalControlRpc) return { ...goal };
    if (contract === readGoalRpc) return { key: goal.key, source: goal.source, action: goal.nativeAction, actionTicket: "one-use", ...editor };
    if (contract === actOnGoalRpc) { goal = { ...goal, state: goal.nativeAction === "pause" ? "paused" : "active", nativeAction: goal.nativeAction === "pause" ? "resume" : "pause" }; return { ok: true }; }
    throw new Error("Unexpected RPC");
  });
  const addComposerPill = vi.fn((pill: Parameters<PluginClientContext["addComposerPill"]>[0]) => {
    buttons.set(pill.id, pill.button);
    return { update: (value: Partial<PluginButton>) => { update(value); buttons.set(pill.id, { ...buttons.get(pill.id)!, ...value }); }, remove };
  });
  const client = { rpc, addComposerPill, paseo: { agents: { list } } } as unknown as PluginClientContext;
  cleanup = contributeGoalPills(client);
  await vi.waitFor(() => expect(snapshot).toBeTypeOf("function"));
  snapshot({ entries: [{ agent }] });
  expect(rpc).not.toHaveBeenCalled();
  const icon = buttons.get("goal-continuation")!.icon;
  if (typeof icon !== "function") throw new Error("Goal mount observer missing");
  ((icon as FunctionComponent<PluginButtonIconProps>)({} as PluginButtonIconProps) as ReactElement<{ observe(): () => void }>).props.observe();
  await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
  await vi.waitFor(() => expect(buttons.get("goal-continuation")?.label).toBe(goalPreviewLabel(goal)));
  const press = async () => {
    const behavior = buttons.get("goal-playback")?.behavior;
    if (behavior?.kind !== "action") throw new Error("Native playback action missing");
    await behavior.onPress();
  };
  return { list, rpc, buttons, update, remove, press, set: (value: Partial<GoalControl>) => { goal = { ...goal, ...value }; }, setEditor: (value: Record<string, unknown>) => { editor = value; } };
}

describe("목표 미리보기와 네이티브 재생 제어", () => {
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
  it.each([{ key: "replacement-goal" }, { action: "resume" }, { actionTicket: null, note: "Waiting for approval" }])("오래되거나 막힌 제어 %j는 다른 목표에 전송하지 않는다", async (editor) => {
    const f = await fixture(); f.setEditor(editor); await expect(f.press()).rejects.toThrow();
    expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc)).toBe(false);
  });
  it("확인되지 않은 제어 명령을 자동 재시도하지 않는다", async () => {
    const f = await fixture(); f.rpc.mockImplementationOnce(async () => ({ key: "current-goal", source: "codex", action: "pause", actionTicket: "one-use" }));
    f.rpc.mockImplementationOnce(async () => { throw new Error("Receipt lost"); });
    await expect(f.press()).rejects.toThrow("Couldn’t confirm. Reload."); expect(f.rpc.mock.calls.filter(([contract]) => contract === actOnGoalRpc)).toHaveLength(1);
  });
  it("OpenCode 재개는 새 예산을 설명하는 편집 시트를 연다", async () => {
    const f = await fixture({ source: "opencode", state: "paused", nativeAction: "resume" });
    expect(f.buttons.get("goal-playback")).toMatchObject({ icon: "Play", label: "Resume", behavior: { kind: "popover" } });
    expect(f.rpc.mock.calls.some(([contract]) => contract === actOnGoalRpc)).toBe(false);
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
