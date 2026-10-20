import type { PaseoAgent } from "@getpaseo/client";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeGoals, openCodeEnvironment, openCodeGoalMode, readOpenCodeGoal, openCodeGoalDetails } from "./opencode-goals";

const sessionId = "native-session";
const mode = { id: "goal", label: "Goal", description: "Execute an explicit user goal with persistent progress and evidence-gated completion." };
const goal = { sessionID: sessionId, condition: "Verify fixture results", focused: true, stopped: false, stopReason: "", turnCount: 1, totalTokens: 100,
  startedAt: 1000, options: { maxTurns: 10, maxTokens: 1000, maxDurationMs: 60000 } };
const snapshot = (goals: unknown[] = [goal], results: unknown[] = []) => ({ version: 1, goals, results });

describe("OpenCode native goal state", () => {
  it("uses the focused objective and keeps its body out of the reading", () => {
    const result = readOpenCodeGoal(snapshot([{ ...goal, focused: false, condition: "Background" }, goal]), sessionId, 2000);
    expect(result).toMatchObject({ state: "active", evidence: true, source: "opencode", key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(result)).not.toContain(goal.condition);
    expect(readOpenCodeGoal(snapshot([{ ...goal, condition: "Different objective" }]), sessionId, 2000).key).not.toBe(result.key);
  });
  it.each(["paused", "user intervention", "user interrupted", "recovered after restart", "audit rejected", "no progress"])("preserves native pause: %s", (stopReason) => {
    expect(readOpenCodeGoal(snapshot([{ ...goal, stopped: true, stopReason }]), sessionId, 2000)).toMatchObject({ state: "paused", key: expect.any(String) });
  });
  it("keeps a concrete blocker stopped", () => {
    expect(readOpenCodeGoal(snapshot([{ ...goal, stopped: true, stopReason: "blocked" }]), sessionId, 2000).state).toBe("blocked");
  });
  it.each([{ turnCount: 10 }, { totalTokens: 1000 }, { startedAt: 0 }])("does not exceed a native limit: %j", (change) => {
    expect(readOpenCodeGoal(snapshot([{ ...goal, ...change }]), sessionId, "startedAt" in change ? 60000 : 2000).state).toBe("limited");
  });
  it("일시 중지된 목표도 네이티브 예산이 소진됐으면 편집으로 재개하지 않는다", () => {
    expect(readOpenCodeGoal(snapshot([{ ...goal, stopped: true, stopReason: "paused", totalTokens: 1000 }]), sessionId, 2000).state).toBe("limited");
  });
  it("사용량 증가에는 편집을 유지하고 ID, 예산, 실행 창이나 상태 변경에는 만료시킨다", () => {
    const original = { ...goal, goalId: "owned-goal", runId: "original-run" };
    const before = openCodeGoalDetails(snapshot([original]), sessionId, 2000);
    expect(openCodeGoalDetails(snapshot([{ ...original, totalTokens: 101, turnCount: 2 }]), sessionId, 2000).revision).toBe(before.revision);
    for (const patch of [{ goalId: "replacement" }, { runId: "other-run" }, { startedAt: 1001 }, { stopped: true }, { options: { ...goal.options, maxTokens: 2000 } }]) {
      expect(openCodeGoalDetails(snapshot([{ ...original, ...patch }]), sessionId, 2000).revision).not.toBe(before.revision);
    }
  });
  it("recognizes completion without selecting the next objective in a sequence", () => {
    expect(readOpenCodeGoal(snapshot([], [{ sessionID: sessionId, condition: goal.condition, state: "achieved" }]), sessionId, 2000).state).toBe("complete");
    const old = readOpenCodeGoal(snapshot(), sessionId, 2000);
    const next = readOpenCodeGoal(snapshot([{ ...goal, condition: "Next queued objective" }]), sessionId, 2000);
    expect(next.key).not.toBe(old.key);
  });
  it("leaves native continuation claims and child-session guards to OpenCode", () => {
    for (const current of [{ ...goal, continuationClaim: { runId: "run", sourceAssistantMessageID: "source", compactionEpoch: 0 } }, { ...goal, options: { ...goal.options, noContinueWhileChildrenActive: true } }]) {
      expect(readOpenCodeGoal(snapshot([current]), sessionId, 2000)).toMatchObject({ state: "active", nativeContinuation: true });
    }
  });
  it("requires a supported state and an unambiguous focus", () => {
    for (const value of [{ ...snapshot(), version: 2 }, { version: 1, goals: [] }, snapshot([goal, goal]), snapshot([{ ...goal, focused: false }]), snapshot([{ ...goal, stopped: undefined }])]) {
      expect(readOpenCodeGoal(value, sessionId, 2000).state).toBe("unknown");
    }
    expect(readOpenCodeGoal(snapshot([{ ...goal, focused: undefined }]), sessionId, 2000).state).toBe("active");
    expect(readOpenCodeGoal(snapshot([{ ...goal, sessionID: "other-session" }]), sessionId, 2000)).toMatchObject({ state: "cleared", key: null });
  });
  it("does not treat the name Goal or a stale runtime mode as goal evidence", () => {
    expect(openCodeGoalMode({ currentModeId: "goal", availableModes: [{ ...mode, description: "Custom agent" }] })).toBeNull();
    expect(openCodeGoalMode({ currentModeId: "build", runtimeInfo: { provider: "opencode", sessionId, modeId: "goal" }, availableModes: [mode] })).toBeNull();
    expect(openCodeGoalMode({ currentModeId: null, runtimeInfo: { provider: "opencode", sessionId, modeId: "goal" }, availableModes: [mode] })).toBeNull();
    expect(openCodeGoalMode({ currentModeId: "custom-goal", availableModes: [{ ...mode, id: "custom-goal" }] })).toBe("custom-goal");
  });
  it("resolves custom OpenCode provider environments without adopting other providers", () => {
    const config = { agents: { providers: { opencode: { env: { OPENCODE_GOAL_STATE_PATH: "base.json", EXAMPLE: "base" } }, custom: { extends: "opencode", env: { OPENCODE_GOAL_STATE_PATH: "custom.json" } }, cycle: { extends: "cycle" } } } };
    expect(openCodeEnvironment(config, "custom")).toEqual({ OPENCODE_GOAL_STATE_PATH: "custom.json", EXAMPLE: "base" });
    expect(openCodeEnvironment(config, "codex")).toBeNull();
    expect(() => openCodeEnvironment(config, "cycle")).toThrow(/inheritance/);
  });
});

describe("read-only OpenCode goal snapshots", () => {
  let home: string, cwd: string, path: string, reader: OpenCodeGoals, agent: PaseoAgent;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "recovery-opencode-test-")); cwd = join(home, "project");
    path = join(cwd, ".opencode/goals/state.json.sessions", createHash("sha256").update(sessionId).digest("hex"), "state.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(join(home, "config.json"), "{}");
    await writeFile(path, JSON.stringify(snapshot([{ ...goal, goalId: "fixture-goal", startedAt: Date.now(), stopped: true, stopReason: "user intervention" }])));
    reader = new OpenCodeGoals(home);
    agent = { provider: "opencode", cwd, currentModeId: "goal", availableModes: [mode], persistence: { sessionId } } as PaseoAgent;
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });
  it("사용자가 요청한 재개만 새 네이티브 예산 창으로 확인한다", async () => {
    const before = await reader.details(agent), data = JSON.parse(await readFile(path, "utf8"));
    const send = vi.fn(async () => { data.goals[0] = { ...data.goals[0], stopped: false, stopReason: "", turnCount: 0, totalTokens: 0, startedAt: Date.now() + 1 }; await writeFile(path, JSON.stringify(data)); });
    expect(await reader.control(agent, before!.revision, "resume", () => {}, send)).toMatchObject({ state: "active", key: before!.reading.key });
    expect(send).toHaveBeenCalledOnce();
  });
  it("일시정지는 기존 예산 창과 사용량을 보존해야 한다", async () => {
    const data = JSON.parse(await readFile(path, "utf8")); data.goals[0].stopped = false; data.goals[0].stopReason = ""; await writeFile(path, JSON.stringify(data));
    const before = await reader.details(agent), send = vi.fn(async () => { data.goals[0].stopped = true; data.goals[0].stopReason = "paused"; await writeFile(path, JSON.stringify(data)); });
    expect(await reader.control(agent, before!.revision, "pause", () => {}, send)).toMatchObject({ state: "paused" }); expect(send).toHaveBeenCalledOnce();
    data.goals[0].stopped = false; await writeFile(path, JSON.stringify(data)); const current = await reader.details(agent);
    const reset = vi.fn(async () => { data.goals[0].stopped = true; data.goals[0].totalTokens = 0; await writeFile(path, JSON.stringify(data)); });
    await expect(reader.control(agent, current!.revision, "pause", () => {}, reset)).rejects.toThrow(/budget changed/);
  });
  it("다른 목표나 불확실한 제어를 재전송하지 않는다", async () => {
    const before = await reader.details(agent), send = vi.fn(async () => { throw new Error("Receipt lost"); });
    await expect(reader.control(agent, "old-revision", "resume", () => {}, send)).rejects.toThrow(/changed/); expect(send).not.toHaveBeenCalled();
    await expect(reader.control(agent, before!.revision, "resume", () => {}, send)).rejects.toThrow("Receipt lost"); expect(send).toHaveBeenCalledOnce();
  });
  it("reads the native session shard without changing its state or creating a lease", async () => {
    const before = await readFile(path, "utf8"), info = await lstat(path);
    expect(await reader.read(agent)).toMatchObject({ state: "paused", modeId: "goal", key: expect.any(String) });
    expect(await readFile(path, "utf8")).toBe(before); expect((await lstat(path)).mtimeMs).toBe(info.mtimeMs);
    await expect(lstat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("복원하지 않은 대화의 빈 모드 목록에서도 세션별 Goal 스냅샷을 확인한다", async () => {
    expect(await reader.read({ ...agent, availableModes: [] })).toMatchObject({ state: "paused", modeId: "goal", key: expect.any(String) });
    expect(await reader.read({ ...agent, availableModes: [{ ...mode, description: "Unrelated custom mode" }] })).toMatchObject({ state: "cleared", key: null });
    await rm(path);
    expect(await reader.read({ ...agent, availableModes: [] })).toMatchObject({ state: "unknown", key: null });
  });
  it("hides the goal when leaving Goal mode, regardless of stale goal tools", async () => {
    expect(await reader.read({ ...agent, currentModeId: "build" })).toMatchObject({ state: "cleared", key: null });
    expect(await reader.read({ ...agent, provider: "omp" })).toBeNull();
  });
  it("honors OPENCODE_GOAL_STATE_PATH on a custom OpenCode provider", async () => {
    await writeFile(join(home, "config.json"), JSON.stringify({ agents: { providers: { custom: { extends: "opencode", env: { OPENCODE_GOAL_STATE_PATH: "alternate.json" } } } } }));
    const custom = join(cwd, "alternate.json.sessions", createHash("sha256").update(sessionId).digest("hex"), "state.json");
    await mkdir(dirname(custom), { recursive: true }); await writeFile(custom, JSON.stringify(snapshot()));
    expect(await reader.read({ ...agent, provider: "custom" })).toMatchObject({ key: expect.any(String), modeId: "goal" });
  });
  it("fails closed for missing, malformed, oversized, or symlinked snapshots", async () => {
    for (const content of ["{", " ".repeat(2 * 1024 * 1024 + 1)]) {
      await writeFile(path, content); expect((await reader.read(agent))?.state).toBe("unknown");
    }
    await rm(path); expect((await reader.read(agent))?.state).toBe("unknown");
    const target = join(home, "target.json"); await writeFile(target, JSON.stringify(snapshot())); await symlink(target, path);
    expect((await reader.read(agent))?.state).toBe("unknown");
  });
  it("does not act on a snapshot older than a native lifecycle ledger", async () => {
    const ledger = `${path}.ledger.jsonl`;
    await writeFile(ledger, '{"type":"completed"}\n');
    const future = new Date(Date.now() + 10000); await utimes(ledger, future, future);
    expect((await reader.read(agent))?.state).toBe("unknown");
  });
  it("현재 Goal의 예산과 ID를 유지한 네이티브 변경만 확인한다", async () => {
    const before = (await reader.details(agent))!, native = JSON.parse(await readFile(path, "utf8"));
    const send = vi.fn(async () => {
      native.goals[0] = { ...native.goals[0], condition: "Edited fixture", stopped: false, stopReason: "", totalTokens: 101, turnCount: 2 };
      await writeFile(path, JSON.stringify(native));
    });
    expect(await reader.edit(agent, before.revision, "Edited fixture", () => {}, send)).toMatchObject({ state: "active", source: "opencode" });
    expect(send).toHaveBeenCalledOnce(); expect((await reader.details(agent))?.tokenBudget).toBe(1000);
  });
  it("오래된 편집, 한도 소진, 다른 모드에서는 전송하지 않는다", async () => {
    const before = (await reader.details(agent))!, native = JSON.parse(await readFile(path, "utf8")), send = vi.fn(async () => {});
    await expect(reader.edit(agent, "stale", "Edited fixture", () => {}, send)).rejects.toThrow(/changed/);
    native.goals[0].totalTokens = 1000; await writeFile(path, JSON.stringify(native));
    await expect(reader.edit(agent, (await reader.details(agent))!.revision, "Edited fixture", () => {}, send)).rejects.toThrow(/limits/);
    await expect(reader.edit({ ...agent, currentModeId: "build" }, before.revision, "Edited fixture", () => {}, send)).rejects.toThrow(/changed/);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["goalId", "startedAt", "options", "totalTokens", "turnCount"])("네이티브 편집의 %s 초기화나 교체를 성공으로 보고하지 않는다", async (field) => {
    const before = (await reader.details(agent))!, native = JSON.parse(await readFile(path, "utf8"));
    const send = vi.fn(async () => {
      native.goals[0] = { ...native.goals[0], condition: "Edited fixture", stopped: false, stopReason: "",
        [field]: field === "goalId" ? "recreated" : field === "options" ? { ...goal.options, maxTokens: 2000 } : 0 };
      await writeFile(path, JSON.stringify(native));
    });
    await expect(reader.edit(agent, before.revision, "Edited fixture", () => {}, send)).rejects.toThrow(/budget changed/);
    expect(send).toHaveBeenCalledOnce();
  });
  it("확인되지 않은 편집은 자동 재전송하지 않는다", async () => {
    const before = (await reader.details(agent))!, send = vi.fn(async () => { throw new Error("Receipt lost"); });
    await expect(reader.edit(agent, before.revision, "Edited fixture", () => {}, send)).rejects.toThrow("Receipt lost");
    expect(send).toHaveBeenCalledOnce();
  });
});
