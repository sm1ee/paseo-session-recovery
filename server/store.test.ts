import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState } from "../shared/model";
import { FileStore } from "./store";

const directories: string[] = [];
async function fixture() { const directory = await mkdtemp(join(tmpdir(), "session-recovery-test-")); directories.push(directory); return { directory, store: new FileStore(directory, "host") }; }
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
describe("durable local journal", () => {
  it("creates a private journal and protection list without leftover temporary files", async () => {
    const f = await fixture(); const s = emptyState("host"); await f.store.save(s);
    expect(await f.store.load()).toEqual(s); expect((await stat(join(f.directory, "state.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.directory, "holds.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(f.directory)).toEqual(["holds.json", "state.json"]);
    expect(JSON.parse(await readFile(join(f.directory, "holds.json"), "utf8"))).toEqual({ version: 1, serverId: "host", ids: [] });
  });
  it("starts empty only when the journal is absent", async () => {
    const f = await fixture(); expect(await f.store.load()).toEqual(emptyState("host"));
    await writeFile(join(f.directory, "state.json"), "corrupt"); await expect(f.store.load()).rejects.toThrow(/preserved/);
    expect(await readFile(join(f.directory, "state.json"), "utf8")).toBe("corrupt");
  });
  it("refuses a different daemon's journal", async () => {
    const f = await fixture(); await writeFile(join(f.directory, "state.json"), JSON.stringify(emptyState("other-host")));
    await expect(f.store.load()).rejects.toThrow(/paused/);
  });
  it("fails the save when cleanup protections cannot be committed", async () => {
    const f = await fixture(); await mkdir(join(f.directory, "holds.json"));
    await expect(f.store.save(emptyState("host"))).rejects.toThrow(/could not be saved/);
  });
});
