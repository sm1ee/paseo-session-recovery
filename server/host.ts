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
import { readGoalDetails, type GoalDetails, type GoalItem, type GoalReading, type GoalSource } from "./goals";
import type { GoalAction } from "../shared/goal-actions";
import { CodexGoals } from "./codex-goals";
import { OpenCodeGoals } from "./opencode-goals";
import { ClaudeGoals } from "./claude-goals";
import { OmpGoals } from "./omp-goals";
import { OmpNativeGoals, ompNativeDetails, OMP_GOAL_RPC, type OmpNativeOutput } from "./omp-native-goals";
import { controlSessionGoal } from "./session-goal-controls";
import { GOAL_PROMPT } from "../shared/contracts";
import { CONNECTION_RPC, type ConnectionOutput } from "./session-connection";

export interface RecoveryHost {
  bootKey: string;
  serverId: string;
  store: StateStore;
  fetch(id: string): Promise<Agent | null>;
  workspace(id: string): Promise<Workspace | null>;
  goal?(id: string, options?: { allowTimeline?: boolean; inspectOmp?: boolean }): Promise<GoalReading>;
  supportsGoalCommand?(id: string, source?: GoalSource): Promise<boolean>;
  goalDetails?(id: string, options?: { allowTimeline?: boolean }): Promise<GoalDetails | null>;
  controlGoal?(id: string, revision: string, action: GoalAction, expected: Agent, check: () => void, messageId: string, submitted: () => void): Promise<GoalReading>;
  editGoal?(id: string, revision: string, objective: string, expected: Agent, check: () => void, messageId: string, submitted: () => void): Promise<GoalReading>;
  resumeBlockedGoal?(id: string, key: string, expected: Agent, check: () => void, messageId: string, submitted?: () => void, identity?: string): Promise<GoalReading>;
  connection?(id: string): Promise<"loaded" | "detached" | "unknown">;
  reconnectSession?(id: string, expected: Agent, check: () => void): Promise<Agent>;
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
    persistence: Boolean(a.persistence?.sessionId), sessionId: a.persistence?.sessionId ?? null, internal: "internal" in a && a.internal === true,
    modeId: a.currentModeId === undefined ? a.runtimeInfo?.modeId ?? null : a.currentModeId,
  };
}
export function nativeGoalCommand(commands: readonly { name: string; kind?: string; description: string }[], source: GoalSource): boolean {
  const descriptions: Record<GoalSource, string[]> = {
    codex: ["Set, pause, resume, or clear the agent's goal"],
    opencode: ["Set a session-scoped goal and auto-continue until complete."],
    claude: ["Set a goal — keep working until the condition is met"],
    omp: [],
  };
  return commands.some((command) => command.name === "goal" && command.kind === (source === "claude" ? "skill" : "command") && descriptions[source].includes(command.description));
}
function checkGoalSession(current: Agent | null, expected: Agent, stage: "initial" | "final", idleOnly = false): asserts current is Agent {
  // Codex updates can run during a turn; OpenCode/Claude commands require idle.
  // Presentation metadata can change during lookup. Lifecycle guards still
  // protect stops, approvals and new turns.
  const stable = ["id", "provider", "workspaceId", "parentId", "sessionId", "lastUserMessageAt", "modeId"] as const;
  if (current && expected.sessionId && stable.every((field) => current[field] === expected[field]) &&
    goalCommandReady(current) && (!idleOnly || !busy(current)) && !current.archivedAt && !current.internal) return;
  console.warn("Native goal preflight rejected", { stage,
    changedFields: current ? Object.keys({ ...expected, ...current }).filter((field) => current[field as keyof Agent] !== expected[field as keyof Agent]) : ["missing"] });
  throw new RecoveryError("The session changed before its goal could be updated. Check it and try again.");
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
  const claudeGoals = new ClaudeGoals(home);
  const ompGoals = new OmpGoals();
  const ompNativeGoals = new OmpNativeGoals(async (input) => await driver.invokePluginRpc("session-recovery", OMP_GOAL_RPC, input) as OmpNativeOutput);
  const ompDetails = async (agent: PaseoAgent): Promise<GoalDetails | null> => {
    if (agent.provider !== "omp") return null;
    const native = await ompNativeGoals.details(agent);
    if (native?.objective) return native;
    const previous = await ompGoals.details(agent), supported = await ompNativeGoals.supported();
    const cleared = native ?? (agent.persistence?.sessionId ? ompNativeDetails(agent.persistence.sessionId, { goal: null, state: null }) : null);
    if (supported && cleared && previous?.sessionControls && previous.objective && ["active", "paused"].includes(previous.reading.state)) return {
      ...previous, sessionControls: false, nativeControls: true, nativeStart: true, nativeRevision: cleared.revision,
      revision: createHash("sha256").update(JSON.stringify([previous.revision, cleared.revision])).digest("hex"),
    };
    return native ?? (previous ? { ...previous, sessionControls: false, ...(supported && previous.reading.nativeContinuation ? { nativeControls: true } : {}) } : null);
  };
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
    const timelineDetails = async (id: string): Promise<GoalDetails> => {
      const unknown: GoalDetails = { reading: { state: "unknown", key: null, evidence: true, source: "timeline" }, objective: null, revision: "", tokenBudget: null, tokensUsed: null };
      let page = await driver.fetchAgentTimeline(id, { projection: "canonical", direction: "tail", limit: 200 });
      const epoch = page.epoch;
      let entries = [...page.entries];
      const cursors = new Set<number>();
      for (let n = 0; n < 10; n++) {
        await check();
        if (page.error || page.gap || page.staleCursor || page.epoch !== epoch || n === 0 && page.hasNewer) return unknown;
        const details = readGoalDetails(entries.sort((a, b) => a.seqEnd - b.seqEnd).map((e) => e.item as GoalItem));
        const { reading } = details;
        if (reading.evidence && (reading.key || reading.state !== "active") || !page.hasOlder) return details;
        if (!page.startCursor || cursors.has(page.startCursor.seq)) break;
        cursors.add(page.startCursor.seq);
        page = await driver.fetchAgentTimeline(id, { projection: "canonical", direction: "before", cursor: page.startCursor, limit: 200 });
        entries = [...page.entries, ...entries];
      }
      return unknown;
    };
    return {
      bootKey, serverId: lock.serverId, store: new FileStore(directory, lock.serverId), fetch,
      async connection(id) {
        await check();
        const value = await driver.invokePluginRpc("session-recovery", CONNECTION_RPC, { op: "inspect", id }) as ConnectionOutput;
        await check();
        return value.protocol === 1 && value.available ? value.state ?? "unknown" : "unknown";
      },
      async reconnectSession(id, expected, guard) {
        await check(); guard();
        const current = await fetch(id);
        if (!current || busy(current) || current.activeTurn !== null || current.archivedAt || fingerprint(current) !== fingerprint(expected)) throw new RecoveryError("The session changed before reconnecting.");
        await check(); guard();
        const result = await driver.invokePluginRpc("session-recovery", CONNECTION_RPC, { op: "reconnect", id, expected }) as ConnectionOutput;
        await check(); guard();
        if (result.protocol !== 1 || !result.available || result.state !== "loaded" || !result.agent) throw new RecoveryError("The session connection could not be restored. Open it and review its state.");
        return metadata(result.agent);
      },
      async goal(id, options) {
        await check();
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        if (!agent) return { state: "unknown", key: null, evidence: true };
        const openCode = await openCodeGoals.read(agent);
        await check();
        if (openCode) return openCode;
        const claude = await claudeGoals.details(agent); await check();
        if (claude) return claude.reading;
        if (agent.persistence?.sessionId) {
          const native = await codexGoals.read(agent.provider, agent.persistence.sessionId);
          await check();
          if (native) return native;
        }
        const omp = options?.allowTimeline === false && !options.inspectOmp ? ompGoals.cached(agent) : await ompDetails(agent);
        if (omp) return omp.reading;
        // 화면의 자동 발견 조회는 휴면 대화를 복원하지 않는다.
        // 사용자의 명시적인 선택과 선택된 Goal의 실행 전 검사는 기존 경로를 쓴다.
        if (options?.allowTimeline === false) return { state: "unknown", key: null, evidence: false, source: "timeline" };
        const { source: _source, ...reading } = (await timelineDetails(id)).reading;
        return reading;
      },
      async workspace(id) {
        await check(); const w = await paseo.workspaces.ref(id).refresh(); await check();
        // Workspace descriptors include active workspaces only; archived ones
        // return null. Session archivedAt is checked independently before send.
        return w ? { id: w.id, archived: false, archiving: Boolean(w.archivingAt) } : null;
      },
      async supportsGoalCommand(id, source = "codex") {
        await check();
        const result = await paseo.agents.ref(id).commands(); await check();
        if (result.error) throw new RecoveryError("Could not check this session's native goal commands. Try again.");
        return nativeGoalCommand(result.commands, source);
      },
      async goalDetails(id, options) {
        await check();
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        if (!agent) return null;
        const details = await ompDetails(agent) ?? await openCodeGoals.details(agent) ?? await claudeGoals.details(agent) ?? (agent.persistence?.sessionId ? await codexGoals.details(agent.provider, agent.persistence.sessionId) : null);
        await check();
        return details ?? (options?.allowTimeline === false ? null : await timelineDetails(id));
      },
      async controlGoal(id, revision, action, expected, guard, messageId, submitted) {
        await check(); guard();
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        checkGoalSession(agent ? metadata(agent) : null, expected, "initial");
        if (!agent?.persistence?.sessionId) throw new RecoveryError("The session's saved history is unavailable.");
        const details = await ompDetails(agent) ?? await openCodeGoals.details(agent) ?? await claudeGoals.details(agent) ?? await codexGoals.details(agent.provider, agent.persistence.sessionId);
        const source = details?.reading.source;
        if (details && source === "omp" && details.nativeControls) {
          if (details.revision !== revision || !details.objective) throw new RecoveryError("The OMP goal changed. Reload its goal controls.");
          const workspace = expected.workspaceId ? await paseo.workspaces.ref(expected.workspaceId).refresh() : null;
          if (!workspace || workspace.archivingAt) throw new RecoveryError("This workspace is unavailable.");
          await check(); guard(); checkGoalSession(await fetch(id), expected, "final");
          if (details.nativeStart) {
            if (action !== "resume" || busy(expected)) throw new RecoveryError("Wait for this turn to finish before starting a native OMP goal.");
            return ompNativeGoals.start(agent, details.nativeRevision!, details.objective, expected, guard, messageId, submitted);
          }
          return ompNativeGoals.control(agent, revision, action, expected, guard, messageId, submitted);
        }
        if (details?.sessionControls && source === "claude") {
          const workspace = expected.workspaceId ? await paseo.workspaces.ref(expected.workspaceId).refresh() : null;
          if (!workspace || workspace.archivingAt) throw new RecoveryError("This workspace is unavailable.");
          if (action === "resume" && driver.getLastServerInfoMessage()?.features?.agentRequestReceipts !== true) throw new RecoveryError("This daemon does not advertise durable message receipts.");
          return controlSessionGoal({ expected, revision, action, guard, submitted,
            fetch: () => fetch(id), details: () => claudeGoals.details(agent),
            pause: () => driver.cancelAgent(id), resume: () => driver.sendAgentMessage(id, GOAL_PROMPT, { messageId, activeTurnBehavior: "steer" }) });
        }
        if (source !== "codex" && source !== "opencode") throw new RecoveryError("This provider does not expose native pause and resume controls.");
        const idleOnly = source === "opencode";
        checkGoalSession(metadata(agent), expected, "initial", idleOnly);
        const commands = await paseo.agents.ref(id).commands();
        if (commands.error || !nativeGoalCommand(commands.commands, source)) throw new RecoveryError("Native goal commands are unavailable for this session.");
        await check(); guard();
        const send = async () => {
          if (driver.getLastServerInfoMessage()?.features?.agentRequestReceipts !== true) throw new RecoveryError("This daemon does not advertise durable message receipts.");
          checkGoalSession(await fetch(id), expected, "final", idleOnly);
          const workspace = expected.workspaceId ? await paseo.workspaces.ref(expected.workspaceId).refresh() : null;
          if (!workspace || workspace.archivingAt) throw new RecoveryError("This workspace is unavailable.");
          await check(); guard(); submitted();
          try { await driver.sendAgentMessage(id, `/goal ${action}`, { messageId, activeTurnBehavior: "steer" }); }
          catch { throw new RecoveryError("The goal action delivery could not be confirmed. Check the conversation and reload before trying again."); }
        };
        return source === "opencode" ? openCodeGoals.control(agent, revision, action, guard, send)
          : codexGoals.control(agent.provider, agent.persistence.sessionId, revision, action, guard, send);
      },
      async editGoal(id, revision, objective, expected, guard, messageId, submitted) {
        await check(); guard();
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        checkGoalSession(agent ? metadata(agent) : null, expected, "initial");
        if (!agent?.persistence?.sessionId) throw new RecoveryError("The session's saved history is unavailable.");
        const details = await openCodeGoals.details(agent) ?? await claudeGoals.details(agent) ?? await codexGoals.details(agent.provider, agent.persistence.sessionId);
        const source = details?.reading.source;
        if (!source || source === "timeline" || source === "omp") throw new RecoveryError("This provider's native goal editor is unavailable.");
        const idleOnly = source !== "codex";
        checkGoalSession(metadata(agent), expected, "initial", idleOnly);
        const workspace = agent.workspaceId ? await paseo.workspaces.ref(agent.workspaceId).refresh() : null;
        if (!workspace || workspace.archivingAt) throw new RecoveryError("This workspace is unavailable.");
        const commands = await paseo.agents.ref(id).commands();
        if (commands.error || !nativeGoalCommand(commands.commands, source)) throw new RecoveryError("Native goal commands are unavailable for this session.");
        await check(); guard();
        try {
          const send = async () => {
            if (driver.getLastServerInfoMessage()?.features?.agentRequestReceipts !== true) throw new RecoveryError("This daemon does not advertise durable message receipts.");
            checkGoalSession(await fetch(id), expected, "final", idleOnly);
            const currentWorkspace = await paseo.workspaces.ref(workspace.id).refresh();
            if (!currentWorkspace || currentWorkspace.archivingAt) throw new RecoveryError("This workspace is unavailable.");
            await check(); guard(); submitted();
            // OpenCode strips one wrapping quote at each edge. Wrapping the raw
            // objective preserves quotes/newlines without JSON escape sequences.
            const command = source === "opencode" ? `/goal edit "${objective.trim()}"` : `/goal ${objective.trim()}`;
            try { await driver.sendAgentMessage(id, command, { messageId, activeTurnBehavior: "steer" }); }
            catch { throw new RecoveryError("The goal edit delivery could not be confirmed. Check the conversation and reload before trying again."); }
          };
          return source === "opencode" ? await openCodeGoals.edit(agent, revision, objective, guard, send)
            : source === "claude" ? await claudeGoals.edit(agent, revision, objective, guard, send)
            : await codexGoals.edit(agent.provider, agent.persistence.sessionId, revision, objective, guard, send);
        } catch (error) { throw new RecoveryError(error instanceof Error ? error.message : "The provider could not confirm the goal edit. Reload before trying again."); }
      },
      async resumeBlockedGoal(id, key, expected, guard, messageId, submitted, identity) {
        await check(); guard();
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        const latest = agent ? metadata(agent) : null;
        checkGoalSession(latest, expected, "initial");
        if (!agent?.persistence?.sessionId) throw new RecoveryError("The session's saved history is unavailable.");
        const workspace = latest.workspaceId ? await paseo.workspaces.ref(latest.workspaceId).refresh() : null;
        if (!workspace || workspace.archivingAt) throw new RecoveryError("This workspace is unavailable.");
        const commands = await paseo.agents.ref(id).commands();
        if (commands.error || !commands.commands.some((command) => command.name === "goal" && command.kind === "command" && command.description === "Set, pause, resume, or clear the agent's goal")) throw new RecoveryError("Codex goal commands are not enabled for this session. Reload it when idle.");
        await check(); guard();
        try {
          return await codexGoals.resumeBlocked(agent.provider, agent.persistence.sessionId, key, guard, async () => {
            if (driver.getLastServerInfoMessage()?.features?.agentRequestReceipts !== true) throw new RecoveryError("This daemon does not advertise durable message receipts.");
            const current = await fetch(id);
            checkGoalSession(current, expected, "final");
            await check(); guard();
            submitted?.();
            await driver.sendAgentMessage(id, "/goal resume", { messageId, activeTurnBehavior: "steer" });
          }, identity);
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
