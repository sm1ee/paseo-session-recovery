import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { busy, fingerprint, goalCommandReady, type Agent, type Workspace } from "../shared/model";
import { FileStore, RecoveryError, type StateStore } from "./store";
import { daemonCompatibilityError } from "./compatibility";
import { localWebSocketFactory } from "./transport";
import { readGoal, type GoalItem, type GoalReading } from "./goals";
import { CodexGoals } from "./codex-goals";
import { OpenCodeGoals } from "./opencode-goals";

export interface RecoveryHost {
  bootKey: string;
  serverId: string;
  store: StateStore;
  fetch(id: string): Promise<Agent | null>;
  workspace(id: string): Promise<Workspace | null>;
  goal?(id: string): Promise<GoalReading>;
  resumeBlockedGoal?(id: string, key: string, expected: Agent, check: () => void, messageId: string): Promise<GoalReading>;
  shuttingDown(): Promise<boolean>;
  send(id: string, prompt: string, messageId: string, expected: Agent, check: () => void): Promise<void>;
  close(): Promise<void>;
}
export function metadata(a: PaseoAgent): Agent {
  return {
    id: a.id, title: a.title || `Untitled session (${a.id.slice(0, 8)})`, provider: a.provider,
    workspaceId: a.workspaceId ?? null, parentId: a.labels["paseo.parent-agent-id"]?.trim() || null,
    status: a.status, activeTurn: a.activeTurn === undefined ? undefined : a.activeTurn?.turnId ?? null,
    pendingPermissions: Array.isArray(a.pendingPermissions) ? a.pendingPermissions.length : -1,
    archivedAt: a.archivedAt ?? null, lastUserMessageAt: a.lastUserMessageAt,
    attentionReason: a.attentionReason ?? null, attentionTimestamp: a.attentionTimestamp ?? null,
    persistence: Boolean(a.persistence?.sessionId), internal: "internal" in a && a.internal === true,
    modeId: a.currentModeId === undefined ? a.runtimeInfo?.modeId ?? null : a.currentModeId,
  };
}
export function resolveHome(configured: string): string {
  const raw = configured.trim() || process.env.PASEO_HOME || join(homedir(), ".paseo");
  return resolve(raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}
export function localEndpoint(listen: string): { url: string; socketPath?: string } {
  if (listen.startsWith("unix://") || listen.startsWith("/")) {
    const socketPath = listen.replace(/^unix:\/\//, "");
    if (!socketPath.startsWith("/") || socketPath.includes("\u0000")) throw new RecoveryError("The local socket path is invalid.");
    return { url: "ws://localhost/ws", socketPath };
  }
  const url = new URL(`ws://${listen}/ws`);
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (url.hostname === "[::]") url.hostname = "[::1]";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/ws" || url.search || url.hash) throw new RecoveryError("Recovery requires this daemon's local socket or loopback listener.");
  return { url: url.href };
}
interface ProcessInfo { parent: number; started: string }
const run = promisify(execFile);
async function processInfo(pid: number): Promise<ProcessInfo> {
  const { stdout } = await run("ps", ["-p", String(pid), "-o", "ppid=", "-o", "lstart="], { timeout: 3000, maxBuffer: 1024, env: { ...process.env, LC_ALL: "C" } });
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
  if (!match) throw new RecoveryError("The daemon process could not be verified.");
  return { parent: Number(match[1]), started: match[2] };
}
// The PID lock belongs to the supervisor, which can survive a worker restart.
// Identify its worker by the process ancestry and birth time, not serverId alone.
export async function workerIdentity(parentPid: number, ownerPid: number, lookup = processInfo): Promise<string> {
  let pid = parentPid;
  for (let n = 0; n < 5 && pid > 1; n++) {
    const info = await lookup(pid);
    if (pid === ownerPid || info.parent === ownerPid) return `${pid}:${info.started}`;
    pid = info.parent;
  }
  throw new RecoveryError("The selected Paseo home belongs to another daemon.");
}
const lockSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string().min(1), serverId: z.string().min(1), listen: z.string().min(1) });
async function lease(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "worker.lock");
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  try { await writeFile(path, owner, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let previous: { pid: number };
    try { previous = z.object({ pid: z.number().int().positive(), nonce: z.string() }).parse(JSON.parse(await readFile(path, "utf8"))); }
    catch { throw new RecoveryError("The recovery worker lock could not be verified."); }
    try { process.kill(previous.pid, 0); throw new RecoveryError("Another session-recovery worker is already running."); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
    await unlink(path);
    await writeFile(path, owner, { flag: "wx", mode: 0o600 });
  }
  return async () => {
    try { if (await readFile(path, "utf8") === owner) await unlink(path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  };
}

// 0.11 and 0.12 do not expose an SDK context at server entry startup. This small
// version-pinned adapter authenticates only to the daemon that owns the plugin.
export async function openLocalHost(configuredHome: string, parentPid = process.ppid): Promise<RecoveryHost> {
  if (process.platform === "win32") throw new RecoveryError("session-recovery currently requires a macOS or Linux daemon.");
  const home = resolveHome(configuredHome);
  let lock: z.infer<typeof lockSchema>;
  try { lock = lockSchema.parse(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8"))); }
  catch { throw new RecoveryError("Cannot find this daemon. Check Paseo home in recovery settings."); }
  const worker = await workerIdentity(parentPid, lock.pid);
  const bootKey = createHash("sha256").update(`${lock.serverId}:${lock.startedAt}:${worker}`).digest("hex");
  const directory = join(home, "plugin-data", "session-recovery");
  const endpoint = localEndpoint(lock.listen);
  const release = await lease(directory);
  const identity = async () => {
    const current = lockSchema.parse(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")));
    if (JSON.stringify(current) !== JSON.stringify(lock) || await workerIdentity(parentPid, lock.pid) !== worker) throw new RecoveryError("The daemon changed. Recovery is paused.");
  };
  const driver = new DaemonClient({
    url: endpoint.url, clientId: `session-recovery-${randomUUID()}`, clientType: "cli", appVersion: "0.12.0",
    connectTimeoutMs: 10_000, reconnect: { enabled: false }, logger: { debug() {}, info() {}, warn() {}, error() {} },
    localCredential: async () => {
      await identity();
      const credential = (await readFile(join(home, "local-credential"), "utf8")).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new RecoveryError("The daemon's local credential is unavailable.");
      return credential;
    },
    webSocketFactory: localWebSocketFactory(endpoint.socketPath),
  });
  let closed = false;
  const codexGoals = new CodexGoals(home);
  const openCodeGoals = new OpenCodeGoals(home);
  const close = async () => { if (closed) return; closed = true; await codexGoals.close(); await driver.close().finally(release); };
  const check = async () => {
    await identity();
    if (closed || driver.getConnectionState().status !== "connected" || driver.getLastServerInfoMessage()?.serverId !== lock.serverId) throw new RecoveryError("The local daemon is disconnected. Recovery is paused.");
  };
  try {
    await driver.connect(); await check();
    const compatibilityError = daemonCompatibilityError(driver.getLastServerInfoMessage()?.version, driver.supportsBackgroundWorkspaces());
    if (compatibilityError) throw new RecoveryError(compatibilityError);
    const paseo = createPaseoApi(driver);
    const fetch = async (id: string) => { await check(); const result = await paseo.agents.ref(id).refresh(); await check(); return result?.agent ? metadata(result.agent) : null; };
    return {
      bootKey, serverId: lock.serverId, store: new FileStore(directory, lock.serverId), fetch,
      async goal(id) {
        await check();
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        if (!agent) return { state: "unknown", key: null, evidence: true };
        const openCode = await openCodeGoals.read(agent);
        await check();
        if (openCode) return openCode;
        if (agent.persistence?.sessionId) {
          const native = await codexGoals.read(agent.provider, agent.persistence.sessionId);
          await check();
          if (native) return native;
        }
        let page = await driver.fetchAgentTimeline(id, { projection: "canonical", direction: "tail", limit: 200 });
        const epoch = page.epoch;
        let entries = [...page.entries];
        const cursors = new Set<number>();
        for (let n = 0; n < 10; n++) {
          await check();
          if (page.error || page.gap || page.staleCursor || page.epoch !== epoch || n === 0 && page.hasNewer) return { state: "unknown", key: null, evidence: true };
          const reading = readGoal(entries.sort((a, b) => a.seqEnd - b.seqEnd).map((e) => e.item as GoalItem));
          if (reading.evidence && (reading.key || reading.state !== "active") || !page.hasOlder) return reading;
          if (!page.startCursor || cursors.has(page.startCursor.seq)) break;
          cursors.add(page.startCursor.seq);
          page = await driver.fetchAgentTimeline(id, { projection: "canonical", direction: "before", cursor: page.startCursor, limit: 200 });
          entries = [...page.entries, ...entries];
        }
        return { state: "unknown", key: null, evidence: true };
      },
      async workspace(id) {
        await check(); const w = await paseo.workspaces.ref(id).refresh(); await check();
        // Workspace descriptors include active workspaces only; archived ones
        // return null. Session archivedAt is checked independently before send.
        return w ? { id: w.id, archived: false, archiving: Boolean(w.archivingAt) } : null;
      },
      async resumeBlockedGoal(id, key, expected, guard, messageId) {
        await check(); guard();
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        const latest = agent ? metadata(agent) : null;
        if (!agent?.persistence?.sessionId || !latest || !goalCommandReady(latest) || latest.archivedAt || fingerprint(latest) !== fingerprint(expected)) throw new RecoveryError("The session changed before its goal could resume. Check it and try again.");
        const workspace = latest.workspaceId ? await paseo.workspaces.ref(latest.workspaceId).refresh() : null;
        if (!workspace || workspace.archivingAt) throw new RecoveryError("This workspace is unavailable.");
        await check(); guard();
        try {
          return await codexGoals.resumeBlocked(agent.provider, agent.persistence.sessionId, key, guard, async () => {
            if (driver.getLastServerInfoMessage()?.features?.agentRequestReceipts !== true) throw new RecoveryError("This daemon does not advertise durable message receipts.");
            const current = await fetch(id);
            if (!current || !goalCommandReady(current) || current.archivedAt || fingerprint(current) !== fingerprint(expected)) throw new RecoveryError("The session changed before its goal could resume. Check it and try again.");
            await check(); guard();
            await driver.sendAgentMessage(id, "/goal resume", { messageId, activeTurnBehavior: "steer" });
          });
        }
        catch (error) { throw new RecoveryError(error instanceof Error ? error.message : "Codex could not resume this goal. Check its native state."); }
      },
      async shuttingDown() {
        await identity();
        // Paseo 0.11.4 and 0.12.0 remove this credential at graceful shutdown,
        // before canceling turns or closing sessions. Rotation is not assumed.
        try { await access(join(home, "local-credential")); return false; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; throw e; }
      },
      async send(id, prompt, messageId, expected, guard) {
        if (driver.getLastServerInfoMessage()?.features?.agentRequestReceipts !== true) throw new RecoveryError("This daemon does not advertise durable message receipts. Recovery is paused.");
        guard();
        const latest = await fetch(id);
        if (!latest || busy(latest) || latest.archivedAt || fingerprint(latest) !== fingerprint(expected)) throw new RecoveryError("The session changed before recovery. Open it and review the latest state.");
        await check(); guard();
        // Paseo has no conditional send-if-idle RPC. Recheck immediately before
        // submission; steer is preferable if a concurrent turn starts afterwards.
        await driver.sendAgentMessage(id, prompt, { messageId, activeTurnBehavior: "steer" });
      },
      close,
    };
  } catch (error) {
    await close();
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError("Cannot connect to this daemon. Recovery will retry the local connection.");
  }
}
