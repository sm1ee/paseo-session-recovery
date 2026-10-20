import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { dismissRpc, excludeRpc, prepareRpc, reasonText, resumeRpc, scanRpc, statusRpc, watchGoalRpc, type Phase, type RecoveryRow, type ResumePreview } from "../shared/contracts";

const views = [["queue", "Recovery queue"], ["watching", "Watching"], ["goals", "Goals"], ["history", "History"], ["excluded", "Excluded"]] as const;
const labels: Record<Phase, string> = { watching: "Watching", waiting: "Needs input", interrupted: "Interrupted", scheduled: "Scheduled", review: "Review needed", sending: "Sending…", resumed: "Continuation sent", completed: "Completed", stopped: "Stopped", dismissed: "Dismissed" };
const states = { starting: "Connecting…", running: "Automatic recovery is on", paused: "Automatic recovery is off", error: "Recovery is paused" };
function date(value: number | null): string { return value ? new Date(value).toLocaleString() : ""; }
export function RecoveryScreen({ theme, layout, params, navigation, host, onOpenSettings }: PluginScreenProps & { onOpenSettings: () => void }) {
  const [query, setQuery] = useState(params.agentId ?? "");
  const [view, setView] = useState<typeof views[number][0]>("queue");
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<ResumePreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = useRpc(statusRpc), scan = useRpc(scanRpc), exclude = useRpc(excludeRpc), dismiss = useRpc(dismissRpc), prepare = useRpc(prepareRpc), resume = useRpc(resumeRpc), watch = useRpc(watchGoalRpc);
  const cache = useQueryClient();
  const result = useQuery({ queryKey: ["recovery", query, view, page], queryFn: () => status({ query, view, page }), refetchInterval: 5000 });
  const mutation = useMutation({
    mutationFn: async (action: { kind: "scan" | "resume" } | { kind: "exclude" | "dismiss" | "prepare" | "watch"; row: RecoveryRow }) => {
      setNotice(null);
      if (action.kind === "scan") await scan({});
      if (action.kind === "exclude") await exclude({ id: action.row.id, excluded: !action.row.excluded });
      if (action.kind === "dismiss") await dismiss({ id: action.row.id });
      if (action.kind === "watch") { await watch({ id: action.row.id }); setView("goals"); setPage(0); }
      if (action.kind === "prepare") setPreview(await prepare({ id: action.row.id }));
      if (action.kind === "resume" && preview) { await resume({ token: preview.token }); setPreview(null); setNotice("Recovery checked. The latest result is shown below."); }
    },
    onSettled: () => { void cache.invalidateQueries({ queryKey: ["recovery"] }); },
    onError: (e) => { setPreview(null); setNotice(e instanceof Error ? e.message : "The request failed. Refresh and try again."); },
  });
  const c = theme.colors, data = result.data;
  const text = { color: c.foreground }, muted = { color: c.foregroundMuted, fontSize: 12 };
  const button = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled || mutation.isPending}
    style={{ paddingVertical: 9, paddingHorizontal: 12, backgroundColor: c.surface2, borderRadius: 6, opacity: disabled || mutation.isPending ? 0.5 : 1 }}><Text style={{ ...text, fontSize: 12 }}>{label}</Text></Pressable>;
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 20, maxWidth: 1040, width: "100%", alignSelf: "center" }}>
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <Text style={{ ...text, fontSize: 24, fontWeight: "600" }}>session-recovery</Text>
        {button("Settings", onOpenSettings)}
      </View>
      <Text style={muted}>Recover interrupted work and continue goals that remain active after a turn ends.</Text>
      <Text style={{ ...text, fontWeight: "600" }}>{data ? states[data.state] : "Connecting…"}</Text>
      {(data?.error || result.isError) && <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{data?.error ?? "Could not read recovery status. Check this host's connection and refresh."}</Text>}
      {data && <Text style={muted}>{data.counts.watching} watching · {data.counts.scheduled} scheduled · {data.counts.review} need review · {data.counts.resumed} recent continuations</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "center" }}>{button(data?.scanning ? "Checking…" : "Check sessions", () => mutation.mutate({ kind: "scan" }), data?.scanning)}<Text style={muted}>{data?.lastScanAt ? `Checked ${date(data.lastScanAt)}` : ""}</Text></View>
      <Text style={muted}>Observed turns and explicitly watched goals are tracked. Goal continuation must be enabled in settings. Direct stops and completed goals are left alone.</Text>
    </View>
    {notice && <Text accessibilityRole="alert" style={text}>{notice}</Text>}
    {preview && <View style={{ gap: 12, padding: 16, borderWidth: 1, borderColor: c.accent, borderRadius: 8, backgroundColor: c.surface1 }}>
      <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Resume {preview.title}?</Text>
      <Text style={muted}>This sends a new message to the existing conversation. Check that earlier commands or external actions did not already finish.</Text>
      <Text style={text}>{preview.prompt}</Text>
      <Text style={muted}>Preview expires at {date(preview.expiresAt)}.</Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>{button("Resume session", () => mutation.mutate({ kind: "resume" }))}{button("Cancel", () => setPreview(null))}</View>
    </View>}
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{views.map(([value, label]) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: view === value }} onPress={() => { setView(value); setPage(0); }}
        style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, backgroundColor: view === value ? c.accent : c.surface1 }}><Text style={{ color: view === value ? c.accentForeground : c.foreground, fontSize: 12 }}>{label}</Text></Pressable>)}</View>
      <TextInput value={query} onChangeText={(value) => { setQuery(value); setPage(0); }} placeholder="Find a session by name, provider, or ID" placeholderTextColor={c.foregroundMuted} accessibilityLabel="Find a session" style={{ ...text, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 6, padding: 12 }} />
      {!data?.rows.length && <Text style={muted}>{result.isPending ? "Loading sessions…" : view === "queue" ? "No sessions need recovery." : "No sessions in this view."}</Text>}
      {data?.rows.map((row) => <View key={row.id} style={{ gap: 8, padding: 16, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8 }}>
        <Text numberOfLines={2} style={{ ...text, fontWeight: "600" }}>{row.title}</Text>
        <Text style={muted}>{row.parentId ? "Subagent" : "Main session"}{row.provider ? ` · ${row.provider}` : ""} · {labels[row.phase]} · {row.id.slice(0, 8)}</Text>
        <Text style={text}>{reasonText[row.reason]}</Text>
        {row.dueAt && <Text style={muted}>Resume after {date(row.dueAt)}</Text>}
        <Text style={muted}>{row.attempts} recovery attempts{row.lastSeenAt ? ` · Last seen ${date(row.lastSeenAt)}` : ""}</Text>
        {row.goalState && <Text style={text}>Goal: {row.goalState} · {row.goalAttempts} continuations</Text>}
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {navigation && button("Open session", () => navigation.openAgent({ agentId: row.id, serverId: host.id }))}
          {row.canResume && button("Resume…", () => mutation.mutate({ kind: "prepare", row }))}
          {!row.excluded && !["watching", "waiting", "sending", "resumed"].includes(row.phase) && button(row.goalState ? "Watch goal again" : "Watch goal", () => mutation.mutate({ kind: "watch", row }))}
          {button(row.excluded ? "Allow future recovery" : "Exclude recovery", () => mutation.mutate({ kind: "exclude", row }))}
          {["scheduled", "review", "interrupted"].includes(row.phase) && button("Dismiss", () => mutation.mutate({ kind: "dismiss", row }))}
        </View>
      </View>)}
      {data && data.total > 30 && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>{button("Previous", () => setPage(data.page - 1), data.page === 0)}<Text style={muted}>{data.page + 1} / {Math.ceil(data.total / 30)}</Text>{button("Next", () => setPage(data.page + 1), (data.page + 1) * 30 >= data.total)}</View>}
    </View>
    {!!data?.history.length && <View style={{ gap: 8 }}><Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Recent activity</Text>{data.history.map((entry, i) => <Text key={`${entry.at}-${entry.id}-${i}`} style={muted}>{date(entry.at)} · {entry.id.slice(0, 8)} · {entry.action} · {reasonText[entry.reason]}</Text>)}</View>}
  </ScrollView>;
}
