import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { openLocalHost, type RecoveryHost } from "./host";
import { OpenCodeGoals } from "./opencode-goals";
import { CodexGoals } from "./codex-goals";

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
  it.each([true, false])("sends a native resume during a running turn, turn ID present: %s", async (hasTurn) => {
    vi.mocked(DaemonClient.prototype.getLastServerInfoMessage).mockReturnValue({ serverId: "scope-test", version, features: { backgroundWorkspaces: background, agentRequestReceipts: true } } as Info);
    vi.spyOn(DaemonClient.prototype, "fetchAgent").mockResolvedValue({ agent: { id: "fixture", title: "Fixture", provider: "codex", labels: {},
      workspaceId: "background-space", persistence: { sessionId: "native-fixture" }, status: "running", activeTurn: hasTurn ? { turnId: "current-turn" } : undefined, pendingPermissions: [], lastUserMessageAt: null }, project: null } as unknown as NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>);
    const send = vi.spyOn(DaemonClient.prototype, "sendAgentMessage").mockResolvedValue(undefined);
    vi.spyOn(CodexGoals.prototype, "resumeBlocked").mockImplementation(async (_provider, _thread, key, guard, submit) => { guard(); await submit(); return { state: "active", key, evidence: true, source: "codex" }; });
    host = await openLocalHost(home, process.pid); const agent = await host.fetch("fixture");
    expect(agent).toMatchObject({ status: "running", activeTurn: hasTurn ? "current-turn" : undefined });
    expect(await host.resumeBlockedGoal!("fixture", "current-goal", agent!, () => {}, "fixture-resume-message")).toMatchObject({ state: "active", key: "current-goal" });
    expect(send).toHaveBeenCalledExactlyOnceWith("fixture", "/goal resume", { messageId: "fixture-resume-message", activeTurnBehavior: "steer" });
    expect(await host.fetch("fixture")).toMatchObject({ status: "running", activeTurn: hasTurn ? "current-turn" : undefined });
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
