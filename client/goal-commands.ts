import type { PluginClientContext } from "@getpaseo/plugin/client";
import { readGoalRpc } from "../shared/goal-editor";

export function contributeGoalCommands(client: PluginClientContext): () => void {
  const removers = [
    client.addCommandCenterItem({ id: "edit-goal", title: "View or edit this session's goal", icon: "Target", context: "agent", onSelect({ agent, openScreen }) {
      openScreen({ screenId: "goal", params: { agentId: agent.id } });
    } }),
    client.addSlashCommand({ name: "goal", description: "View or edit the current goal, or use a native goal command", argumentHint: "[edit|<objective>|pause|resume|clear]", context: "agent", async onSubmit({ args, agent, openScreen, paseo, rpc }) {
      if (!args || args.toLowerCase() === "edit") {
        const goal = await rpc(readGoalRpc, { id: agent.id });
        if (goal.supported) { openScreen({ screenId: "goal", params: { agentId: agent.id } }); return; }
      }
      // SDK sends go to the daemon, not through client slash parsing again.
      // Preserve all providers' existing nonempty /goal command behavior.
      await paseo.agents.ref(agent.id).send(args ? `/goal ${args}` : "/goal");
    } }),
    client.addSlashCommand({ name: "goal-edit", description: "View or edit this session's goal", argumentHint: "", context: "agent", onSubmit({ agent, openScreen }) {
      openScreen({ screenId: "goal", params: { agentId: agent.id } });
    } }),
  ];
  return () => { for (const remove of removers) remove(); };
}
