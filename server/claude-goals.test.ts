import type { PaseoAgent } from "@getpaseo/client";
import { mkdir, mkdtemp, lstat, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeGoals, claudeEnvironment, claudeProjectName, readClaudeGoal } from "./claude-goals";

const sessionId = "00000000-0000-4000-8000-000000000001";
const event = (uuid = "goal-1", parentUuid: string | null = null, patch: Record<string, unknown> = {}) => ({
  type: "attachment", sessionId, uuid, parentUuid, isSidechain: false,
  attachment: { type: "goal_status", condition: "Original fixture", met: false, sentinel: true, ...patch },
});
const lines = (...entries: unknown[]) => entries.map(e => JSON.stringify(e) + "\n").join("");

describe("Claude 네이티브 Goal 기록", () => {
  it("별도 목표 예산을 만들지 않고 공식 goal_status attachment만 읽는다", () => {
    const details = readClaudeGoal(lines(event()), sessionId);
    expect(details).toMatchObject({ objective: "Original fixture", tokenBudget: null, tokensUsed: null, reading: { state: "active", source: "claude", nativeContinuation: true } });
    const quoted = { type: "user", uuid: "user", parentUuid: null, sessionId, message: { content: JSON.stringify(event()) } };
    expect(readClaudeGoal(lines(quoted), sessionId).reading).toMatchObject({ state: "cleared", evidence: false });
  });
  it("완료, 사용자 해제, 실패로 해제된 목표를 구별하고 재개하지 않는다", () => {
    expect(readClaudeGoal(lines(event("done", null, { met: true, sentinel: false, tokens: 40 })), sessionId)).toMatchObject({ tokensUsed: 40, reading: { state: "complete" } });
    expect(readClaudeGoal(lines(event("cleared", null, { met: true })), sessionId).reading.state).toBe("cleared");
    expect(readClaudeGoal(lines(event("failed", null, { failed: true })), sessionId).reading.state).toBe("cleared");
  });
  it("되감은 대화의 현재 parentUuid 연결을 따르고 버려진 가지나 하위 세션을 채택하지 않는다", () => {
    const old = event("old"), abandoned = event("abandoned", "old", { condition: "Abandoned objective" });
    const current = { type: "user", uuid: "current", parentUuid: "old", sessionId, message: { content: "Follow current branch" } };
    const sidechain = { ...event("child", "current", { condition: "Child objective" }), isSidechain: true };
    expect(readClaudeGoal(lines(old, abandoned, current, sidechain), sessionId).objective).toBe("Original fixture");
  });
  it("부모 연결 누락, 순환, 중복 ID, 불완전한 기록은 읽기 전용으로 닫는다", () => {
    const goal = event();
    for (const text of [lines(goal, { type: "user", uuid: "missing-parent", parentUuid: "missing", sessionId }), lines({ ...goal, type: "user", parentUuid: "goal-1" }), lines(goal, goal), lines(goal).trimEnd(), "{\n"]) {
      expect(readClaudeGoal(text, sessionId).reading.state).toBe("unknown");
    }
    expect(readClaudeGoal(lines(), sessionId, false).reading.state).toBe("unknown");
    expect(readClaudeGoal(lines(goal, { ...event("incomplete", "goal-1", { met: true }), parentUuid: undefined }), sessionId).reading.state).toBe("unknown");
  });
  it("다른 네이티브 세션과 malformed 상태를 목표로 읽지 않는다", () => {
    expect(readClaudeGoal(lines({ ...event(), sessionId: "other" }), sessionId).objective).toBeNull();
    for (const patch of [{ met: "false" }, { condition: "" }, { condition: "x".repeat(4001) }, { failed: "true" }]) {
      expect(readClaudeGoal(lines(event("invalid", null, patch)), sessionId).reading.state).toBe("unknown");
    }
  });
  it("같은 본문으로 재설정해도 이전 편집 revision을 재사용하지 않는다", () => {
    const before = readClaudeGoal(lines(event()), sessionId), after = readClaudeGoal(lines(event("goal-2")), sessionId);
    expect(after.reading.key).toBe(before.reading.key); expect(after.revision).not.toBe(before.revision);
  });
  it("다른 제공자의 상태를 읽지 않고 상속된 Claude 환경을 사용한다", () => {
    const config = { agents: { providers: { claude: { env: { EXAMPLE: "base" } }, custom: { extends: "claude", env: { CLAUDE_CONFIG_DIR: "/fixture" } }, cycle: { extends: "cycle" } } } };
    expect(claudeEnvironment(config, "custom")).toEqual({ EXAMPLE: "base", CLAUDE_CONFIG_DIR: "/fixture" });
    expect(claudeEnvironment(config, "opencode")).toBeNull(); expect(() => claudeEnvironment(config, "cycle")).toThrow(/inheritance/);
    expect(claudeProjectName("/fixture/project")).toBe("-fixture-project"); expect(claudeProjectName("/" + "a".repeat(220))).toMatch(/^-[a]{199}-[a-z0-9]+$/);
  });
});

describe("Claude 목표 조회와 변경", () => {
  let home: string, path: string, cwd: string, reader: ClaudeGoals, agent: PaseoAgent;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "recovery-claude-test-")); cwd = join(home, "fixture"); await mkdir(cwd);
    const configDir = join(home, "claude");
    await writeFile(join(home, "config.json"), JSON.stringify({ agents: { providers: { claude: { env: { CLAUDE_CONFIG_DIR: configDir } } } } }));
    path = join(configDir, "projects", "original-project", `${sessionId}.jsonl`); await mkdir(dirname(path), { recursive: true }); await writeFile(path, lines(event()));
    reader = new ClaudeGoals(home); agent = { provider: "claude", cwd, persistence: { sessionId } } as PaseoAgent;
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });
  it("이전 프로젝트 폴더의 동일 세션 기록을 읽되 파일을 쓰거나 프로세스를 만들지 않는다", async () => {
    const before = await readFile(path, "utf8"), info = await lstat(path);
    expect(await reader.details(agent)).toMatchObject({ objective: "Original fixture" });
    expect(await readFile(path, "utf8")).toBe(before); expect((await lstat(path)).mtimeMs).toBe(info.mtimeMs);
    expect(await reader.details({ ...agent, provider: "codex" })).toBeNull();
  });
  it("하나의 네이티브 전송 후 같은 세션의 새로운 Goal 기록을 확인한다", async () => {
    const before = (await reader.details(agent))!;
    const send = vi.fn(async () => { await writeFile(path, lines(event(), event("goal-2", "goal-1", { condition: "Edited fixture" }))); });
    expect(await reader.edit(agent, before.revision, "Edited fixture", () => {}, send)).toMatchObject({ state: "active", source: "claude" });
    expect(send).toHaveBeenCalledOnce();
  });
  it("저장 후 즉시 달성된 같은 목표도 네이티브 결과로 확인한다", async () => {
    const before = (await reader.details(agent))!;
    const send = async () => { await writeFile(path, lines(event("achieved", null, { condition: "Edited fixture", met: true, sentinel: false }))); };
    expect(await reader.edit(agent, before.revision, "Edited fixture", () => {}, send)).toMatchObject({ state: "complete" });
  });
  it.each(["clear", "STOP", "off", "reset", "none", "cancel", "x".repeat(4001)])("제어 명령 또는 길이 초과 %s는 전송하지 않는다", async (objective) => {
    const send = vi.fn(async () => {});
    await expect(reader.edit(agent, "unused", objective, () => {}, send)).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
  });
  it("교체된 목표, 사용자 해제, 실패와 변경 취소 뒤에는 전송하지 않는다", async () => {
    const before = (await reader.details(agent))!, send = vi.fn(async () => {});
    await expect(reader.edit(agent, before.revision, "Edited fixture", () => { throw new Error("Canceled"); }, send)).rejects.toThrow("Canceled");
    for (const patch of [{ condition: "Replacement fixture" }, { met: true }, { failed: true }]) {
      await writeFile(path, lines(event("goal-2", null, patch)));
      await expect(reader.edit(agent, before.revision, "Edited fixture", () => {}, send)).rejects.toThrow(/changed/);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("같은 본문의 저장은 Goal 카운터를 초기화하지 않고 유실된 응답은 재전송하지 않는다", async () => {
    const before = (await reader.details(agent))!, send = vi.fn(async () => { throw new Error("Receipt lost"); });
    expect(await reader.edit(agent, before.revision, before.objective!, () => {}, send)).toMatchObject({ state: "active" }); expect(send).not.toHaveBeenCalled();
    await expect(reader.edit(agent, before.revision, "Edited fixture", () => {}, send)).rejects.toThrow("Receipt lost"); expect(send).toHaveBeenCalledOnce();
  });
  it("심볼릭 링크, 중복 세션 파일, 과거로 잘린 기록은 읽기 전용이다", async () => {
    const moved = path + ".original"; await rename(path, moved); await symlink(moved, path);
    expect((await reader.details(agent))?.reading.state).toBe("unknown");
    await rm(path); await rename(moved, path);
    const duplicate = join(dirname(dirname(path)), "duplicate-project", `${sessionId}.jsonl`); await mkdir(dirname(duplicate)); await writeFile(duplicate, lines(event()));
    expect((await reader.details(agent))?.reading.state).toBe("unknown"); await rm(duplicate);
    await writeFile(path, lines(event()) + lines({ type: "user", uuid: "truncated", parentUuid: "missing", sessionId }));
    expect((await reader.details(agent))?.reading.state).toBe("unknown");
  });
});
