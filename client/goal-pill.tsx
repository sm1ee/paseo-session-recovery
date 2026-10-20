import type { PluginClientContext } from "@getpaseo/plugin/client";
import { goalControlRpc, unwatchGoalRpc, watchGoalRpc } from "../shared/contracts";
import { GoalPillController } from "./goal-pill-controller";

export function contributeGoalPills(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  const controller: GoalPillController = new GoalPillController(
    (id, fresh) => client.rpc(goalControlRpc, { id, fresh }),
    (id, workspaceId) => {
      const pill = client.addComposerPill({ id: "goal-continuation", agentId: id, workspaceId,
        button: { title: "Toggle goal continuation", icon: "Target", label: "Goal", behavior: { kind: "action", async onPress() {
          const goal = await controller.refresh(id);
          if (!goal.visible || !goal.selected && (!goal.canSelect || !goal.key)) throw new Error("This goal is unavailable. Try again.");
          try {
            if (goal.selected) await client.rpc(unwatchGoalRpc, { id });
            else await client.rpc(watchGoalRpc, { id, key: goal.key!, resetAttempts: false });
          } finally { await controller.refresh(id).catch(() => {}); }
        } } } });
      return { remove: () => pill.remove(), update: (value) => pill.update({ label: `Goal · ${value.selected ? "On" : "Off"}`, title: `Turn goal continuation ${value.selected ? "off" : "on"}` }) };
    },
  );
  const timer = setInterval(() => { void controller.poll(); }, 5000);
  // A synced active directory includes every page, including older sessions.
  void client.paseo.agents.list({ scope: "active", sync: {}, subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
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
  }).catch(() => { if (!lifetime.signal.aborted) console.error("Goal pill session observation failed."); });
  return () => { lifetime.abort(); clearInterval(timer); controller.stop(); };
}
