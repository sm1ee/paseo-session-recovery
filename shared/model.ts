import { z } from "zod";
import { auditSchema, phaseSchema, reasonSchema, type Preferences, type Reason } from "./contracts";

export const HOUR = 3_600_000;
export const OPEN_PHASES = new Set(["watching", "waiting", "interrupted", "scheduled", "review", "sending", "resumed"]);
const timestamp = z.number().finite().nonnegative();
export const recordSchema = z.object({
  id: z.string(), title: z.string(), provider: z.string(), workspaceId: z.string().nullable(), parentId: z.string().nullable(),
  turnId: z.string().nullable(), bootKey: z.string(), startedAt: timestamp, lastSeenAt: timestamp,
  phase: phaseSchema, reason: reasonSchema, dueAt: timestamp.nullable(), attempts: z.number().int().nonnegative(),
  humanRequired: z.boolean(), pendingIds: z.array(z.string()), messageAt: z.string().nullable(),
  attemptMessageId: z.string().nullable(), expectingStart: z.boolean(), revision: z.number().int().nonnegative(),
  goal: z.object({ key: z.string().nullable(), state: z.enum(["active", "paused", "blocked", "limited", "complete", "cleared", "unknown"]), attempts: z.number().int().nonnegative(), selectedKey: z.string().nullable().default(null), modeId: z.string().optional(), identity: z.string().optional() }).optional(),
  goalInterruption: z.object({ key: z.string().min(1), cause: z.enum(["transient_error", "daemon_restart"]), at: timestamp,
    identity: z.string().optional(), sessionId: z.string().nullable().optional() }).optional(),
});
export type RecordEntry = z.infer<typeof recordSchema>;
export const stateSchema = z.object({
  version: z.literal(1), serverId: z.string(), lastBoot: z.string(), records: z.record(z.string(), recordSchema), excluded: z.array(z.string()), history: z.array(auditSchema).max(100),
});
export type SavedState = z.infer<typeof stateSchema>;
export function emptyState(serverId: string): SavedState { return { version: 1, serverId, lastBoot: "", records: {}, excluded: [], history: [] }; }
export interface Agent {
  id: string; title: string; provider: string; workspaceId: string | null; parentId: string | null;
  status: string; activeTurn: string | null | undefined; pendingPermissions: number; archivedAt: string | null;
  lastUserMessageAt: string | null; attentionReason: string | null; attentionTimestamp: string | null;
  persistence: boolean; sessionId?: string | null; internal: boolean; modeId?: string | null;
}
export interface Workspace { id: string; archived: boolean; archiving: boolean }
export function time(value: string | null): number { const result = value ? Date.parse(value) : NaN; return Number.isFinite(result) ? result : 0; }
export function busy(a: Agent): boolean { return !["idle", "error", "closed"].includes(a.status) || a.activeTurn != null || a.pendingPermissions !== 0; }
// Codex goal commands can run during a turn; OpenCode/Claude adapters require
// idle separately. Ordinary continuations still need a verified idle snapshot.
export function goalCommandReady(a: Agent): boolean { return a.persistence && a.pendingPermissions === 0 && ["idle", "running", "error", "closed"].includes(a.status); }
export function fingerprint(a: Agent): string { return JSON.stringify(a); }
export function backoff(settings: Preferences, attempts: number): number { return Math.min(900_000, settings.delaySeconds * 1000 * 2 ** Math.min(attempts, 10)); }
export function isTransient(code: string | undefined): boolean {
  return /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|connection_lost|connection_reset|network_error|service_unavailable|server_overloaded|overloaded_error|model_overloaded|model_capacity_exceeded|502|503|504|529)$/i.test(code ?? "");
}
export function normalizeProviderErrorCode(provider: string, error: { code?: string; message: string }): string | undefined {
  // Paseo's Codex adapter can omit the code for this exact temporary failure.
  if (error.code === undefined && provider === "codex" && error.message === "Selected model is at capacity. Please try a different model.") return "server_overloaded";
  return error.code;
}
export function isGoalContinuation(r: RecordEntry): boolean { return r.goal?.state === "active" && ["goal_active", "goal_limit", "goal_disabled", "goal_unselected"].includes(r.reason); }
export function isSelectedGoal(r: RecordEntry): boolean { return !!r.goal?.key && r.goal.selectedKey === r.goal.key; }
export function automaticBlock(r: RecordEntry, settings: Preferences, now: number): Reason | null {
  if (!settings.enabled) return "disabled";
  if (r.humanRequired) return "input";
  if (r.goalInterruption) {
    if (!isSelectedGoal(r) || r.goal!.key !== r.goalInterruption.key) return "goal_unselected";
    if (!settings.continueGoals) return "goal_disabled";
    if (!settings.recoverInterruptedGoals) return "goal_recovery_disabled";
    if ((r.goal?.attempts ?? 0) >= settings.goalMaxAttempts) return "goal_limit";
    if (r.attempts >= settings.maxAttempts) return "attempt_limit";
    if (now < r.goalInterruption.at || now - r.goalInterruption.at > settings.maxOfflineHours * HOUR) return "too_old";
  }
  if (r.reason === "goal_active") {
    if (!isSelectedGoal(r)) return "goal_unselected";
    if (!settings.continueGoals) return "goal_disabled";
    if ((r.goal?.attempts ?? 0) >= settings.goalMaxAttempts) return "goal_limit";
  } else if (r.attempts >= settings.maxAttempts) return "attempt_limit";
  if (now < r.lastSeenAt || now - r.lastSeenAt > settings.maxOfflineHours * HOUR) return "too_old";
  if (r.parentId && !settings.recoverSubagents) return "subagent";
  return null;
}
export function snapshotBlock(a: Agent | null, r: RecordEntry, workspace: Workspace | null): Reason | null {
  if (!a) return "missing";
  if (a.internal || a.workspaceId !== r.workspaceId || a.provider !== r.provider || a.parentId !== r.parentId) return "unknown_state";
  if (isGoalContinuation(r) && r.goal?.modeId && a.modeId !== r.goal.modeId) return "unknown_state";
  if (a.archivedAt) return "archived";
  if (!workspace || workspace.archived || workspace.archiving) return "workspace_unavailable";
  if (a.pendingPermissions > 0 || r.humanRequired) return "input";
  if (a.pendingPermissions < 0 || a.activeTurn === undefined) return "unknown_state";
  if (busy(a)) return "new_activity";
  if (!a.persistence) return "no_history";
  if (!isGoalContinuation(r) && !r.goalInterruption && a.attentionReason === "finished" && time(a.attentionTimestamp) >= r.startedAt) return "finished";
  if (r.messageAt !== null && a.lastUserMessageAt !== r.messageAt) return "new_activity";
  if (r.messageAt === null && time(a.lastUserMessageAt) > r.lastSeenAt) return "new_activity";
  return null;
}
export function holdIds(state: SavedState): string[] { return Object.values(state.records).filter((r) => OPEN_PHASES.has(r.phase) && !state.excluded.includes(r.id)).map((r) => r.id); }
