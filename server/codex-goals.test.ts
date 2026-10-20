import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexGoalConnection, CodexGoals, codexLaunch } from "./codex-goals";

describe("Codex goal reader", () => {
  it("shares one reader across concurrent visibility and recovery lookups and stays closed", async () => {
    const home = await mkdtemp(join(tmpdir(), "goal-reader-concurrency-")); const starts = join(home, "starts");
    const script = `require("node:fs").appendFileSync(process.env.STARTS_FILE,"x");require("node:readline").createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);if(m.method==="initialized")return;if(!["initialize","thread/goal/get"].includes(m.method))process.exit(2);process.stdout.write(JSON.stringify({id:m.id,result:m.method==="initialize"?{}:{goal:{objective:"Fixture goal",status:"active"}}})+"\\n")});`;
    await writeFile(join(home, "config.json"), JSON.stringify({ agents: { providers: { codex: { command: [process.execPath, "-e", script, "--"], env: { STARTS_FILE: starts } } } } }));
    const goals = new CodexGoals(home);
    try {
      const readings = await Promise.all([goals.read("codex", "one"), goals.read("codex", "two")]);
      expect(readings.every((r) => r?.state === "active")).toBe(true); expect(await readFile(starts, "utf8")).toBe("x");
      await goals.close(); expect(await goals.read("codex", "three")).toMatchObject({ state: "unknown" });
      expect(await readFile(starts, "utf8")).toBe("x");
    } finally { await goals.close(); await rm(home, { recursive: true, force: true }); }
  });
  it("resolves configured command prefixes and inherited provider environments", () => {
    const config = { agents: { providers: { codex: { command: ["wrapper", "codex", "--", "codex"], env: { BASE_SETTING: "base" } }, custom: { extends: "codex", env: { TASK_SETTING: "custom" } } } } };
    expect(codexLaunch(config, "custom")).toEqual({ command: "wrapper", args: ["codex", "--", "codex", "app-server", "--enable", "goals"], env: { BASE_SETTING: "base", TASK_SETTING: "custom" } });
    expect(codexLaunch(config, "omp")).toBeNull();
  });
  it("rejects cyclic provider inheritance", () => {
    expect(() => codexLaunch({ agents: { providers: { one: { extends: "two" }, two: { extends: "one" } } } }, "one")).toThrow(/inheritance/);
  });
  it("uses only initialize and goal-get requests and never loads or runs a thread", async () => {
    const script = `const readline=require("node:readline");let initialized=false;readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.method==="initialized")return;if(m.method==="initialize"){initialized=true;process.stdout.write(JSON.stringify({id:m.id,result:{}})+"\\n");return;}if(!initialized||m.method!=="thread/goal/get")process.exit(2);process.stdout.write(JSON.stringify({id:m.id,result:{goal:{objective:"Finish fixture",status:"active",tokensUsed:1,tokenBudget:20}}})+"\\n");});`;
    const reader = new CodexGoalConnection({ command: process.execPath, args: ["-e", script], env: {} }, process.cwd());
    try {
      const reading = await reader.read("fixture-thread");
      expect(reading).toEqual({ state: "active", key: expect.stringMatching(/^[a-f0-9]{64}$/), evidence: true, source: "codex" });
      expect(await reader.read("fixture-thread")).toEqual(reading);
    } finally { await reader.close(); }
  });
  it("treats a null native goal as cleared without inventing a tracked goal", async () => {
    const script = `require("node:readline").createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.method==="initialize"?{}:{goal:null}})+"\\n")});`;
    const reader = new CodexGoalConnection({ command: process.execPath, args: ["-e", script], env: {} }, process.cwd());
    try { expect(await reader.read("fixture")).toEqual({ state: "cleared", key: null, evidence: false, source: "codex" }); }
    finally { await reader.close(); }
  });
  it("fails closed when the provider process rejects the lookup", async () => {
    const script = `require("node:readline").createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);if(m.id)process.stdout.write(JSON.stringify(m.method==="initialize"?{id:m.id,result:{}}:{id:m.id,error:{message:"private error"}})+"\\n")});`;
    const reader = new CodexGoalConnection({ command: process.execPath, args: ["-e", script], env: {} }, process.cwd());
    try { await expect(reader.read("fixture")).rejects.toThrow("Codex goal lookup was rejected"); }
    finally { await reader.close(); }
  });
  async function blockedReader(status = "blocked", tokensUsed = 3, tokenBudget: number | null = 20) {
    const home = await mkdtemp(join(tmpdir(), "goal-resume-reader-")), path = join(home, "goal.json");
    const goal = { objective: "Finish fixture", status, tokensUsed, tokenBudget, createdAt: 1 };
    await writeFile(path, JSON.stringify(goal));
    const script = `require("node:readline").createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);if(m.method==="initialized")return;if(!["initialize","thread/goal/get"].includes(m.method))process.exit(2);process.stdout.write(JSON.stringify({id:m.id,result:m.method==="initialize"?{}:{goal:JSON.parse(require("node:fs").readFileSync(process.env.GOAL_FILE,"utf8"))}})+"\\n")});`;
    const reader = new CodexGoalConnection({ command: process.execPath, args: ["-e", script], env: { GOAL_FILE: path } }, process.cwd());
    const send = vi.fn(async () => { await writeFile(path, JSON.stringify({ ...goal, status: "active" })); });
    return { reader, send, async close() { await reader.close(); await rm(home, { recursive: true, force: true }); } };
  }
  it.each([20, null])("reactivates a blocked goal without replacing its objective or %s budget", async (budget) => {
    const f = await blockedReader("blocked", 3, budget), { reader } = f;
    try {
      const before = await reader.read("fixture");
      expect(await reader.resumeBlocked("fixture", before.key!, () => {}, f.send)).toMatchObject({ state: "active", key: before.key, source: "codex" });
      expect(f.send).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
  it.each(["paused", "active", "usageLimited", "budgetLimited", "complete"])("does not resume a goal with native status %s", async (status) => {
    const f = await blockedReader(status), { reader } = f;
    try { await expect(reader.resumeBlocked("fixture", (await reader.read("fixture")).key!, () => {}, f.send)).rejects.toThrow(/changed/); expect(f.send).not.toHaveBeenCalled(); }
    finally { await f.close(); }
  });
  it("does not resume an exhausted blocked goal", async () => {
    const f = await blockedReader("blocked", 20, 20), { reader } = f;
    try { await expect(reader.resumeBlocked("fixture", (await reader.read("fixture")).key!, () => {}, f.send)).rejects.toThrow(/budget/); expect(f.send).not.toHaveBeenCalled(); }
    finally { await f.close(); }
  });
  it("does not change a replacement objective or ignore a canceled guard", async () => {
    const f = await blockedReader(), { reader } = f;
    try {
      await expect(reader.resumeBlocked("fixture", "old-objective", () => {}, f.send)).rejects.toThrow(/changed/);
      const before = await reader.read("fixture");
      await expect(reader.resumeBlocked("fixture", before.key!, () => { throw new Error("Canceled"); }, f.send)).rejects.toThrow("Canceled");
      expect(await reader.read("fixture")).toEqual(before);
      expect(f.send).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("does not replay a resume command whose receipt was lost", async () => {
    const f = await blockedReader(); f.send.mockRejectedValueOnce(new Error("Receipt lost"));
    try { await expect(f.reader.resumeBlocked("fixture", (await f.reader.read("fixture")).key!, () => {}, f.send)).rejects.toThrow("Receipt lost"); expect(f.send).toHaveBeenCalledOnce(); }
    finally { await f.close(); }
  });
  async function editFixture() {
    const home = await mkdtemp(join(tmpdir(), "goal-edit-reader-")), path = join(home, "goal.json");
    let goal = { id: "fixture-goal", objective: "Original fixture", status: "paused", tokensUsed: 3, tokenBudget: 20, createdAt: 1 };
    await writeFile(path, JSON.stringify(goal));
    const script = `require("node:readline").createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);if(m.method==="initialized")return;if(!["initialize","thread/goal/get"].includes(m.method))process.exit(2);process.stdout.write(JSON.stringify({id:m.id,result:m.method==="initialize"?{}:{goal:JSON.parse(require("node:fs").readFileSync(process.env.GOAL_FILE,"utf8"))}})+"\\n")});`;
    const reader = new CodexGoalConnection({ command: process.execPath, args: ["-e", script], env: { GOAL_FILE: path } }, process.cwd());
    const change = async (patch: Partial<typeof goal>) => { goal = { ...goal, ...patch }; await writeFile(path, JSON.stringify(goal)); };
    const send = vi.fn(async () => { await change({ objective: "Edited fixture", status: "active" }); });
    return { reader, send, change, async close() { await reader.close(); await rm(home, { recursive: true, force: true }); } };
  }
  it("목표 본문을 읽고 사용량 증가를 허용하면서 저장 직전에 같은 Goal인지 확인한다", async () => {
    const f = await editFixture();
    try {
      const before = await f.reader.details("fixture"); expect(before).toMatchObject({ objective: "Original fixture", tokenBudget: 20, tokensUsed: 3 });
      await f.change({ tokensUsed: 4 }); expect((await f.reader.details("fixture")).revision).toBe(before.revision);
      expect(await f.reader.edit("fixture", before.revision, "Edited fixture", () => {}, f.send)).toMatchObject({ state: "active", source: "codex" });
      expect(f.send).toHaveBeenCalledOnce(); expect(await f.reader.details("fixture")).toMatchObject({ objective: "Edited fixture", tokensUsed: 4, tokenBudget: 20 });
    } finally { await f.close(); }
  });
  it.each([{ objective: "Other editor's change" }, { tokenBudget: 21 }, { status: "active" }, { id: "replacement-goal" }])("목표나 예산의 변경 %j을 덮어쓰지 않는다", async (patch) => {
    const f = await editFixture();
    try { const before = await f.reader.details("fixture"); await f.change(patch); await expect(f.reader.edit("fixture", before.revision, "Edited fixture", () => {}, f.send)).rejects.toThrow(/changed/); expect(f.send).not.toHaveBeenCalled(); }
    finally { await f.close(); }
  });
  it.each(["pause", " RESUME ", "Clear"])("제어 명령 %s을 목표 본문으로 전송하지 않는다", async (objective) => {
    const f = await editFixture();
    try { await expect(f.reader.edit("fixture", "unused", objective, () => {}, f.send)).rejects.toThrow(/control command/); expect(f.send).not.toHaveBeenCalled(); }
    finally { await f.close(); }
  });
  it("같은 본문을 저장해 멈춘 Goal을 재개하지 않는다", async () => {
    const f = await editFixture();
    try { const before = await f.reader.details("fixture"); expect(await f.reader.edit("fixture", before.revision, before.objective!, () => {}, f.send)).toMatchObject({ state: "paused" }); expect(f.send).not.toHaveBeenCalled(); }
    finally { await f.close(); }
  });
  it("사용량으로 수동 편집을 막지 않고 Codex가 반환한 상태를 따른다", async () => {
    const f = await editFixture();
    try {
      await f.change({ status: "active", tokensUsed: 20 }); const before = await f.reader.details("fixture");
      expect(before.reading.state).toBe("active");
      expect(await f.reader.edit("fixture", before.revision, "Edited fixture", () => {}, f.send)).toMatchObject({ state: "active" });
      expect(f.send).toHaveBeenCalledOnce();
      expect(await f.reader.read("fixture")).toMatchObject({ state: "limited" });
      expect((await f.reader.details("fixture")).tokensUsed).toBe(20);
    }
    finally { await f.close(); }
  });
  it("네이티브 편집의 예산 변경이나 사용량 초기화를 성공으로 보고하지 않는다", async () => {
    const f = await editFixture();
    try { const before = await f.reader.details("fixture"); f.send.mockImplementationOnce(async () => f.change({ objective: "Edited fixture", status: "active", tokensUsed: 0 })); await expect(f.reader.edit("fixture", before.revision, "Edited fixture", () => {}, f.send)).rejects.toThrow(/budget changed/); expect(f.send).toHaveBeenCalledOnce(); }
    finally { await f.close(); }
  });
  it("결과가 불분명한 편집을 자동 재전송하지 않는다", async () => {
    const f = await editFixture();
    try { const before = await f.reader.details("fixture"); f.send.mockRejectedValueOnce(new Error("Receipt lost")); await expect(f.reader.edit("fixture", before.revision, "Edited fixture", () => {}, f.send)).rejects.toThrow("Receipt lost"); expect(f.send).toHaveBeenCalledOnce(); }
    finally { await f.close(); }
  });
  it.each(["pause", "resume"] as const)("%s 제어는 소유 연결로 한 번 보내고 목표와 예산을 보존한다", async (action) => {
    const f = await editFixture();
    try {
      await f.change({ status: action === "pause" ? "active" : "paused" });
      const before = await f.reader.details("fixture");
      f.send.mockImplementationOnce(async () => f.change({ status: action === "pause" ? "paused" : "active" }));
      expect(await f.reader.control("fixture", before.revision, action, () => {}, f.send)).toMatchObject({ key: before.reading.key, state: action === "pause" ? "paused" : "active" });
      const after = await f.reader.details("fixture");
      expect(after.tokenBudget).toBe(before.tokenBudget); expect(after.tokensUsed).toBe(before.tokensUsed); expect(f.send).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
  it("다른 목표로 바뀌면 거부하지만 명시적인 재개를 사용량으로 막지 않는다", async () => {
    const f = await editFixture();
    try {
      const before = await f.reader.details("fixture"); await f.change({ objective: "Replacement" });
      await expect(f.reader.control("fixture", before.revision, "resume", () => {}, f.send)).rejects.toThrow(/changed/);
      expect(f.send).not.toHaveBeenCalled();
      await f.change({ tokensUsed: 20 }); const latest = await f.reader.details("fixture");
      f.send.mockImplementationOnce(async () => f.change({ status: "active" }));
      expect(await f.reader.control("fixture", latest.revision, "resume", () => {}, f.send)).toMatchObject({ state: "active" });
      expect(f.send).toHaveBeenCalledOnce(); expect((await f.reader.details("fixture")).tokensUsed).toBe(20);
    } finally { await f.close(); }
  });
  it("일시정지 중 예산 초기화와 목표 교체를 성공으로 보고하지 않는다", async () => {
    const f = await editFixture();
    try {
      await f.change({ status: "active" }); const before = await f.reader.details("fixture");
      f.send.mockImplementationOnce(async () => f.change({ status: "paused", tokensUsed: 0 }));
      await expect(f.reader.control("fixture", before.revision, "pause", () => {}, f.send)).rejects.toThrow(/identity or budget/); expect(f.send).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
});
