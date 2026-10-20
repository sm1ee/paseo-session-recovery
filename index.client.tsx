import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Platform } from "react-native";
import { RecoveryScreen } from "./client/screen";
import { RecoverySettings } from "./client/settings";
import { contributeGoalPills } from "./client/goal-pill";
import { contributeGoalCommands } from "./client/goal-commands";
import { GoalEditorScreen } from "./client/goal-editor";
import { excludeRpc, watchGoalRpc, unwatchGoalRpc } from "./shared/contracts";

function RecoveryItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="RotateCcw"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const stopGoalPills = contributeGoalPills(client);
  const stopGoalCommands = contributeGoalCommands(client);
  function Screen(props: PluginScreenProps) { return <RecoveryScreen {...props} onOpenSettings={() => client.openSettings("preferences")} />; }
  client.addScreen({ id: "main", title: "session-recovery", Component: Screen });
  client.addScreen({ id: "goal", title: "Current goal", Component: GoalEditorScreen });
  if (Platform.OS === "web") client.addSidebarHeaderItem({ id: "main", title: "session-recovery", Component: RecoveryItem });
  client.addSettingsScreen({ id: "preferences", title: "Settings", icon: "Settings2", Component: RecoverySettings });
  client.addCommandCenterItem({ id: "open", title: "Open session-recovery", icon: "RotateCcw", context: "global", onSelect({ openScreen }) { openScreen({ screenId: "main" }); } });
  client.addCommandCenterItem({ id: "settings", title: "session-recovery settings", icon: "Settings2", context: "global", onSelect({ openSettings }) { openSettings("preferences"); } });
  client.addCommandCenterItem({ id: "exclude", title: "Exclude this session from recovery", icon: "CirclePause", context: "agent", async onSelect({ agent, rpc }) { await rpc(excludeRpc, { id: agent.id, excluded: true }); } });
  client.addCommandCenterItem({ id: "include", title: "Allow future recovery for this session", icon: "RotateCcw", context: "agent", async onSelect({ agent, rpc }) { await rpc(excludeRpc, { id: agent.id, excluded: false }); } });
  client.addCommandCenterItem({ id: "watch-goal", title: "Continue this session's goal", icon: "Target", context: "agent", async onSelect({ agent, rpc, openScreen }) { await rpc(watchGoalRpc, { id: agent.id, resetAttempts: false, resumeBlocked: true }); openScreen({ screenId: "main", params: { agentId: agent.id, view: "goals" } }); } });
  client.addCommandCenterItem({ id: "unwatch-goal", title: "Stop continuing this session's goal", icon: "CirclePause", context: "agent", async onSelect({ agent, rpc }) { await rpc(unwatchGoalRpc, { id: agent.id }); } });
  return () => { stopGoalPills(); stopGoalCommands(); };
}
