import type { PaseoAgent } from "@getpaseo/client";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOAL_PROMPT } from "../shared/contracts";
import { OmpGoals, readOmpGoal } from "./omp-goals";

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof fs>();
  return { ...real, open: vi.fn(real.open) };
});

const session = "native-session";
const header = { type: "session", version: 3, id: session };
const user = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] } });
const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e) + "\n").join("");
const native = (id = "goal", parentId: string | null = null, status = "active") => ({ type: "mode_change", id, parentId, mode: "goal", data: { goal: { id: "native-goal", objective: "Native fixture", status, tokenBudget: 100, tokensUsed: 30, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 } } });

describe("OMP 목표를 소유 세션 기록에서 읽기", () => {
  it("일반 대화나 할 일을 Goal로 추정하지 않고 명시적인 사용자 /goal만 추적한다", () => {
    expect(readOmpGoal(lines(header, user("one", null, "Please inspect /goal or a Goal todo")), session)).toMatchObject({ objective: null, reading: { state: "cleared", evidence: false } });
    const view = readOmpGoal(lines({ type: "title", title: "Fixture" }, header, user("one", null, "/goal Finish the fixture")), session);
    expect(view).toMatchObject({ objective: "Finish the fixture", sessionControls: true, reading: { source: "omp", state: "active" } });
    expect(view.reading.nativeContinuation).not.toBe(true);
  });
  it("resume의 추가 지시를 새 목표로 덮어쓰지 않고 분기와 지연 사용량의 현재 leaf를 따른다", () => {
    const one = user("one", null, "/goal Original fixture"), abandoned = user("abandoned", "one", "/goal Abandoned fixture");
    expect(readOmpGoal(lines(header, one, abandoned, user("resume", "one", "/goal resume continue please")), session).objective).toBe("Original fixture");
    expect(readOmpGoal(lines(header, one, abandoned, { type: "model_usage", id: "usage", parentId: "abandoned", activeLeafId: "one" }), session).objective).toBe("Original fixture");
  });
  it("네이티브 Goal이 있으면 요청 메시지보다 우선하고 완료와 제거를 되살리지 않는다", () => {
    const prompt = user("request", null, "/goal Requested fixture");
    expect(readOmpGoal(lines(header, prompt, native("native", "request")), session)).toMatchObject({ objective: "Native fixture", tokenBudget: 100, tokensUsed: 30, reading: { state: "active", nativeContinuation: true } });
    expect(readOmpGoal(lines(header, native("native", null, "complete")), session).reading.state).toBe("complete");
    expect(readOmpGoal(lines(header, prompt, native("native", "request"), { type: "mode_change", id: "drop", parentId: "native", mode: "none" }), session).objective).toBeNull();
  });
  it("명시적인 pause와 clear를 존중하며 재개 프롬프트는 기존 요청을 유지한다", () => {
    const start = lines(header, user("one", null, "/goal Fixture"), user("pause", "one", "/goal pause"));
    expect(readOmpGoal(start, session).reading.state).toBe("paused");
    expect(readOmpGoal(start + lines(user("resume", "pause", GOAL_PROMPT)), session)).toMatchObject({ objective: "Fixture", reading: { state: "active" } });
    expect(readOmpGoal(start + lines(user("clear", "pause", "/goal clear")), session).objective).toBeNull();
    const cleared = start + lines(user("clear", "pause", "/goal clear"));
    expect(readOmpGoal(cleared + lines(user("late-resume", "clear", "/goal resume")), session)).toMatchObject({ objective: null, reading: { state: "cleared", key: null } });
    expect(readOmpGoal(start + lines(user("edit", "pause", "/goal edit")), session).objective).toBe("Fixture");
  });
  it("다른 세션, 불완전한 행, 알 수 없는 부모와 중복 ID는 No goal로 표시하지 않는다", () => {
    const start = lines(header, user("one", null, "/goal Fixture"));
    for (const text of [start.trimEnd(), start + "{\n", start + lines(user("two", "missing", "hello")), start + lines(user("one", null, "/goal Other"))]) expect(readOmpGoal(text, session).reading.state).toBe("unknown");
    expect(readOmpGoal(start, "other-session").reading.state).toBe("unknown");
  });
  it("일반 메시지로 요청한 중지도 자동 이어가기가 무시하지 않는다", () => {
    const start = lines(header, user("goal", null, "/goal Fixture"));
    for (const stop of ["stop", "pause please", "cancel", "멈춰", "그만", "일시 중지"]) expect(readOmpGoal(start + lines(user("stop", "goal", stop)), session).reading.state).toBe("paused");
    expect(readOmpGoal(start + lines(user("keep", "goal", "멈추지 말고 계속해줘")), session).reading.state).toBe("active");
  });
});

describe("OMP 조회 성능과 파일 변경", () => {
  let root: string, path: string, reader: OmpGoals, agent: PaseoAgent;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "recovery-omp-test-")); path = join(root, `fixture_${session}.jsonl`);
    await fs.writeFile(path, lines(header, user("one", null, "/goal Fixture")));
    reader = new OmpGoals(); agent = { id: "agent", provider: "omp", persistence: { sessionId: session, nativeHandle: path } } as PaseoAgent;
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  it("숨겨진 세션은 파일을 열지 않고 같은 세션의 동시 조회를 합친다", async () => {
    const spy = vi.mocked(fs.open); spy.mockClear();
    for (let n = 0; n < 200; n++) reader.cached({ ...agent, id: `hidden-${n}` });
    expect(spy).not.toHaveBeenCalled();
    const first = reader.details(agent), second = reader.details(agent); expect(second).toBe(first);
    expect(await first).toMatchObject({ objective: "Fixture" }); expect(spy).toHaveBeenCalledOnce();
    for (let n = 0; n < 20; n++) await reader.details(agent);
    expect(spy).toHaveBeenCalledOnce();
  });
  it("새로 추가된 부분만 읽고 되감기, 잘린 파일과 교체 파일은 다시 확인한다", async () => {
    const spy = vi.mocked(fs.open); spy.mockClear(); await reader.details(agent);
    await fs.appendFile(path, lines(user("two", "one", "/goal Updated fixture")));
    expect(await reader.details(agent)).toMatchObject({ objective: "Updated fixture" }); expect(spy).toHaveBeenCalledTimes(2);
    await fs.appendFile(path, lines(user("rewound", "one", "hello")));
    expect(await reader.details(agent)).toMatchObject({ objective: "Fixture" });
    await fs.writeFile(path, lines(header, user("new", null, "/goal Replacement")));
    expect(await reader.details(agent)).toMatchObject({ objective: "Replacement" });
  });
  it("잘못된 핸들과 읽기 한도를 넘는 파일을 복원하거나 전체 디렉터리를 탐색하지 않는다", async () => {
    const spy = vi.mocked(fs.open);
    const file = await fs.open(path, "r+"); await file.truncate(33 * 1024 * 1024); await file.close(); spy.mockClear();
    expect((await reader.details(agent))?.reading.state).toBe("unknown"); expect(spy).not.toHaveBeenCalled();
    expect((await reader.details({ ...agent, persistence: { ...agent.persistence!, nativeHandle: "/fixture/other-session.jsonl" } }))?.objective).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
