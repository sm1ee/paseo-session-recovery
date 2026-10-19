import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_PROMPT = "The session was interrupted. Review the conversation and current project state, then continue the unfinished task. Check whether commands, file changes, or external actions already completed before repeating them. Respect any user stop request, pending question, or approval requirement. If the task is already complete, report that and stop.";
export const preferences = defineSettings({
  id: "preferences", scope: "host", version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    recoverSubagents: z.boolean().default(false),
    retryTransientErrors: z.boolean().default(false),
    delaySeconds: z.number().int().min(30).max(900).default(60),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    maxOfflineHours: z.number().min(0.25).max(168).default(24),
    prompt: z.string().trim().min(20).max(4000).default(DEFAULT_PROMPT),
    daemonHome: z.string().default(""),
  }),
});
export type Preferences = z.output<typeof preferences.schema>;
export const phaseSchema = z.enum(["watching", "waiting", "interrupted", "scheduled", "review", "sending", "resumed", "completed", "stopped", "dismissed"]);
export const reasonSchema = z.enum([
  "active", "input", "daemon_restart", "shutdown", "runtime_closed", "monitor_gap", "unknown_end", "transient_error", "provider_error",
  "attempt_limit", "too_old", "subagent", "parent_unavailable", "workspace_unavailable", "no_history", "unknown_state", "new_activity", "finished",
  "user_stop", "archived", "missing", "excluded", "disabled", "uncertain_send", "sent", "dismissed",
]);
export type Phase = z.infer<typeof phaseSchema>;
export type Reason = z.infer<typeof reasonSchema>;
export const reasonText: Record<Reason, string> = {
  active: "Watching this turn", input: "Waiting for a question or approval",
  daemon_restart: "An unfinished turn was recorded before the daemon restarted", shutdown: "The daemon stopped during this turn",
  runtime_closed: "The session closed; the cause could not be confirmed", monitor_gap: "The monitor was stopped or reloaded during this turn",
  unknown_end: "The turn stopped without a matching end event", transient_error: "The provider reported a temporary connection or service error",
  provider_error: "The provider reported an error; review it in the session", attempt_limit: "Automatic retry limit reached",
  too_old: "The interruption is older than the recovery window", subagent: "Subagent recovery requires review",
  parent_unavailable: "A parent is active, archived, missing, or waiting for input", workspace_unavailable: "The workspace is archived, missing, or being archived",
  no_history: "Provider history is unavailable", unknown_state: "The session state could not be verified", new_activity: "The conversation changed after the interruption",
  finished: "The turn finished", user_stop: "The turn was stopped", archived: "The session was archived", missing: "The session is no longer available",
  excluded: "Recovery is excluded for this session", disabled: "Automatic recovery is off", uncertain_send: "Delivery could not be confirmed. Open the session before trying again",
  sent: "A continuation was sent", dismissed: "Recovery dismissed",
};
export const auditSchema = z.object({ at: z.number(), id: z.string(), action: z.enum(["scheduled", "resume", "review", "completed", "stopped", "dismissed", "excluded"]), reason: reasonSchema, attempt: z.number().int() });
export const rowSchema = z.object({
  id: z.string(), title: z.string(), provider: z.string(), parentId: z.string().nullable(), workspaceId: z.string().nullable(),
  phase: phaseSchema, reason: reasonSchema, dueAt: z.number().nullable(), lastSeenAt: z.number(), attempts: z.number(), excluded: z.boolean(), canResume: z.boolean(),
});
export type RecoveryRow = z.infer<typeof rowSchema>;
export const statusInput = z.object({ query: z.string().max(200).default(""), view: z.enum(["queue", "watching", "history", "excluded"]).default("queue"), page: z.number().int().min(0).max(1000).default(0) });
export const statusSchema = z.object({
  state: z.enum(["starting", "running", "paused", "error"]), error: z.string().nullable(), scanning: z.boolean(), lastScanAt: z.number().nullable(),
  counts: z.object({ watching: z.number(), scheduled: z.number(), review: z.number(), resumed: z.number(), excluded: z.number() }),
  rows: z.array(rowSchema), total: z.number(), page: z.number(), history: z.array(auditSchema),
});
export type RecoveryStatus = z.infer<typeof statusSchema>;
export const statusRpc = defineRpc({ name: "recovery.status", input: statusInput, output: statusSchema });
const ok = z.object({ ok: z.literal(true) });
export const scanRpc = defineRpc({ name: "recovery.scan", input: z.object({}), output: ok });
export const excludeRpc = defineRpc({ name: "recovery.exclude", input: z.object({ id: z.string().min(1), excluded: z.boolean() }), output: ok });
export const dismissRpc = defineRpc({ name: "recovery.dismiss", input: z.object({ id: z.string().min(1) }), output: ok });
export const prepareRpc = defineRpc({ name: "recovery.prepare", input: z.object({ id: z.string().min(1) }), output: z.object({ token: z.string(), title: z.string(), prompt: z.string(), expiresAt: z.number() }) });
export type ResumePreview = z.infer<typeof prepareRpc.output>;
export const resumeRpc = defineRpc({ name: "recovery.resume", input: z.object({ token: z.string() }), output: ok });
