import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emptyState, holdIds, stateSchema, type SavedState } from "../shared/model";

export interface StateStore { load(): Promise<SavedState>; save(state: SavedState): Promise<void> }
export class RecoveryError extends Error {}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
  }
}
export class FileStore implements StateStore {
  constructor(private readonly directory: string, private readonly serverId: string) {}
  async load(): Promise<SavedState> {
    try {
      const state = stateSchema.parse(JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")));
      if (state.serverId !== this.serverId) throw new Error("Host changed");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(this.serverId);
      throw new RecoveryError("Recovery history could not be read. Automatic recovery is paused; the existing file has been preserved.");
    }
  }
  async save(state: SavedState): Promise<void> {
    stateSchema.parse(state);
    try {
      await atomicJson(join(this.directory, "state.json"), state);
      // Janitor reads this separate, content-free protection list. Never resume
      // unless both the intent and its cleanup protection reached the disk.
      await atomicJson(join(this.directory, "holds.json"), { version: 1, serverId: this.serverId, ids: holdIds(state) });
    } catch { throw new RecoveryError("Recovery history could not be saved. Automatic recovery is paused."); }
  }
}
