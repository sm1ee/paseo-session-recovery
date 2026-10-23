import type { PluginHostProps, PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { goalLengthLimit, editGoalRpc, goalObjectiveError, readGoalRpc, type GoalEditorSnapshot } from "../shared/goal-editor";
import { goalControlRpc, watchGoalRpc, unwatchGoalRpc } from "../shared/contracts";
import { actOnGoalRpc } from "../shared/goal-actions";
import { goalErrorText, goalReadOnlyText } from "./goal-presentation";

export function GoalEditorScreen(props: PluginScreenProps) {
  return <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}
    contentContainerStyle={{ padding: props.layout.compact ? 16 : 24, maxWidth: 900, width: "100%", alignSelf: "center" }}>
    <GoalEditorContent {...props} agentId={props.params.agentId ?? ""}
      openSession={props.navigation ? () => props.navigation!.openAgent({ agentId: props.params.agentId, serverId: props.host.id }) : undefined} />
  </ScrollView>;
}
interface GoalContentProps extends PluginHostProps { agentId: string; showPlayback?: boolean; onChanged?: () => void; openSession?: () => void }
export function GoalEditorContent(props: GoalContentProps) {
  // Host or target changes discard the old draft and its one-use tickets.
  return <GoalEditor key={`${props.host.id}:${props.agentId}`} {...props} />;
}
function GoalEditor({ theme, layout, agentId: id, host, showPlayback = true, onChanged, openSession }: GoalContentProps) {
  const read = useRpc(readGoalRpc), edit = useRpc(editGoalRpc), act = useRpc(actOnGoalRpc);
  const readControl = useRpc(goalControlRpc), watch = useRpc(watchGoalRpc), unwatch = useRpc(unwatchGoalRpc);
  const cache = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null), [needsReload, setNeedsReload] = useState(false);
  const [draft, setDraft] = useState<{ ticket: string | null; text: string } | null>(null), [more, setMore] = useState(false);
  const result = useQuery({ queryKey: ["goal-editor", host.id, id], enabled: !!id,
    queryFn: () => read({ id }), staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const goal = result.data;
  // 추가 이어가기를 펼칠 때만 기록을 검사한다. 기본 편집은 목표만 읽는다.
  const inspection = useQuery({ queryKey: ["goal-control", host.id, id], enabled: !!id && more,
    queryFn: () => readControl({ id, fresh: true, inspect: true }), staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const control = inspection.data;
  const refresh = () => { void result.refetch(); if (more) void inspection.refetch(); onChanged?.(); void cache.invalidateQueries({ queryKey: ["recovery"] }); };
  const playback = useMutation({ retry: false, mutationFn: async (value: GoalEditorSnapshot) => {
    if (!value.action || !value.actionTicket) throw new Error("Reload the current goal before changing it.");
    setNotice(null);
    await act({ ticket: value.actionTicket, confirmBudgetReset: value.source === "opencode" && value.action === "resume" });
  }, onSuccess: () => { setDraft(null); setNeedsReload(false); setNotice(goal?.nativeStart ? "Goal started." : goal?.action === "pause" ? "Paused." : "Resumed."); refresh(); },
  onError: (error) => { setNeedsReload(true); setNotice(goalErrorText(error)); onChanged?.(); } });
  const continuation = useMutation({ retry: false, mutationFn: async () => {
    const latest = await readControl({ id, fresh: true, inspect: true });
    if (latest.selected) await unwatch({ id });
    else {
      if (!latest.visible || !latest.canSelect || !latest.key) throw new Error(latest.note || "A current goal could not be verified. Set a goal in the conversation and reload.");
      await watch({ id, key: latest.key, resetAttempts: false, resumeBlocked: true });
    }
  }, onSuccess: () => { void inspection.refetch(); onChanged?.(); void cache.invalidateQueries({ queryKey: ["recovery"] }); },
  onError: (error) => { setNotice(goalErrorText(error)); void inspection.refetch(); } });
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
    onSuccess: () => { setDraft(null); setNeedsReload(false); setNotice("Saved."); refresh(); },
    onError: (error) => { setNeedsReload(true); setNotice(goalErrorText(error)); },
  });
  const [confirmReload, setConfirmReload] = useState(false);
  const reload = () => { setDraft(null); setNotice(null); setNeedsReload(false); setConfirmReload(false); void result.refetch(); if (more) void inspection.refetch(); };
  const c = theme.colors, normal = { color: c.foreground }, muted = { color: c.foregroundMuted, fontSize: 13 };
  const pending = save.isPending || playback.isPending || continuation.isPending || result.isFetching;
  const button = (label: string, onPress: () => void, disabled = false, primary = false) => <Pressable accessibilityRole="button" accessibilityLabel={label}
    disabled={disabled || pending} onPress={onPress}
    style={{ padding: 12, borderRadius: 8, backgroundColor: primary ? c.accent : c.surface2, opacity: disabled || pending ? 0.5 : 1 }}>
    <Text style={{ color: primary ? c.accentForeground : c.foreground, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
  const showReload = !!id && (needsReload || result.isError || goal?.state === "unknown" || goal?.objective != null && !goal.ticket);
  const actions = (showPlayback && goal?.action && !dirty || goal?.ticket && dirty || showReload || dirty) && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
    {showPlayback && goal?.action && !dirty && button(playback.isPending ? "Updating…" : goal.nativeStart ? "Start goal" : goal.action === "pause" ? "Pause" : "Resume", () => playback.mutate(goal), !goal.actionTicket || needsReload || result.isError)}
    {goal?.ticket && dirty && button(save.isPending ? "Saving…" : goal.source === "claude" ? "Replace & start" : "Save", () => save.mutate(goal), !!validation || needsReload || result.isError, true)}
    {showReload && button("Reload", () => dirty ? setConfirmReload(true) : reload())}
    {dirty && button("Discard", () => setDraft(null))}
  </View>;
  return <View style={{ gap: 12, width: "100%", maxWidth: 680 }}>
    {(!id || result.isError) && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{!id ? "Open from a chat." : goalErrorText(result.error)}</Text>}
    {!!id && result.isPending && <Text style={muted}>Loading…</Text>}
    {goal && goal.objective == null && <Text style={muted}>{goal.state === "unknown" ? "Goal unavailable. Reload." : "No goal"}</Text>}
    {goal?.objective != null && <View style={{ gap: 8 }}>
      <TextInput multiline value={text} onChangeText={(value) => setDraft({ ticket: goal.ticket, text: value })} maxLength={maxLength}
        editable={!!goal.ticket && !needsReload && !result.isError && !pending} accessibilityLabel="Goal objective" placeholderTextColor={c.foregroundMuted}
        style={{ ...normal, minHeight: layout.compact ? 120 : 160, maxHeight: 280, padding: 12, backgroundColor: c.surface1, borderWidth: 1, borderColor: dirty ? c.accent : c.border, borderRadius: 10, textAlignVertical: "top" }} />
      {!goal.ticket && !goal.sessionControls && <Text style={muted}>{goalReadOnlyText(goal)}</Text>}
      {dirty && <Text style={muted}>{text.length.toLocaleString()} / {maxLength.toLocaleString()}</Text>}
      {dirty && validation && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{validation}</Text>}
    </View>}
    {showPlayback && goal?.source === "opencode" && goal.action === "resume" && <Text style={muted}>Resume resets goal budgets.</Text>}
    {goal?.source === "claude" && dirty && <Text style={muted}>Restarts the goal timer and usage.</Text>}
    {showPlayback && goal?.sessionControls && goal.action && <Text style={muted}>Pause stops this turn. Resume continues the same goal.</Text>}
    {notice && <Text accessibilityRole="alert" style={normal}>{notice}</Text>}
    {actions}
    {confirmReload && <View style={{ gap: 10, padding: 12, backgroundColor: c.surface1, borderRadius: 8 }}>
      <Text style={normal}>Discard changes?</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{button("Discard & reload", reload)}{button("Cancel", () => setConfirmReload(false))}</View>
    </View>}
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 }}>
      {button(more ? "Less" : "Details", () => setMore(!more))}
      {more && <>
        {goal && <Text style={muted}>{goal.provider} · {goal.state} · Tokens: {goal.tokensUsed?.toLocaleString() ?? "unavailable"} · Budget: {goal.tokenBudget?.toLocaleString() ?? "none reported"}</Text>}
        {goal?.note && <Text style={muted}>{goal.note}</Text>}
        {goal?.actionNote && <Text style={muted}>{goal.actionNote}</Text>}
        {!!id && button("Reload", () => dirty ? setConfirmReload(true) : reload())}
        {openSession && !!id && button("Open chat", openSession)}
        {control?.note && <Text style={muted}>{control.note}</Text>}
        {inspection.isError && <Text style={muted}>Continuation unavailable. Reload.</Text>}
        {(control?.visible || control?.selected) && <>
          <Text style={muted}>Extra Paseo follow-ups after a turn ends.</Text>
          {button(`Extra continuation · ${control.selected ? "On" : "Off"}`, () => continuation.mutate(), inspection.isFetching || inspection.isError || !control.selected && (!control.canSelect || !control.key))}
        </>}
      </>}
    </View>
  </View>;
}
