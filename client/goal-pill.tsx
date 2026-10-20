import type { PluginButtonIconProps, PluginClientContext } from "@getpaseo/plugin/client";
import { goalControlRpc, unwatchGoalRpc, watchGoalRpc, type GoalControl } from "../shared/contracts";
import { createGoalPillController, type GoalPillController } from "./goal-pill-controller";
import { GoalPillIcon } from "./goal-pill-icon";

function label(goal: GoalControl): string {
  if (!goal.selected) return "Goal · Off";
  if (goal.holdReason === "input") return "Goal · Waiting";
  if (!goal.automatic || goal.state === "paused") return "Goal · Paused";
  if (goal.state === "blocked") return "Goal · Blocked";
  if (goal.state === "limited" || goal.attempts >= goal.maxAttempts) return "Goal · Limit";
  if (goal.state !== "active" || goal.holdReason) return "Goal · Review";
  return "Goal · On";
}

export function contributeGoalPills(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  const controller: GoalPillController = createGoalPillController(
    (id, fresh) => client.rpc(goalControlRpc, { id, fresh }),
    (id, workspaceId) => {
      let current: GoalControl | null = null;
      const observe = () => controller.mount(id);
      const Icon = (props: PluginButtonIconProps) => <GoalPillIcon {...props} observe={observe} />;
      const pill = client.addComposerPill({ id: "goal-continuation", agentId: id, workspaceId,
        button: { title: "View current goal", icon: Icon, label: "Goal", behavior: { kind: "action", async onPress() {
          if (!current) { client.openScreen({ screenId: "goal", params: { agentId: id } }); return; }
          let goal = await controller.refresh(id);
          const available = (value: GoalControl) => value.visible && (value.selected || value.canSelect && !!value.key);
          // A turn can finish while the read is in flight. Retry inspection once;
          // never retry a selection, resume command, or other mutation here.
          if (!available(goal) && (goal.state === null || goal.state === "unknown")) goal = await controller.refresh(id);
          if (!available(goal)) throw new Error(goal.note || "This goal is unavailable. Try again.");
          try {
            if (goal.selected) await client.rpc(unwatchGoalRpc, { id });
            else await client.rpc(watchGoalRpc, { id, key: goal.key!, resetAttempts: false, resumeBlocked: true });
          } finally { await controller.refresh(id).catch(() => {}); }
        } } } });
      return { remove: () => pill.remove(), update: (value) => {
        current = value;
        pill.update(value ? { label: label(value), title: value.selected ? `Turn goal continuation off${value.note ? `: ${value.note}` : ""}` : "Turn goal continuation on; resume a blocked Codex goal" }
          : { label: "Goal", title: "View current goal" });
      } };
    },
  );
  let observing = false, starting = false;
  const observe = () => {
    if (lifetime.signal.aborted || observing || starting) return;
    starting = true;
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    lifetime.signal.addEventListener("abort", abort, { once: true });
    // A failed mobile bootstrap must release its partial observation and retry.
    // A successful owned subscription handles later reconnects itself.
    void (async () => {
      try {
        const { subscription } = await client.paseo.agents.list({ scope: "active", sync: {}, subscribe: {}, signal: attempt.signal });
        if (lifetime.signal.aborted) return;
        subscription.subscribe({
          snapshot: ({ entries }) => { controller.snapshot(entries.map(({ agent }) => agent)); void controller.poll(); },
          update: (message) => {
            if (message.type !== "agent_update") return;
            if (message.payload.kind === "remove") controller.remove(message.payload.agentId);
            else controller.upsert(message.payload.agent);
            void controller.poll();
          },
        });
        observing = true;
      } catch {
        attempt.abort();
        if (!lifetime.signal.aborted) console.error("Goal pill session observation failed; retrying.");
      } finally {
        starting = false;
        if (!observing) lifetime.signal.removeEventListener("abort", abort);
      }
    })();
  };
  const timer = setInterval(() => { observe(); void controller.poll(); }, 5000);
  observe();
  return () => { lifetime.abort(); clearInterval(timer); controller.stop(); };
}
