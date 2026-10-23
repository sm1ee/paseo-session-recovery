import { createHash } from "node:crypto";
import type { PaseoAgent } from "@getpaseo/client";
import type { Agent } from "../shared/model";
import type { GoalDetails, GoalReading } from "./goals";

// This module is also compiled as a small, version-pinned daemon companion.
// It uses the owning OMP transport. Reads never restore a provider; explicit
// actions may reopen the owning session through the daemon's shared loader.
export const OMP_GOAL_RPC = "recovery.omp.native.v1";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const states: Record<string, GoalReading["state"]> = { active: "active", paused: "paused", complete: "complete", dropped: "cleared", "budget-limited": "limited" };

export function ompNativeDetails(sessionId: string, value: unknown): GoalDetails {
  const data = object(value);
  if (!data || !Object.hasOwn(data, "goal") || !Object.hasOwn(data, "state")) throw new Error("OMP did not return a valid goal snapshot.");
  if (data.goal === null && data.state === null) return { reading: { source: "omp", state: "cleared", key: null, evidence: true, nativeContinuation: true },
    objective: null, revision: digest(JSON.stringify([sessionId, null])), tokenBudget: null, tokensUsed: null };
  const goal = object(data.goal), state = object(data.state), stateGoal = object(state?.goal);
  const objective = typeof goal?.objective === "string" ? goal.objective.trim() : "";
  const number = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!goal || !state || !stateGoal || typeof state.enabled !== "boolean" || !objective || objective.length > 16_000 || typeof goal.id !== "string" || !goal.id ||
    !Object.hasOwn(states, String(goal.status)) || !number(goal.tokensUsed) || goal.tokenBudget !== undefined && !number(goal.tokenBudget) ||
    stateGoal.id !== goal.id || stateGoal.objective !== goal.objective || stateGoal.status !== goal.status || stateGoal.tokenBudget !== goal.tokenBudget ||
    state.enabled !== (goal.status === "active")) throw new Error("OMP's current goal could not be verified.");
  return { reading: { source: "omp", state: states[String(goal.status)], key: digest(objective), evidence: true, nativeContinuation: true }, objective,
    identity: goal.id, revision: digest(JSON.stringify([sessionId, goal.id, objective, states[String(goal.status)], goal.tokenBudget])),
    tokenBudget: number(goal.tokenBudget) ? goal.tokenBudget : null, tokensUsed: goal.tokensUsed };
}

export interface OmpNativeInput {
  op: "capabilities" | "get" | "pause" | "resume" | "create";
  id?: string; sessionId?: string; revision?: string; operationId?: string;
  expected?: Agent; objective?: string;
}
export interface OmpNativeOutput { protocol: 1; available: boolean; details?: GoalDetails; notSubmitted?: boolean; error?: string }
export class OmpGoalPreconditionError extends Error {}
interface Runtime { process?: { request(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown> }; getState(): Promise<{ sessionId: string }>; }
interface OmpSession { runtimeSession?: Runtime; closed?: boolean; runtimeDead?: boolean; provider?: string; describePersistence?(): { sessionId: string; nativeHandle?: string } | null }
interface Live { provider: string; archivedAt?: unknown; internal?: boolean; session?: OmpSession }
interface BridgeSession {
  clientId: string;
  agentManager: { getAgent(id: string): Live | null | undefined };
  getAgentPayloadById(id: string): Promise<PaseoAgent | null>;
  pluginRuntime?: unknown;
  agentStorage?: unknown; sessionLogger?: unknown;
  emit(message: unknown): void;
}

const stable = ["id", "provider", "workspaceId", "parentId", "sessionId", "lastUserMessageAt", "modeId"] as const;
function matches(agent: PaseoAgent | null, expected: Agent): boolean {
  if (!agent || agent.archivedAt || "internal" in agent && agent.internal === true || agent.pendingPermissions.length || agent.attentionReason === "permission") return false;
  const current = { ...agent, parentId: agent.labels["paseo.parent-agent-id"]?.trim() || null, sessionId: agent.persistence?.sessionId ?? null,
    modeId: agent.currentModeId === undefined ? agent.runtimeInfo?.modeId ?? null : agent.currentModeId };
  return stable.every((key) => current[key] === expected[key]);
}

const managerQueues = new WeakMap<object, Map<string, Promise<unknown>>>();
const usedOperations = new WeakMap<object, Map<string, number>>();
const installed = new WeakMap<object, () => void>();
const connections = new Map<string, Set<WeakRef<OmpSession>>>();
const trackedClients = new WeakMap<object, () => void>();
export function rememberOmpSessions(sessions: readonly OmpSession[]): number {
  let count = 0;
  for (const session of sessions) {
    if (session.provider !== "omp" || session.closed || session.runtimeDead || !session.runtimeSession?.process?.request) continue;
    const id = session.describePersistence?.()?.sessionId; if (!id) continue;
    let entries = connections.get(id);
    if (!entries) { entries = new Set(); connections.set(id, entries); }
    for (const reference of entries) { const value = reference.deref(); if (!value || value.closed || value.runtimeDead) entries.delete(reference); }
    if (![...entries].some((entry) => entry.deref() === session)) { entries.add(new WeakRef(session)); count++; }
  }
  // Keys also expire when old sessions have been collected or closed.
  for (const [id, entries] of connections) if (![...entries].some((entry) => { const s = entry.deref(); return s && !s.closed && !s.runtimeDead; })) connections.delete(id);
  return count;
}
function connection(owner: OmpSession | undefined, sessionId: string): OmpSession | null {
  if (owner?.runtimeSession) return owner;
  const handle = owner?.describePersistence?.();
  if (!handle || handle.sessionId !== sessionId) return null;
  const matches = [...connections.get(sessionId) ?? []].map((entry) => entry.deref()).filter((raw): raw is OmpSession => {
    if (!raw || raw.closed || raw.runtimeDead) return false;
    const current = raw.describePersistence?.(); return current?.sessionId === sessionId && current.nativeHandle === handle.nativeHandle;
  });
  return matches.length === 1 ? matches[0] : null;
}
export function installOmpSessionTracking(Client: { prototype: Record<"createSession" | "resumeSession", (...args: unknown[]) => Promise<OmpSession>> }): () => void {
  const previous = trackedClients.get(Client); if (previous) return previous;
  const originals = { createSession: Client.prototype.createSession, resumeSession: Client.prototype.resumeSession };
  const wrappers = { ...originals };
  for (const name of ["createSession", "resumeSession"] as const) {
    wrappers[name] = async function(...args) { const session = await originals[name].apply(this, args); rememberOmpSessions([session]); return session; };
    Client.prototype[name] = wrappers[name];
  }
  const remove = () => { for (const name of ["createSession", "resumeSession"] as const) if (Client.prototype[name] === wrappers[name]) Client.prototype[name] = originals[name]; trackedClients.delete(Client); };
  trackedClients.set(Client, remove); return remove;
}
export type OmpRestore = (id: string, session: BridgeSession) => Promise<void>;
export async function invokeOmpNative(session: BridgeSession, input: OmpNativeInput, restore?: OmpRestore): Promise<OmpNativeOutput> {
  if (!object(input) || !["capabilities", "get", "pause", "resume", "create"].includes(input.op)) throw new Error("Invalid OMP goal operation.");
  if (input.op === "capabilities") return { protocol: 1, available: true };
  if (typeof input.id !== "string" || !input.id || typeof input.sessionId !== "string" || !input.sessionId) throw new Error("The OMP session identity is missing.");
  const id = input.id;
  let queue = managerQueues.get(session.agentManager);
  if (!queue) { queue = new Map(); managerQueues.set(session.agentManager, queue); }
  const previous = queue.get(id) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async (): Promise<OmpNativeOutput> => {
    let submitted = false;
    try {
    if (input.op !== "get" && restore && !connection(session.agentManager.getAgent(id)?.session, input.sessionId!)) {
      // A user's explicit action may reopen its one owning session. A read
      // never does so. The normal daemon loader shares concurrent restores.
      if (!input.expected || !matches(await session.getAgentPayloadById(id), input.expected)) throw new Error("The session changed or needs input. Reload its goal controls.");
      await restore(id, session);
    }
    const live = session.agentManager.getAgent(id), owner = live?.session, raw = connection(owner, input.sessionId!), runtime = raw?.runtimeSession;
    if (!live || live.provider !== "omp" || live.archivedAt || live.internal || !owner || !raw || raw.closed || raw.runtimeDead || !runtime?.process?.request) {
      if (input.op === "get") return { protocol: 1, available: false };
      throw new Error("Open this OMP session before using its native goal controls.");
    }
    const check = () => {
      const current = session.agentManager.getAgent(id);
      if (current?.session !== owner || connection(owner, input.sessionId!) !== raw || raw.runtimeSession !== runtime || raw.closed || raw.runtimeDead || current.archivedAt || current.internal) throw new Error("The OMP connection changed. Reload its goal controls.");
    };
    const nativeState = await runtime.getState(); check();
    if (nativeState.sessionId !== input.sessionId) throw new Error("The OMP session changed. Reload its goal controls.");
    const before = ompNativeDetails(input.sessionId!, await runtime.process.request({ type: "goal", op: "get" }, 4000)); check();
    if (input.op === "get") return { protocol: 1, available: true, details: before };
    if (!input.expected || input.expected.id !== id || input.expected.sessionId !== input.sessionId || typeof input.operationId !== "string" || !input.operationId || before.revision !== input.revision) throw new Error("The OMP goal changed. Reload its goal controls.");
    if (!matches(await session.getAgentPayloadById(id), input.expected)) throw new Error("The session changed or needs input. Reload its goal controls.");
    check();
    if (input.op === "create" ? before.objective !== null || typeof input.objective !== "string" || !input.objective.trim() || input.objective.length > 16_000
      : !before.objective || before.reading.state !== (input.op === "pause" ? "active" : "paused")) throw new Error("This native goal action is unavailable in the current state.");
    let used = usedOperations.get(session.agentManager);
    if (!used) { used = new Map(); usedOperations.set(session.agentManager, used); }
    const now = Date.now();
    for (const [key, at] of used) if (now - at > 600_000) used.delete(key);
    if (used.has(input.operationId)) { submitted = true; throw new Error("This goal operation was already submitted. Reload."); }
    if (used.size >= 1000) throw new Error("The OMP goal bridge is busy. Reload.");
    used.set(input.operationId, now);
    // No retries: a lost response must remain an uncertain delivery in the
    // plugin journal. Pause does not abort the current model turn.
    submitted = true;
    const result = await runtime.process.request({ type: "goal", op: input.op, ...(input.op === "create" ? { objective: input.objective!.trim() } : {}) }, 8000);
    check();
    const after = ompNativeDetails(input.sessionId!, result);
    if (after.reading.state !== (input.op === "pause" ? "paused" : "active") || input.op !== "create" && (after.identity !== before.identity || after.objective !== before.objective || after.tokenBudget !== before.tokenBudget || (after.tokensUsed ?? 0) < (before.tokensUsed ?? 0))) throw new Error("OMP could not confirm the native goal action. Reload before trying again.");
    return { protocol: 1, available: true, details: after };
    } catch (error) {
      if (!submitted && input.op !== "get" && error instanceof Error) Object.assign(error, { ompGoalNotSubmitted: true });
      throw error;
    }
  });
  queue.set(id, task);
  const clear = () => { if (queue!.get(id) === task) queue!.delete(id); };
  void task.then(clear, clear); return task;
}

// The installer verifies the exact daemon sources before loading this hook.
// Normal plugin RPCs retain Paseo's original dispatcher and authentication.
export function installOmpNativeBridge(Session: { prototype: { dispatchPluginMessage: (msg: { type: string; pluginId?: string; method?: string; input?: unknown; requestId?: string }) => unknown } }, restore?: OmpRestore): () => void {
  const existing = installed.get(Session); if (existing) return existing;
  const original = Session.prototype.dispatchPluginMessage;
  const wrapper: typeof original = function(this: BridgeSession, message) {
    if (message.type !== "plugin.rpc.invoke.request" || message.pluginId !== "session-recovery" || message.method !== OMP_GOAL_RPC) return original.call(this, message);
    if (!this.pluginRuntime || !this.clientId.startsWith("session-recovery-")) throw new Error("OMP goal controls require the local recovery connection.");
    return invokeOmpNative(this, message.input as OmpNativeInput, restore).catch((error: unknown): OmpNativeOutput => {
      if (!(error instanceof Error) || !("ompGoalNotSubmitted" in error) || !error.ompGoalNotSubmitted) throw error;
      return { protocol: 1, available: false, notSubmitted: true, error: /Could not restore model/i.test(error.message)
        ? "The saved OMP model is unavailable. Choose another model in Paseo and retry." : error.message };
    }).then((output) => { this.emit({ type: "plugin.rpc.invoke.response", payload: { requestId: message.requestId, output } }); });
  };
  Session.prototype.dispatchPluginMessage = wrapper;
  const remove = () => { if (Session.prototype.dispatchPluginMessage === wrapper) Session.prototype.dispatchPluginMessage = original; installed.delete(Session); };
  installed.set(Session, remove); return remove;
}

export class OmpNativeGoals {
  private enabled: boolean | null = null;
  private probe: Promise<boolean> | null = null;
  private pending = new Map<string, Promise<GoalDetails | null>>();
  constructor(private readonly rpc: (input: OmpNativeInput) => Promise<OmpNativeOutput>) {}
  supported(): Promise<boolean> {
    if (this.enabled !== null) return Promise.resolve(this.enabled);
    if (!this.probe) this.probe = this.rpc({ op: "capabilities" }).then((v) => this.enabled = v.protocol === 1 && v.available === true, () => this.enabled = false);
    return this.probe;
  }
  async details(agent: PaseoAgent): Promise<GoalDetails | null> {
    if (agent.provider !== "omp" || !agent.persistence?.sessionId || !await this.supported()) return null;
    const key = JSON.stringify([agent.id, agent.persistence.sessionId]);
    const previous = this.pending.get(key); if (previous) return previous;
    const task = this.rpc({ op: "get", id: agent.id, sessionId: agent.persistence.sessionId }).then((result) => {
      if (result.protocol !== 1) throw new Error("The OMP bridge protocol changed.");
      return result.available && result.details ? { ...result.details, nativeControls: true } : null;
    });
    this.pending.set(key, task); void task.finally(() => this.pending.delete(key)).catch(() => {}); return task;
  }
  async control(agent: PaseoAgent, revision: string, action: "pause" | "resume", expected: Agent, guard: () => void, operationId: string, submitted: () => void): Promise<GoalReading> {
    if (!await this.supported()) throw new Error("This daemon does not expose OMP's native goal controls.");
    guard();
    submitted();
    const result = await this.rpc({ op: action, id: agent.id, sessionId: agent.persistence?.sessionId, revision, expected, operationId });
    if (result.notSubmitted) throw new OmpGoalPreconditionError(result.error ?? "The native goal action was not submitted. Reload.");
    guard(); if (!result.available || !result.details) throw new Error("OMP could not confirm this goal action. Reload.");
    return result.details.reading;
  }
  async start(agent: PaseoAgent, revision: string, objective: string, expected: Agent, guard: () => void, operationId: string, submitted: () => void): Promise<GoalReading> {
    if (!await this.supported()) throw new Error("This daemon does not expose OMP's native goal controls.");
    guard();
    submitted();
    const result = await this.rpc({ op: "create", id: agent.id, sessionId: agent.persistence?.sessionId, revision, objective, expected, operationId });
    if (result.notSubmitted) throw new OmpGoalPreconditionError(result.error ?? "The native goal action was not submitted. Reload.");
    guard();
    if (!result.available || !result.details || result.details.objective !== objective.trim()) throw new Error("OMP could not confirm the new native goal. Reload.");
    return result.details.reading;
  }
}
