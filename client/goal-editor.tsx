import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { goalLengthLimit, editGoalRpc, goalObjectiveError, readGoalRpc, type GoalEditorSnapshot } from "../shared/goal-editor";
import { goalControlRpc, watchGoalRpc, unwatchGoalRpc } from "../shared/contracts";

export function GoalEditorScreen(props: PluginScreenProps) {
  // Host or target changes discard the old draft and its one-use edit ticket.
  return <GoalEditor key={`${props.host.id}:${props.params.agentId ?? ""}`} {...props} />;
}
function GoalEditor({ theme, layout, params, navigation, host }: PluginScreenProps) {
  const id = params.agentId ?? "", read = useRpc(readGoalRpc), edit = useRpc(editGoalRpc);
  const readControl = useRpc(goalControlRpc), watch = useRpc(watchGoalRpc), unwatch = useRpc(unwatchGoalRpc);
  const cache = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null), [needsReload, setNeedsReload] = useState(false);
  const [draft, setDraft] = useState<{ ticket: string | null; text: string } | null>(null);
  const result = useQuery({ queryKey: ["goal-editor", host.id, id], enabled: !!id,
    queryFn: () => read({ id }), staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const goal = result.data;
  // Only opening this screen requests history inspection for OMP/Pi or Claude.
  // The generic composer entry does not opt a goal into continuation.
  const inspection = useQuery({ queryKey: ["goal-control", host.id, id], enabled: !!id,
    queryFn: () => readControl({ id, fresh: true, inspect: true }), staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const control = inspection.data;
  const continuation = useMutation({ retry: false, mutationFn: async () => {
    const latest = await readControl({ id, fresh: true, inspect: true });
    if (latest.selected) await unwatch({ id });
    else {
      if (!latest.visible || !latest.canSelect || !latest.key) throw new Error(latest.note || "A current goal could not be verified. Set a goal in the conversation and reload.");
      await watch({ id, key: latest.key, resetAttempts: false, resumeBlocked: true });
    }
  }, onSuccess: () => { void inspection.refetch(); void cache.invalidateQueries({ queryKey: ["recovery"] }); },
  onError: (error) => { setNotice(error instanceof Error ? error.message : "The continuation change could not be confirmed. Reload before trying again."); void inspection.refetch(); } });
  const text = draft?.ticket === goal?.ticket ? draft?.text ?? goal?.objective ?? "" : goal?.objective ?? "";
  const dirty = !!goal?.objective && text.trim() !== goal.objective.trim();
  const maxLength = goalLengthLimit(goal?.source ?? null), validation = goalObjectiveError(text, goal?.source ?? null);
  const save = useMutation({
    retry: false,
    mutationFn: async (value: GoalEditorSnapshot) => {
      if (!value.ticket) throw new Error("Reload the current goal before saving.");
      setNotice(null);
      await edit({ ticket: value.ticket, objective: text });
    },
    onSuccess: () => { setDraft(null); setNeedsReload(false); setNotice(goal?.source === "claude" ? "Goal replaced. Claude starts work with a fresh goal timer and counters." : "Goal saved and active. Select goal continuation again if you want Paseo to continue the new objective."); void cache.invalidateQueries({ queryKey: ["recovery"] }); void result.refetch(); },
    onError: (error) => { setNeedsReload(true); setNotice(error instanceof Error ? error.message : "The goal edit could not be confirmed. Check the conversation and reload before trying again."); },
  });
  const [confirmReload, setConfirmReload] = useState(false);
  const reload = () => { setDraft(null); setNotice(null); setNeedsReload(false); setConfirmReload(false); void result.refetch(); void inspection.refetch(); };
  const c = theme.colors, normal = { color: c.foreground }, muted = { color: c.foregroundMuted, fontSize: 13 };
  const button = (label: string, onPress: () => void, disabled = false, primary = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    disabled={disabled || save.isPending || continuation.isPending || result.isFetching} onPress={onPress}
    style={{ padding: 12, borderRadius: 6, backgroundColor: primary ? c.accent : c.surface2, opacity: disabled || save.isPending || continuation.isPending || result.isFetching ? 0.5 : 1 }}>
    <Text style={{ color: primary ? c.accentForeground : c.foreground, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
  return <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16, maxWidth: 900, width: "100%", alignSelf: "center" }}>
    <Text style={{ ...normal, fontSize: 24, fontWeight: "600" }}>Current goal</Text>
    {goal && <View style={{ gap: 6 }}><Text style={{ ...normal, fontWeight: "600" }}>{goal.title}</Text><Text style={muted}>{goal.provider} · {goal.supported ? goal.state : control?.state ?? goal.state}</Text></View>}
    {(!id || result.isError) && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{!id ? "Open this editor from a session with /goal or the Command Center." : result.error instanceof Error ? result.error.message : "Could not read the current goal."}</Text>}
    {!!id && result.isPending && <Text style={muted}>Reading the current goal…</Text>}
    {goal?.objective != null && <View style={{ gap: 8 }}>
      <Text style={normal}>Objective</Text>
      <TextInput multiline value={text} onChangeText={(value) => setDraft({ ticket: goal.ticket, text: value })} maxLength={maxLength}
        editable={!!goal.ticket && !needsReload && !result.isError && !save.isPending && !result.isFetching} accessibilityLabel="Goal objective" placeholderTextColor={c.foregroundMuted}
        style={{ ...normal, minHeight: layout.compact ? 180 : 240, padding: 12, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 8, textAlignVertical: "top" }} />
      {goal.ticket && <Text style={muted}>{text.length.toLocaleString()} / {maxLength.toLocaleString()}</Text>}
      {dirty && validation && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{validation}</Text>}
    </View>}
    {goal?.supported && <Text style={muted}>{goal.source === "claude" ? "Goal tokens at last native evaluation" : "Tokens used"}: {goal.tokensUsed?.toLocaleString() ?? "unavailable"} · Budget: {goal.tokenBudget?.toLocaleString() ?? "none reported"}. {goal.source === "claude" ? "Claude does not expose a separate goal token budget." : "This editor does not change token budgets."}</Text>}
    {goal?.note && <Text style={muted}>{goal.note}</Text>}
    {inspection.isError && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>Could not verify goal continuation. Reload to try again.</Text>}
    {control?.note && <Text style={muted}>{control.note}</Text>}
    {notice && <Text accessibilityRole="alert" style={normal}>{notice}</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {(control?.visible || control?.selected) && button(`Continue goal · ${control.selected ? "On" : "Off"}`, () => continuation.mutate(), inspection.isFetching || inspection.isError || !control.selected && (!control.canSelect || !control.key))}
      {goal?.ticket && button(save.isPending ? "Saving…" : goal.source === "claude" ? "Replace goal and start" : goal.state === "active" ? "Save goal" : "Save and activate", () => save.mutate(goal), !dirty || !!validation || needsReload || result.isError, true)}
      {!!id && button("Reload current goal", () => dirty ? setConfirmReload(true) : reload())}
      {navigation && !!id && button("Open session", () => navigation.openAgent({ agentId: id, serverId: host.id }))}
    </View>
    {confirmReload && <View style={{ gap: 10, padding: 12, backgroundColor: c.surface1, borderRadius: 8 }}>
      <Text style={normal}>Discard your unsaved changes and reload the current goal?</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{button("Discard and reload", reload)}{button("Keep editing", () => setConfirmReload(false))}</View>
    </View>}
  </ScrollView>;
}
