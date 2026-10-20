import { describe, expect, it } from "vitest";
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
      expect(reading).toEqual({ state: "active", key: expect.stringMatching(/^[a-f0-9]{64}$/), evidence: true });
      expect(await reader.read("fixture-thread")).toEqual(reading);
    } finally { await reader.close(); }
  });
  it("treats a null native goal as cleared without inventing a tracked goal", async () => {
    const script = `require("node:readline").createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.method==="initialize"?{}:{goal:null}})+"\\n")});`;
    const reader = new CodexGoalConnection({ command: process.execPath, args: ["-e", script], env: {} }, process.cwd());
    try { expect(await reader.read("fixture")).toEqual({ state: "cleared", key: null, evidence: false }); }
    finally { await reader.close(); }
  });
  it("fails closed when the provider process rejects the lookup", async () => {
    const script = `require("node:readline").createInterface({input:process.stdin}).on("line",s=>{const m=JSON.parse(s);if(m.id)process.stdout.write(JSON.stringify(m.method==="initialize"?{id:m.id,result:{}}:{id:m.id,error:{message:"private error"}})+"\\n")});`;
    const reader = new CodexGoalConnection({ command: process.execPath, args: ["-e", script], env: {} }, process.cwd());
    try { await expect(reader.read("fixture")).rejects.toThrow("Codex goal lookup was rejected"); }
    finally { await reader.close(); }
  });
});
