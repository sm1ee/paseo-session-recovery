import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { goalControlRpc, unwatchGoalRpc, watchGoalRpc, type GoalControl } from "../shared/contracts";
import { GoalPillController } from "./goal-pill-controller";

function GoalPopover({ theme, layout, targetId, load, settings }: PluginButtonContentProps & {
  targetId: string; load: () => Promise<GoalControl>; settings: () => void;
}) {
  const cache = useQueryClient(), watch = useRpc(watchGoalRpc), unwatch = useRpc(unwatchGoalRpc);
  const queryKey = ["goal-control", targetId];
  const result = useQuery({ queryKey, queryFn: load, refetchInterval: 5000 });
  const toggle = useMutation({
    mutationFn: async (selected: boolean) => {
      if (selected) {
        if (!result.data?.canSelect || !result.data.key) throw new Error("The current goal could not be verified. Refresh and try again.");
        await watch({ id: targetId, key: result.data.key, resetAttempts: false });
      } else await unwatch({ id: targetId });
      return load();
    },
    onSuccess: (data) => { cache.setQueryData(queryKey, data); void cache.invalidateQueries({ queryKey: ["recovery"] }); },
    onError: () => { void cache.invalidateQueries({ queryKey }); },
  });
  const c = theme.colors, data = result.data;
  return <View style={{ width: layout.compact ? "100%" : 320, maxWidth: "100%", gap: 12 }}>
    <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>Goal continuation</Text>
    {data?.visible && <>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Goal: {data.state} · {data.attempts} / {data.maxAttempts} continuations</Text>
      <SettingsCard><SettingsSwitch label="Continue this goal" hint="Selects this objective. It continues only while the goal is active."
        value={data.selected} disabled={toggle.isPending || !data.selected && !data.canSelect}
        onValueChange={(value) => toggle.mutate(value)} /></SettingsCard>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{data.delaySeconds}s delay after a completed turn.</Text>
      {data.note && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{data.note}</Text>}
    </>}
    {!data && result.isPending && <Text style={{ color: c.foregroundMuted }}>Checking this goal…</Text>}
    {data && !data.visible && <Text style={{ color: c.foregroundMuted }}>No current goal was found.</Text>}
    {(result.isError || toggle.isError) && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{toggle.error?.message ?? "Could not read the current goal. Try again."}</Text>}
    <Pressable accessibilityRole="button" onPress={settings} style={{ paddingVertical: 8 }}><Text style={{ color: c.foreground }}>Settings</Text></Pressable>
  </View>;
}

export function contributeGoalPills(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  const controller: GoalPillController = new GoalPillController(
    (id, fresh) => client.rpc(goalControlRpc, { id, fresh }),
    (id, workspaceId) => {
      function Content(props: PluginButtonContentProps) {
        return <GoalPopover {...props} targetId={id} load={() => controller.refresh(id)} settings={() => { props.close(); client.openSettings("preferences"); }} />;
      }
      const pill = client.addComposerPill({ id: "goal-continuation", agentId: id, workspaceId,
        button: { title: "Goal continuation", icon: "Target", label: "Goal", behavior: { kind: "popover", Content } } });
      return { remove: () => pill.remove(), update: (value) => pill.update({ label: `Goal · ${value.selected ? "On" : "Off"}`, title: `Goal continuation: ${value.selected ? "on" : "off"}` }) };
    },
  );
  const timer = setInterval(() => { void controller.poll(); }, 5000);
  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
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
