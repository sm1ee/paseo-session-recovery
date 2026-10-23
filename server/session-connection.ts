import type { PaseoAgent } from "@getpaseo/client";
import type { Agent } from "../shared/model";

export const CONNECTION_RPC = "recovery.session.connection.v1";
type Live = { lifecycle: string; activeTurnId: string | null; archivedAt?: unknown; internal?: boolean };
interface ConnectionSession {
  clientId: string; pluginRuntime?: unknown;
  agentManager: { getAgent(id: string): Live | null; listProviderSubagentActivity?(): { parentAgentId: string }[] };
  getAgentPayloadById(id: string): Promise<PaseoAgent | null>;
  emit(message: unknown): void;
  workspaceDirectory?: { deps: Record<string, unknown>; buildDescriptorMap(options?: unknown): unknown };
}
type Input = { op: "capabilities" | "inspect" | "reconnect"; id?: string; expected?: Agent };
export interface ConnectionOutput { protocol: 1; available: boolean; state?: "loaded" | "detached" | "unknown"; restored?: boolean; agent?: PaseoAgent | null }
type Restore = (id: string, session: ConnectionSession) => Promise<unknown>;
const queues = new WeakMap<object, Map<string, Promise<ConnectionOutput>>>();
const installed = new WeakMap<object, () => void>();

// Stored lifecycle is a historical value, not an executing turn. Preserve the
// record itself, including its timestamps and attention state.
export function storedSessionPayload<T extends { status: string; activeTurn?: unknown }>(payload: T): T {
  return { ...payload, status: ["running", "initializing"].includes(payload.status) ? "closed" : payload.status, activeTurn: null };
}
function matches(a: PaseoAgent | null, expected: Agent): boolean {
  if (!a || a.archivedAt || "internal" in a && a.internal || a.pendingPermissions.length || a.attentionReason === "permission") return false;
  return a.id === expected.id && a.provider === expected.provider && (a.workspaceId ?? null) === expected.workspaceId &&
    (a.labels["paseo.parent-agent-id"]?.trim() || null) === expected.parentId && a.persistence?.sessionId === expected.sessionId &&
    a.lastUserMessageAt === expected.lastUserMessageAt &&
    (a.currentModeId === undefined ? a.runtimeInfo?.modeId ?? null : a.currentModeId) === (expected.modeId ?? null);
}
export async function invokeSessionConnection(session: ConnectionSession, input: Input, restore?: Restore): Promise<ConnectionOutput> {
  if (!input || !["capabilities", "inspect", "reconnect"].includes(input.op)) throw new Error("Invalid session connection operation.");
  if (input.op === "capabilities") return { protocol: 1, available: true };
  if (typeof input.id !== "string" || !input.id) throw new Error("The session identity is missing.");
  const id = input.id;
  const inspect = async (): Promise<ConnectionOutput> => {
    const live = session.agentManager.getAgent(id), agent = await session.getAgentPayloadById(id);
    return { protocol: 1, available: true, agent,
      state: !live ? "detached" : ["idle", "running", "initializing"].includes(live.lifecycle) ? "loaded" : "unknown" };
  };
  if (input.op === "inspect") return inspect();
  let queue = queues.get(session.agentManager);
  if (!queue) { queue = new Map(); queues.set(session.agentManager, queue); }
  const task = (queue.get(id) ?? Promise.resolve()).catch(() => {}).then(async (): Promise<ConnectionOutput> => {
    const before = await session.getAgentPayloadById(id);
    if (!input.expected?.sessionId || !matches(before, input.expected)) throw new Error("The session changed before reconnecting.");
    const live = session.agentManager.getAgent(id);
    // Never reload, interrupt or replace an existing provider. The normal
    // loader also shares concurrent opens from the app and other connections.
    if (live) return { ...await inspect(), restored: false };
    if (!restore || before!.activeTurn !== null || !["idle", "error", "closed"].includes(before!.status)) throw new Error("The session connection could not be verified.");
    await restore(id, session);
    return { ...await inspect(), restored: true };
  });
  queue.set(id, task);
  const clear = () => { if (queue!.get(id) === task) queue!.delete(id); };
  void task.then(clear, clear); return task;
}

interface SessionClass { prototype: {
  dispatchPluginMessage(message: { type: string; pluginId?: string; method?: string; input?: unknown; requestId?: string }): unknown;
  buildStoredAgentPayload(record: unknown, registeredProviderIds?: unknown): PaseoAgent;
  buildWorkspaceDescriptorMap?(options?: unknown): unknown;
  handleFetchWorkspacesRequest?(request: unknown): unknown;
} }
export function installSessionConnectionBridge(Session: SessionClass, restore?: Restore,
  workspaceStates?: (session: ConnectionSession) => Promise<{ id: string; status: string }[]>): () => void {
  const existing = installed.get(Session); if (existing) return existing;
  const original = Session.prototype.dispatchPluginMessage, stored = Session.prototype.buildStoredAgentPayload;
  const build = Session.prototype.buildWorkspaceDescriptorMap;
  const fetchWorkspaces = Session.prototype.handleFetchWorkspacesRequest;
  const dispatch: typeof original = function(this: ConnectionSession, message) {
    if (message.type !== "plugin.rpc.invoke.request" || message.pluginId !== "session-recovery" || message.method !== CONNECTION_RPC) return original.call(this, message);
    if (!this.pluginRuntime || !this.clientId.startsWith("session-recovery-")) throw new Error("Session reconnection requires the local recovery connection.");
    return invokeSessionConnection(this, message.input as Input, restore).then((output) => {
      this.emit({ type: "plugin.rpc.invoke.response", payload: { requestId: message.requestId, output } });
    });
  };
  const project: typeof stored = function(this: unknown, record, providers) { return storedSessionPayload(stored.call(this, record, providers)); };
  const prepareWorkspace = (session: ConnectionSession) => {
    if (!workspaceStates) return;
    const directory = session.workspaceDirectory!;
    directory.deps.listAgentPayloads = async () => (await workspaceStates(session)).map((a) =>
      session.agentManager.getAgent(a.id) ? a : storedSessionPayload(a));
    directory.deps.listProviderSubagentActivity = async () => session.agentManager.listProviderSubagentActivity?.().filter((a) => {
      const owner = session.agentManager.getAgent(a.parentAgentId);
      return owner && ["idle", "running"].includes(owner.lifecycle) && !owner.archivedAt && !owner.internal;
    }) ?? [];
  };
  const workspace: typeof build = workspaceStates ? function(this: ConnectionSession, options) {
    prepareWorkspace(this);
    const directory = this.workspaceDirectory!;
    // A provider's persisted child status cannot prove live activity while its
    // owning connection is absent. Keep its native history untouched.
    return directory.buildDescriptorMap(options);
  } : build;
  // Initial directory snapshots enter through WorkspaceDirectory directly,
  // whereas incremental updates use buildWorkspaceDescriptorMap.
  const fetch: typeof fetchWorkspaces = workspaceStates && fetchWorkspaces ? function(this: ConnectionSession, request) {
    prepareWorkspace(this); return fetchWorkspaces.call(this, request);
  } : fetchWorkspaces;
  Session.prototype.dispatchPluginMessage = dispatch;
  Session.prototype.buildStoredAgentPayload = project;
  if (workspace) Session.prototype.buildWorkspaceDescriptorMap = workspace;
  if (fetch) Session.prototype.handleFetchWorkspacesRequest = fetch;
  const remove = () => {
    if (Session.prototype.dispatchPluginMessage === dispatch) Session.prototype.dispatchPluginMessage = original;
    if (Session.prototype.buildStoredAgentPayload === project) Session.prototype.buildStoredAgentPayload = stored;
    if (Session.prototype.buildWorkspaceDescriptorMap === workspace) Session.prototype.buildWorkspaceDescriptorMap = build;
    if (Session.prototype.handleFetchWorkspacesRequest === fetch) Session.prototype.handleFetchWorkspacesRequest = fetchWorkspaces;
    installed.delete(Session);
  };
  installed.set(Session, remove); return remove;
}
