import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { openLocalHost, type RecoveryHost } from "./host";
import { OpenCodeGoals } from "./opencode-goals";
import { CodexGoals } from "./codex-goals";
import { ClaudeGoals } from "./claude-goals";
import { OmpGoals } from "./omp-goals";
import { OmpNativeGoals, ompNativeDetails } from "./omp-native-goals";
import type { GoalDetails } from "./goals";

type Info = NonNullable<ReturnType<DaemonClient["getLastServerInfoMessage"]>>;
let home: string;
let host: RecoveryHost | undefined;
let version: unknown;
let background: boolean;

beforeEach(async () => {
  version = "0.12.0"; background = true;
  home = await mkdtemp(join(tmpdir(), "recovery-background-test-"));
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00Z", serverId: "scope-test", listen: "127.0.0.1:6767" }));
  await writeFile(join(home, "local-credential"), "a".repeat(43));
  vi.spyOn(DaemonClient.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(DaemonClient.prototype, "close").mockResolvedValue(undefined);
  vi.spyOn(DaemonClient.prototype, "getConnectionState").mockReturnValue({ status: "connected" });
  vi.spyOn(DaemonClient.prototype, "getLastServerInfoMessage").mockImplementation(() => ({ serverId: "scope-test", version, features: { backgroundWorkspaces: background } }) as Info);
  vi.spyOn(DaemonClient.prototype, "supportsBackgroundWorkspaces").mockImplementation(() => background);
  vi.spyOn(DaemonClient.prototype, "fetchWorkspaces").mockImplementation(async (options) => {
    if (!background && options?.filter?.includeBackground) throw new Error("Background queries require a newer host");
    const id = options?.filter?.includeBackground ? "background-space" : "public-space";
    return { requestId: "test", entries: [{ id, archivingAt: null }], pageInfo: { hasMore: false, nextCursor: null } } as Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;
  });
});

describe("OMP 연결 중단과 Goal 생성 구분", () => {
  function ompFixture() {
    vi.spyOn(DaemonClient.prototype, "fetchAgent").mockResolvedValue({ agent: {
      id: "fixture", provider: "omp", labels: {}, persistence: { sessionId: "native-fixture", nativeHandle: "/fixture/native-fixture.jsonl" },
    } } as NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>);
    vi.spyOn(OpenCodeGoals.prototype, "read").mockResolvedValue(null);
    vi.spyOn(CodexGoals.prototype, "read").mockResolvedValue(null);
    const native = vi.spyOn(OmpNativeGoals.prototype, "details").mockResolvedValue(null);
    vi.spyOn(OmpNativeGoals.prototype, "supported").mockResolvedValue(true);
    const previous: GoalDetails = { objective: "Existing fixture objective", revision: "request-revision", tokenBudget: null, tokensUsed: null,
      reading: { source: "omp", state: "active", key: "fixture-goal", evidence: true }, sessionControls: true };
    const saved = vi.spyOn(OmpGoals.prototype, "details").mockResolvedValue(previous);
    const timeline = vi.spyOn(DaemonClient.prototype, "fetchAgentTimeline").mockRejectedValue(new Error("대화 복원 금지"));
    return { native, previous, saved, timeline };
  }
  it("RPC 연결 없음은 Goal 없음으로 바꾸거나 Start goal을 제공하지 않는다", async () => {
    const f = ompFixture(); host = await openLocalHost(home, process.pid);
    const details = await host.goalDetails!("fixture", { allowTimeline: false });
    expect(details).toMatchObject({ objective: f.previous.objective, reading: { state: "unknown", key: "fixture-goal" }, sessionControls: false, nativeControls: true });
    expect(details?.nativeStart).not.toBe(true); expect(details?.nativeRevision).toBeUndefined();
    expect(await host.goal!("fixture", { allowTimeline: false, inspectOmp: true })).toMatchObject({ state: "unknown" });
    expect(f.timeline).not.toHaveBeenCalled();
  });
  it("소유 연결이 네이티브 Goal 없음을 확인한 경우에만 Start goal을 제공한다", async () => {
    const f = ompFixture(), empty = ompNativeDetails("native-fixture", { goal: null, state: null });
    f.native.mockResolvedValue(empty); host = await openLocalHost(home, process.pid);
    expect(await host.goalDetails!("fixture", { allowTimeline: false })).toMatchObject({ objective: f.previous.objective, nativeStart: true, nativeRevision: empty.revision });
    expect(f.timeline).not.toHaveBeenCalled();
  });
  it("연결이 끊겨도 저장된 네이티브 Goal은 재생성 후보로 낮추지 않는다", async () => {
    const f = ompFixture(); f.saved.mockResolvedValue({ ...f.previous, sessionControls: false, identity: "native-id",
      reading: { ...f.previous.reading, nativeContinuation: true } });
    host = await openLocalHost(home, process.pid);
    const details = await host.goalDetails!("fixture", { allowTimeline: false });
    expect(details).toMatchObject({ identity: "native-id", reading: { state: "active", nativeContinuation: true }, nativeControls: true });
    expect(details?.nativeStart).not.toBe(true); expect(f.timeline).not.toHaveBeenCalled();
  });
  it("불완전한 네이티브 상태도 빈 Goal로 추정하지 않는다", async () => {
    const f = ompFixture(); f.native.mockResolvedValue({ ...f.previous, objective: null, reading: { source: "omp", state: "unknown", key: null, evidence: true }, sessionControls: false });
    host = await openLocalHost(home, process.pid);
    expect(await host.goalDetails!("fixture", { allowTimeline: false })).toMatchObject({ objective: null, reading: { state: "unknown" } });
    expect((await host.goalDetails!("fixture", { allowTimeline: false }))?.nativeStart).not.toBe(true);
  });
});
describe("다중 제공자의 네이티브 Goal 편집", () => {
  for (const source of ["opencode", "claude"] as const) {
    function providerFixture() {
      const agent = { id: "fixture", title: "Fixture", provider: source, labels: {}, workspaceId: "background-space", persistence: { sessionId: "native-fixture" },
        status: "idle", activeTurn: null as null | { turnId: string }, pendingPermissions: [], archivedAt: null, lastUserMessageAt: null };
      vi.mocked(DaemonClient.prototype.getLastServerInfoMessage).mockReturnValue({ serverId: "scope-test", version, features: { backgroundWorkspaces: true, agentRequestReceipts: true } } as Info);
      vi.spyOn(DaemonClient.prototype, "fetchAgent").mockImplementation(async () => ({ agent: structuredClone(agent), project: null }) as unknown as NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>);
      const registration = { name: "goal", kind: source === "claude" ? "skill" as const : "command" as const,
        description: source === "claude" ? "Set a goal — keep working until the condition is met" : "Set a session-scoped goal and auto-continue until complete.", argumentHint: "" };
      const commands = vi.spyOn(DaemonClient.prototype, "listCommands").mockResolvedValue({ agentId: "fixture", commands: [registration], error: null, requestId: "fixture" });
      const details = { reading: { state: "active" as const, key: "original", evidence: true, source }, objective: "Original fixture", revision: "native", tokenBudget: null, tokensUsed: null };
      vi.spyOn(OpenCodeGoals.prototype, "details").mockResolvedValue(source === "opencode" ? details : null);
      vi.spyOn(ClaudeGoals.prototype, "details").mockResolvedValue(source === "claude" ? details : null);
      const edit = source === "opencode" ? vi.spyOn(OpenCodeGoals.prototype, "edit") : vi.spyOn(ClaudeGoals.prototype, "edit");
      edit.mockImplementation(async (_agent, _revision, _objective, guard, submit) => { guard(); await submit(); return { state: "active", key: "edited", evidence: true, source }; });
      const send = vi.spyOn(DaemonClient.prototype, "sendAgentMessage").mockResolvedValue(undefined);
      return { agent, commands, edit, send };
    }
    it(`${source}의 저장은 소유 연결에서 한 번 전송하고 따옴표와 줄바꿈을 보존한다`, async () => {
      const f = providerFixture(); host = await openLocalHost(home, process.pid); const expected = (await host.fetch("fixture"))!, submitted = vi.fn();
      const text = '"Quoted objective"\nKeep the evidence.';
      await expect(host.editGoal!("fixture", "native", text, expected, () => {}, "owned-edit", submitted)).resolves.toMatchObject({ source });
      expect(f.send).toHaveBeenCalledExactlyOnceWith("fixture", source === "opencode" ? `/goal edit "${text}"` : `/goal ${text}`, { messageId: "owned-edit", activeTurnBehavior: "steer" }); expect(submitted).toHaveBeenCalledOnce();
    });
    it(`${source}의 실행 중이거나 저장 직전에 새 턴이 시작되면 전송하지 않는다`, async () => {
      const f = providerFixture(); host = await openLocalHost(home, process.pid); const expected = (await host.fetch("fixture"))!, submitted = vi.fn();
      f.agent.status = "running"; f.agent.activeTurn = { turnId: "started" };
      await expect(host.editGoal!("fixture", "native", "Edited fixture", expected, () => {}, "owned-edit", submitted)).rejects.toThrow(/session changed/);
      f.agent.status = "idle"; f.agent.activeTurn = null;
      f.edit.mockImplementationOnce(async (_agent, _revision, _objective, _guard, submit) => { f.agent.status = "running"; f.agent.activeTurn = { turnId: "race" }; await submit(); return { state: "active", key: "edited", evidence: true, source }; });
      await expect(host.editGoal!("fixture", "native", "Edited fixture", expected, () => {}, "owned-edit", submitted)).rejects.toThrow(/session changed/);
      expect(f.send).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled();
    });
  }
});
describe("네이티브 Goal 일시정지와 재개 전달", () => {
  function controlFixture(source: "codex" | "opencode" | "claude") {
    const agent = { id: "fixture", title: "Fixture", provider: source, labels: {}, workspaceId: "background-space", persistence: { sessionId: "native-fixture" },
      status: "idle", activeTurn: null as null | { turnId: string }, pendingPermissions: [], archivedAt: null, lastUserMessageAt: null };
    vi.mocked(DaemonClient.prototype.getLastServerInfoMessage).mockReturnValue({ serverId: "scope-test", version, features: { backgroundWorkspaces: true, agentRequestReceipts: true } } as Info);
    vi.spyOn(DaemonClient.prototype, "fetchAgent").mockImplementation(async () => ({ agent: structuredClone(agent), project: null }) as unknown as NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>);
    const descriptions = { codex: "Set, pause, resume, or clear the agent's goal", opencode: "Set a session-scoped goal and auto-continue until complete.", claude: "Set a goal — keep working until the condition is met" };
    vi.spyOn(DaemonClient.prototype, "listCommands").mockResolvedValue({ agentId: "fixture", commands: [{ name: "goal", kind: source === "claude" ? "skill" : "command", description: descriptions[source], argumentHint: "" }], error: null, requestId: "fixture" });
    const details = { reading: { state: "active" as const, key: "original", evidence: true, source }, objective: "Fixture", revision: "native", tokenBudget: 100, tokensUsed: 3 };
    vi.spyOn(OpenCodeGoals.prototype, "details").mockResolvedValue(source === "opencode" ? details : null);
    vi.spyOn(ClaudeGoals.prototype, "details").mockResolvedValue(source === "claude" ? details : null);
    vi.spyOn(CodexGoals.prototype, "details").mockResolvedValue(details);
    const send = vi.spyOn(DaemonClient.prototype, "sendAgentMessage").mockResolvedValue(undefined);
    return { agent, send };
  }
  it.each(["codex", "opencode"] as const)("%s는 Goal 제어를 소유 연결로 한 번 전송한다", async (source) => {
    const f = controlFixture(source);
    const control = source === "codex" ? vi.spyOn(CodexGoals.prototype, "control") : vi.spyOn(OpenCodeGoals.prototype, "control");
    control.mockImplementation(async (...args: unknown[]) => { const guard = args.at(-2) as () => void, submit = args.at(-1) as () => Promise<void>; guard(); await submit(); return { state: "paused", key: "original", evidence: true, source }; });
    host = await openLocalHost(home, process.pid); const expected = (await host.fetch("fixture"))!, submitted = vi.fn();
    await expect(host.controlGoal!("fixture", "native", "pause", expected, () => {}, "owned-control", submitted)).resolves.toMatchObject({ state: "paused" });
    expect(f.send).toHaveBeenCalledExactlyOnceWith("fixture", "/goal pause", { messageId: "owned-control", activeTurnBehavior: "steer" }); expect(submitted).toHaveBeenCalledOnce();
  });
  it("Claude에는 pause를 목표 본문으로 전송하지 않는다", async () => {
    const f = controlFixture("claude"); host = await openLocalHost(home, process.pid);
    await expect(host.controlGoal!("fixture", "native", "pause", (await host.fetch("fixture"))!, () => {}, "not-sent", vi.fn())).rejects.toThrow(/does not expose/); expect(f.send).not.toHaveBeenCalled();
  });
  it("OpenCode 턴이 진행 중이면 명령을 보내지 않는다", async () => {
    const f = controlFixture("opencode"); f.agent.status = "running"; f.agent.activeTurn = { turnId: "ongoing" }; host = await openLocalHost(home, process.pid);
    await expect(host.controlGoal!("fixture", "native", "pause", (await host.fetch("fixture"))!, () => {}, "not-sent", vi.fn())).rejects.toThrow(/session changed/); expect(f.send).not.toHaveBeenCalled();
  });
});
afterEach(async () => { await host?.close(); host = undefined; vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

describe("recovery host compatibility", () => {
  it("resolves an observed session's background workspace through the real SDK ref", async () => {
    host = await openLocalHost(home, process.pid);
    expect(await host.workspace("background-space")).toEqual({ id: "background-space", archived: false, archiving: false });
  });
  it("continues to resolve workspaces on 0.11 without background queries", async () => {
    version = "0.11.4"; background = false;
    host = await openLocalHost(home, process.pid);
    expect(await host.workspace("public-space")).toEqual({ id: "public-space", archived: false, archiving: false });
  });
  it("preserves graceful shutdown detection on supported 0.12 hosts", async () => {
    host = await openLocalHost(home, process.pid);
    expect(await host.shuttingDown()).toBe(false);
    await unlink(join(home, "local-credential"));
    expect(await host.shuttingDown()).toBe(true);
  });
  it("rejects a 0.12 host that cannot expose background workspaces", async () => {
    background = false;
    await expect(openLocalHost(home, process.pid)).rejects.toThrow(/background workspace/);
    expect(DaemonClient.prototype.fetchWorkspaces).not.toHaveBeenCalled();
    await expect(access(join(home, "plugin-data", "session-recovery", "worker.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("native Codex goal commands", () => {
  function nativeFixture() {
    vi.mocked(DaemonClient.prototype.getLastServerInfoMessage).mockReturnValue({ serverId: "scope-test", version, features: { backgroundWorkspaces: background, agentRequestReceipts: true } } as Info);
    const agent = { id: "fixture", title: "Fixture", provider: "codex", labels: {} as Record<string, string>, workspaceId: "background-space",
      persistence: { sessionId: "native-fixture" }, status: "running", activeTurn: undefined as { turnId: string } | null | undefined,
      pendingPermissions: [] as unknown[], archivedAt: null as string | null, lastUserMessageAt: null as string | null,
      attentionReason: null as string | null, attentionTimestamp: null as string | null, internal: false };
    vi.spyOn(DaemonClient.prototype, "fetchAgent").mockImplementation(async () => ({ agent: structuredClone(agent), project: null }) as unknown as NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>);
    const send = vi.spyOn(DaemonClient.prototype, "sendAgentMessage").mockResolvedValue(undefined);
    const commands = vi.spyOn(DaemonClient.prototype, "listCommands").mockResolvedValue({ agentId: "fixture", commands: [{ name: "goal", kind: "command", description: "Set, pause, resume, or clear the agent's goal", argumentHint: "[<objective>|pause|resume|clear]" }], error: null, requestId: "fixture" });
    vi.spyOn(CodexGoals.prototype, "resumeBlocked").mockImplementation(async (_provider, _thread, key, guard, submit) => { guard(); await submit(); return { state: "active", key, evidence: true, source: "codex" }; });
    vi.spyOn(CodexGoals.prototype, "details").mockResolvedValue({ reading: { state: "active", key: "original-goal", evidence: true, source: "codex" }, objective: "Original fixture", revision: "revision", tokenBudget: 100, tokensUsed: 1 });
    return { agent, send, commands };
  }
  it.each(["initial", "final"])("allows refreshed presentation and turn metadata at the %s native command check", async (stage) => {
    const f = nativeFixture(); host = await openLocalHost(home, process.pid); const expected = await host.fetch("fixture");
    const update = () => { f.agent.title = "Updated fixture title"; f.agent.status = "idle"; f.agent.activeTurn = null;
      f.agent.attentionReason = "finished"; f.agent.attentionTimestamp = "2026-10-20T00:00:00Z"; };
    if (stage === "initial") update();
    else f.commands.mockImplementationOnce(async () => { update(); return { agentId: "fixture", commands: [{ name: "goal", kind: "command", description: "Set, pause, resume, or clear the agent's goal", argumentHint: "" }], error: null, requestId: "fixture" }; });
    await expect(host.resumeBlockedGoal!("fixture", "current-goal", expected!, () => {}, "fixture-resume-message")).resolves.toMatchObject({ state: "active" });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it.each(["initial", "final"])("rejects protected session changes at the %s native command check", async (stage) => {
    const f = nativeFixture(); host = await openLocalHost(home, process.pid); const expected = await host.fetch("fixture");
    const variants = [
      { id: "another-agent" }, { provider: "another-provider" }, { workspaceId: "another-space" },
      { labels: { "paseo.parent-agent-id": "another-parent" } }, { persistence: { sessionId: "another-native-thread" } },
      { lastUserMessageAt: "2026-10-20T00:00:01Z" }, { pendingPermissions: [{}] }, { archivedAt: "2026-10-20T00:00:01Z" },
      { internal: true }, { status: "initializing" },
    ];
    const original = structuredClone(f.agent);
    for (const change of variants) {
      Object.assign(f.agent, original);
      if (stage === "initial") Object.assign(f.agent, change);
      else f.commands.mockImplementationOnce(async () => { Object.assign(f.agent, change); return { agentId: "fixture", commands: [{ name: "goal", kind: "command", description: "Set, pause, resume, or clear the agent's goal", argumentHint: "" }], error: null, requestId: "fixture" }; });
      const submitted = vi.fn();
      await expect(host.resumeBlockedGoal!("fixture", "current-goal", expected!, () => {}, "fixture-resume-message", submitted)).rejects.toThrow(/session changed/);
      expect(submitted).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    }
  });
  it("keeps the full snapshot check for ordinary continuation messages", async () => {
    const f = nativeFixture(); f.agent.status = "idle"; f.agent.activeTurn = null;
    host = await openLocalHost(home, process.pid); const expected = await host.fetch("fixture"); f.agent.title = "Changed title";
    await expect(host.send("fixture", "Continue", "fixture-message", expected!, () => {})).rejects.toThrow(/session changed/);
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([true, false])("sends a native resume during a running turn, turn ID present: %s", async (hasTurn) => {
    vi.mocked(DaemonClient.prototype.getLastServerInfoMessage).mockReturnValue({ serverId: "scope-test", version, features: { backgroundWorkspaces: background, agentRequestReceipts: true } } as Info);
    vi.spyOn(DaemonClient.prototype, "fetchAgent").mockResolvedValue({ agent: { id: "fixture", title: "Fixture", provider: "codex", labels: {},
      workspaceId: "background-space", persistence: { sessionId: "native-fixture" }, status: "running", activeTurn: hasTurn ? { turnId: "current-turn" } : undefined, pendingPermissions: [], lastUserMessageAt: null }, project: null } as unknown as NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>);
    const send = vi.spyOn(DaemonClient.prototype, "sendAgentMessage").mockResolvedValue(undefined);
    vi.spyOn(DaemonClient.prototype, "listCommands").mockResolvedValue({ agentId: "fixture", commands: [{ name: "goal", kind: "command", description: "Set, pause, resume, or clear the agent's goal", argumentHint: "[<objective>|pause|resume|clear]" }], error: null, requestId: "fixture" });
    vi.spyOn(CodexGoals.prototype, "resumeBlocked").mockImplementation(async (_provider, _thread, key, guard, submit) => { guard(); await submit(); return { state: "active", key, evidence: true, source: "codex" }; });
    host = await openLocalHost(home, process.pid); const agent = await host.fetch("fixture");
    expect(agent).toMatchObject({ status: "running", activeTurn: hasTurn ? "current-turn" : undefined });
    expect(await host.resumeBlockedGoal!("fixture", "current-goal", agent!, () => {}, "fixture-resume-message")).toMatchObject({ state: "active", key: "current-goal" });
    expect(send).toHaveBeenCalledExactlyOnceWith("fixture", "/goal resume", { messageId: "fixture-resume-message", activeTurnBehavior: "steer" });
    expect(await host.fetch("fixture")).toMatchObject({ status: "running", activeTurn: hasTurn ? "current-turn" : undefined });
  });
  it("requires the native goal registration, rather than an unrelated goal skill", async () => {
    const commands = vi.spyOn(DaemonClient.prototype, "listCommands").mockResolvedValue({ agentId: "fixture", commands: [], error: null, requestId: "fixture" });
    host = await openLocalHost(home, process.pid); expect(await host.supportsGoalCommand!("fixture")).toBe(false);
    commands.mockResolvedValue({ agentId: "fixture", commands: [{ name: "goal", kind: "skill", description: "A custom goal skill", argumentHint: "" }], error: null, requestId: "fixture" });
    expect(await host.supportsGoalCommand!("fixture")).toBe(false);
  });
  it("목표 본문 변경도 대화를 소유한 Paseo의 네이티브 명령으로 한 번 전송한다", async () => {
    const f = nativeFixture();
    vi.spyOn(CodexGoals.prototype, "edit").mockImplementation(async (_provider, _thread, _revision, _objective, guard, submit) => { guard(); await submit(); return { state: "active", key: "edited-goal", evidence: true, source: "codex" }; });
    host = await openLocalHost(home, process.pid); const expected = await host.fetch("fixture"), submitted = vi.fn();
    await expect(host.editGoal!("fixture", "revision", "Edited fixture", expected!, () => {}, "fixture-edit", submitted)).resolves.toMatchObject({ key: "edited-goal" });
    expect(f.send).toHaveBeenCalledExactlyOnceWith("fixture", "/goal Edited fixture", { messageId: "fixture-edit", activeTurnBehavior: "steer" });
    expect(submitted).toHaveBeenCalledOnce();
  });
  it("네이티브 저장 직전에 대화가 바뀌면 목표 변경을 전송하지 않는다", async () => {
    const f = nativeFixture();
    vi.spyOn(CodexGoals.prototype, "edit").mockImplementation(async (_provider, _thread, _revision, _objective, _guard, submit) => { f.agent.lastUserMessageAt = "2026-10-20T01:00:00Z"; await submit(); return { state: "active", key: "edited-goal", evidence: true }; });
    host = await openLocalHost(home, process.pid); const expected = await host.fetch("fixture"), submitted = vi.fn();
    await expect(host.editGoal!("fixture", "revision", "Edited fixture", expected!, () => {}, "fixture-edit", submitted)).rejects.toThrow(/session changed/);
    expect(f.send).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled();
  });
});

describe("conversation goal lookup", () => {
  function page(entries: Array<{ seqStart: number; seqEnd?: number; item: unknown }>, older = false) {
    return { requestId: "test", agentId: "fixture", agent: null, direction: "tail", projection: "canonical", epoch: "timeline-epoch", reset: false, staleCursor: false, gap: false,
      startCursor: { epoch: "timeline-epoch", seq: entries[0]?.seqStart ?? 0 }, endCursor: { epoch: "timeline-epoch", seq: entries.at(-1)?.seqStart ?? 0 }, hasOlder: older, hasNewer: false, entries: entries.map((e) => ({ seqEnd: e.seqStart, ...e })), error: null,
    } as Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>;
  }
  function goalTool(name: string, output: unknown) { return { type: "tool_call", name, status: "completed", callId: name, detail: { type: "unknown", input: {}, output } }; }
  beforeEach(() => {
    vi.spyOn(DaemonClient.prototype, "fetchAgent").mockResolvedValue({ agent: { id: "fixture", provider: "omp", labels: {}, persistence: null } } as NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>);
  });
  it.each([false, true])("자동 발견 조회는 OMP 대화를 복원하지 않는다. 하위 대화: %s", async (child) => {
    vi.mocked(DaemonClient.prototype.fetchAgent).mockResolvedValue({ agent: { id: "fixture", provider: "omp", labels: child ? { "paseo.parent-agent-id": "parent" } : {}, persistence: { sessionId: "stored-session" } } } as NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>);
    vi.spyOn(OpenCodeGoals.prototype, "read").mockResolvedValue(null);
    vi.spyOn(CodexGoals.prototype, "read").mockResolvedValue(null);
    const timeline = vi.spyOn(DaemonClient.prototype, "fetchAgentTimeline").mockRejectedValue(new Error("대화 복원이 실행되면 안 된다"));
    host = await openLocalHost(home, process.pid);
    expect(await host.goal!("fixture", { allowTimeline: false })).toEqual({ state: "unknown", key: null, evidence: false, source: "timeline" });
    expect(timeline).not.toHaveBeenCalled();
  });
  it("자동 발견 조회에서도 네이티브 Codex Goal을 읽는다", async () => {
    vi.mocked(DaemonClient.prototype.fetchAgent).mockResolvedValue({ agent: { id: "fixture", provider: "codex", labels: {}, persistence: { sessionId: "native-session" } } } as NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>);
    vi.spyOn(OpenCodeGoals.prototype, "read").mockResolvedValue(null);
    const reading = { state: "active" as const, key: "native-goal", evidence: true, source: "codex" as const };
    vi.spyOn(CodexGoals.prototype, "read").mockResolvedValue(reading);
    const timeline = vi.spyOn(DaemonClient.prototype, "fetchAgentTimeline");
    host = await openLocalHost(home, process.pid);
    expect(await host.goal!("fixture", { allowTimeline: false })).toEqual(reading);
    expect(timeline).not.toHaveBeenCalled();
  });
  it("finds the objective across canonical pages without dropping later status changes", async () => {
    const tail = page([{ seqStart: 201, item: goalTool("get_goal", { status: "active" }) }], true);
    const older = { ...page([{ seqStart: 1, item: goalTool("create_goal", { objective: "Fixture goal", status: "active" }) }]), hasNewer: true };
    const timeline = vi.spyOn(DaemonClient.prototype, "fetchAgentTimeline").mockResolvedValueOnce(tail).mockResolvedValueOnce(older);
    host = await openLocalHost(home, process.pid);
    expect(await host.goal!("fixture")).toEqual({ state: "active", evidence: true, key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(timeline).toHaveBeenLastCalledWith("fixture", { projection: "canonical", direction: "before", cursor: tail.startCursor, limit: 200 });
  });
  it("fails closed when the timeline changes epoch between pages", async () => {
    vi.spyOn(DaemonClient.prototype, "fetchAgentTimeline").mockResolvedValueOnce(page([{ seqStart: 201, item: { type: "assistant_message", text: "Fixture" } }], true))
      .mockResolvedValueOnce({ ...page([{ seqStart: 1, item: goalTool("create_goal", { objective: "Fixture goal", status: "active" }) }]), epoch: "changed" });
    host = await openLocalHost(home, process.pid);
    expect((await host.goal!("fixture")).state).toBe("unknown");
  });
  it("does not read older pages after finding a completed goal", async () => {
    const timeline = vi.spyOn(DaemonClient.prototype, "fetchAgentTimeline").mockResolvedValue(page([{ seqStart: 201, item: goalTool("update_goal", { status: "complete" }) }], true));
    host = await openLocalHost(home, process.pid);
    expect((await host.goal!("fixture")).state).toBe("complete"); expect(timeline).toHaveBeenCalledTimes(1);
  });
  it("orders updated tool rows by their final sequence instead of their original start", async () => {
    vi.spyOn(DaemonClient.prototype, "fetchAgentTimeline").mockResolvedValue(page([
      { seqStart: 1, seqEnd: 4, item: { ...goalTool("omp_goal_updated", null), detail: { type: "plain_text", text: "Fixture goal\nStatus: complete" }, metadata: { synthetic: true, source: "omp_goal_updated", goalStatus: "complete" } } },
      { seqStart: 2, seqEnd: 3, item: goalTool("goal", { details: { goal: { objective: "Fixture goal", status: "active" } } }) },
    ]));
    host = await openLocalHost(home, process.pid);
    expect((await host.goal!("fixture")).state).toBe("complete");
  });
  it("uses the OpenCode mode adapter before conversation tools, including when the native goal is paused", async () => {
    const reading = { state: "paused" as const, key: "native-goal", evidence: true, modeId: "goal", source: "opencode" as const };
    vi.spyOn(OpenCodeGoals.prototype, "read").mockResolvedValue(reading);
    const timeline = vi.spyOn(DaemonClient.prototype, "fetchAgentTimeline");
    host = await openLocalHost(home, process.pid);
    expect(await host.goal!("fixture")).toEqual(reading); expect(timeline).not.toHaveBeenCalled();
  });
});
