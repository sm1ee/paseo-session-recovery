import type { PluginServerContext } from "@getpaseo/plugin/server";
import { RecoveryService } from "./server/service";
import { dismissRpc, excludeRpc, preferences, prepareRpc, resumeRpc, scanRpc, statusRpc, watchGoalRpc, unwatchGoalRpc, goalControlRpc } from "./shared/contracts";
import { readGoalRpc, editGoalRpc } from "./shared/goal-editor";
import { actOnGoalRpc } from "./shared/goal-actions";
import { ompNativeRpc } from "./shared/omp-native-rpc";
import { sessionConnectionRpc } from "./shared/session-connection-rpc";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const service = new RecoveryService();
  const configure = async () => { const state = await settings.read(); if (state.status === "ready") await service.configure(state.values); else await service.invalidSettings(); };
  const unsubscribe = settings.subscribe((state) => state.status === "ready" ? service.configure(state.values) : service.invalidSettings());
  void configure().catch(() => {});
  server.on("agent.turn_started", (e) => service.observe({ kind: "start", agent: e.agent, turnId: e.turnId }));
  // Keep provider codes, never conversation text or raw error messages.
  server.on("agent.turn_ended", (e) => service.observe({ kind: "end", agent: e.agent, turnId: e.turnId, outcome: e.outcome.kind === "failed" ? { kind: "failed", error: { code: e.outcome.error.code } } : e.outcome }));
  server.on("agent.permission_requested", (e) => service.observe({ kind: "permission", agent: e.agent, requestId: e.request.id }));
  server.on("agent.permission_resolved", (e) => service.observe({ kind: "resolution", agent: e.agent, requestId: e.requestId, allowed: e.resolution.behavior === "allow" }));
  server.on("agent.closed", (e) => service.observe({ kind: "closed", agent: e.agent }));
  server.on("agent.archived", (e) => service.observe({ kind: "archived", agent: e.agent }));
  server.handle(statusRpc, (input) => service.status(input));
  server.handle(scanRpc, () => service.requestScan());
  server.handle(watchGoalRpc, ({ id, key, resetAttempts, resumeBlocked }) => service.watchGoal(id, key, resetAttempts, resumeBlocked));
  server.handle(unwatchGoalRpc, ({ id }) => service.unwatchGoal(id));
  server.handle(goalControlRpc, ({ id, fresh, inspect, preview }) => service.goalControl(id, fresh, inspect, preview));
  server.handle(readGoalRpc, ({ id }) => service.readGoalEditor(id));
  server.handle(editGoalRpc, (input) => service.editGoal(input));
  server.handle(actOnGoalRpc, (input) => service.actOnGoal(input));
  server.handle(ompNativeRpc, () => ({ protocol: 1 as const, available: false }));
  server.handle(sessionConnectionRpc, () => ({ protocol: 1 as const, available: false }));
  server.handle(excludeRpc, ({ id, excluded }) => service.exclude(id, excluded));
  server.handle(dismissRpc, ({ id }) => service.dismiss(id));
  server.handle(prepareRpc, ({ id }) => service.prepare(id));
  server.handle(resumeRpc, ({ token }) => service.resume(token));
  return async () => { unsubscribe(); await service.stop(); };
}
