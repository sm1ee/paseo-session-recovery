import type { PaseoAgent } from "@getpaseo/client";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenCodeGoals, openCodeEnvironment, openCodeGoalMode, readOpenCodeGoal } from "./opencode-goals";

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
    await writeFile(path, JSON.stringify(snapshot([{ ...goal, stopped: true, stopReason: "user intervention" }])));
    reader = new OpenCodeGoals(home);
    agent = { provider: "opencode", cwd, currentModeId: "goal", availableModes: [mode], persistence: { sessionId } } as PaseoAgent;
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });
  it("reads the native session shard without changing its state or creating a lease", async () => {
    const before = await readFile(path, "utf8"), info = await lstat(path);
    expect(await reader.read(agent)).toMatchObject({ state: "paused", modeId: "goal", key: expect.any(String) });
    expect(await readFile(path, "utf8")).toBe(before); expect((await lstat(path)).mtimeMs).toBe(info.mtimeMs);
    await expect(lstat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
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
});
