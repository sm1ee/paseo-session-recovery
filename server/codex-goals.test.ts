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
});
