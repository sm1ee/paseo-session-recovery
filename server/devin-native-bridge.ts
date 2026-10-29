import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { GoalDetails } from "./goals";

export const DEVIN_GOAL_RPC = "recovery.devin.native.v1";
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export interface DevinGoalDetails extends GoalDetails { nativeTurns: number }
const states = { running: "active", paused: "paused", blocked: "blocked", complete: "complete", cleared: "cleared" } as const;
export function devinNativeDetails(sessionId: string, value: unknown): DevinGoalDetails {
  const data = object(value);
  if (!data || data.error != null || data.isError === true || "jsonrpc" in data) throw new Error("Devin did not return a goal snapshot.");
  // Devin 3000.11.228 returns {} before a goal is set. Errors and unrelated
  // payloads must never be mistaken for that successful empty response.
  if (!Object.keys(data).length || data.goal === null) return { reading: { source: "devin", state: "cleared", key: null, evidence: true, nativeContinuation: true },
    objective: null, revision: hash([sessionId, null]), identity: undefined, tokenBudget: null, tokensUsed: null, nativeTurns: 0, nativeControls: true, sessionControls: true };
  const goal = object(data.goal);
  if (!goal || typeof goal.id !== "string" || !goal.id || goal.id.length > 200 || typeof goal.objective !== "string" ||
      !goal.objective.trim() || goal.objective.length > 16_000 || !Object.hasOwn(states, String(goal.status)) ||
      !Number.isSafeInteger(goal.turns) || (goal.turns as number) < 0) throw new Error("Devin's current goal could not be verified.");
  const objective = goal.objective.trim(), state = states[goal.status as keyof typeof states];
  return { reading: { source: "devin", state, key: hash([goal.id, objective]), evidence: true, identity: goal.id, nativeContinuation: true },
    objective, identity: goal.id, revision: hash([sessionId, goal.id, objective, state]), nativeTurns: goal.turns as number,
    tokenBudget: null, tokensUsed: null, nativeControls: true, sessionControls: true };
}

export function isDevinProvider(config: unknown, provider: string): boolean {
  const entries = object(object(object(config)?.agents)?.providers);
  const seen = new Set<string>(); let id = provider, command: unknown;
  while (id !== "acp") {
    if (seen.has(id) || seen.size >= 10) return false;
    seen.add(id);
    const entry = object(entries?.[id]);
    if (!entry || typeof entry.extends !== "string") return false;
    command ??= entry.command; id = entry.extends;
  }
  const argv = Array.isArray(command) && command.every(v => typeof v === "string") ? command as string[] : [];
  return !argv.some(arg => /^--cloud(?:=|$)/.test(arg)) && argv.length > 1 && ["devin", "devin.exe"].includes(basename(argv[0])) && argv.includes("acp");
}

interface AcpSession {
  closed?: boolean; connection?: { extMethod(method: string, params: Record<string, unknown>): Promise<unknown> } | null;
  sessionId?: string | null; describePersistence?(): { sessionId: string; nativeHandle?: string } | null;
}
interface Live { provider: string; archivedAt?: unknown; internal?: boolean; session?: AcpSession }
interface BridgeSession {
  clientId: string; pluginRuntime?: unknown;
  agentManager: { getAgent(id: string): Live | null | undefined };
  emit(message: unknown): void;
}
export interface DevinNativeInput { op: "capabilities" | "get"; id?: string; sessionId?: string; provider?: string }
export interface DevinNativeOutput { protocol: 1; available: boolean; details?: DevinGoalDetails }
const connections = new Map<string, Set<WeakRef<AcpSession>>>();
const tracked = new WeakMap<object, () => void>();
const installed = new WeakMap<object, () => void>();
const reads = new WeakMap<object, Map<string, Promise<DevinNativeOutput>>>();
export function rememberDevinSessions(sessions: readonly AcpSession[]): void {
  for (const raw of sessions) {
    const id = raw.describePersistence?.()?.sessionId;
    if (!id || raw.closed || !raw.connection?.extMethod) continue;
    let entries = connections.get(id);
    if (!entries) { entries = new Set(); connections.set(id, entries); }
    if (![...entries].some(ref => ref.deref() === raw)) entries.add(new WeakRef(raw));
  }
  for (const [id, entries] of connections) {
    for (const ref of entries) { const raw = ref.deref(); if (!raw || raw.closed || !raw.connection) entries.delete(ref); }
    if (!entries.size) connections.delete(id);
  }
}
function connection(owner: AcpSession | undefined, id: string): AcpSession | null {
  if (owner?.connection?.extMethod && owner.sessionId === id && !owner.closed) return owner;
  const handle = owner?.describePersistence?.(); if (handle?.sessionId !== id) return null;
  const found = [...connections.get(id) ?? []].map(ref => ref.deref()).filter((raw): raw is AcpSession => {
    const actual = raw?.describePersistence?.();
    return !!raw && !raw.closed && !!raw.connection?.extMethod && raw.sessionId === id && actual?.sessionId === id && actual.nativeHandle === handle.nativeHandle;
  });
  return found.length === 1 ? found[0] : null;
}
export function installDevinSessionTracking(Client: { prototype: Record<"createSession" | "resumeSession", (...args: unknown[]) => Promise<AcpSession>> }): () => void {
  const previous = tracked.get(Client); if (previous) return previous;
  const originals = { createSession: Client.prototype.createSession, resumeSession: Client.prototype.resumeSession }, wrappers = { ...originals };
  for (const name of ["createSession", "resumeSession"] as const) {
    wrappers[name] = async function(...args) { const raw = await originals[name].apply(this, args); rememberDevinSessions([raw]); return raw; };
    Client.prototype[name] = wrappers[name];
  }
  const remove = () => { for (const name of ["createSession", "resumeSession"] as const) if (Client.prototype[name] === wrappers[name]) Client.prototype[name] = originals[name]; tracked.delete(Client); };
  tracked.set(Client, remove); return remove;
}
export async function invokeDevinNative(session: BridgeSession, input: DevinNativeInput): Promise<DevinNativeOutput> {
  if (!object(input) || !["capabilities", "get"].includes(input.op)) throw new Error("Invalid Devin goal operation.");
  if (input.op === "capabilities") return { protocol: 1, available: true };
  if (!input.id || !input.sessionId || !input.provider) throw new Error("The Devin session identity is missing.");
  const { id, sessionId, provider } = input, live = session.agentManager.getAgent(id), raw = connection(live?.session, sessionId);
  if (!live || live.provider !== provider || live.archivedAt || live.internal || !raw?.connection) return { protocol: 1, available: false };
  const owner = live.session;
  let pending = reads.get(session.agentManager); if (!pending) { pending = new Map(); reads.set(session.agentManager, pending); }
  const key = JSON.stringify([id, sessionId, provider]); const existing = pending.get(key); if (existing) return existing;
  const task = (async (): Promise<DevinNativeOutput> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Use the exact Devin extension method on its owning connection. Never
      // restore a session on a read, or expose an arbitrary extension method.
      const value = await Promise.race([raw.connection!.extMethod("_cognition.ai/goal/get", { sessionId }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Devin goal lookup timed out.")), 4000); })]);
      const current = session.agentManager.getAgent(id);
      if (!current || current.session !== owner || current.provider !== provider || current.archivedAt || current.internal || connection(current.session, sessionId) !== raw)
        throw new Error("The Devin connection changed. Reload its goal controls.");
      return { protocol: 1, available: true, details: devinNativeDetails(sessionId, value) };
    } finally { clearTimeout(timer); }
  })();
  pending.set(key, task); const clear = () => { if (pending!.get(key) === task) pending!.delete(key); }; void task.then(clear, clear); return task;
}
export function installDevinNativeBridge(Session: { prototype: { dispatchPluginMessage(message: { type: string; pluginId?: string; method?: string; input?: unknown; requestId?: string }): unknown } }): () => void {
  const previous = installed.get(Session); if (previous) return previous;
  const original = Session.prototype.dispatchPluginMessage;
  const wrapper: typeof original = function(this: BridgeSession, msg) {
    if (msg.type !== "plugin.rpc.invoke.request" || msg.pluginId !== "session-recovery" || msg.method !== DEVIN_GOAL_RPC) return original.call(this, msg);
    if (!this.pluginRuntime || !this.clientId.startsWith("session-recovery-")) throw new Error("Devin goal lookup requires the local recovery connection.");
    return invokeDevinNative(this, msg.input as DevinNativeInput).then(output => this.emit({ type: "plugin.rpc.invoke.response", payload: { requestId: msg.requestId, output } }));
  };
  Session.prototype.dispatchPluginMessage = wrapper;
  const remove = () => { if (Session.prototype.dispatchPluginMessage === wrapper) Session.prototype.dispatchPluginMessage = original; installed.delete(Session); };
  installed.set(Session, remove); return remove;
}
