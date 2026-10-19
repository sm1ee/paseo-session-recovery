import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { preferences, type Preferences } from "../shared/contracts";

function Draft({ values, save, busy, theme }: { values: Preferences; save: (v: Preferences) => void; busy: boolean; theme: PluginSurfaceProps["theme"] }) {
  const [delay, setDelay] = useState(String(values.delaySeconds));
  const [attempts, setAttempts] = useState(String(values.maxAttempts));
  const [window, setWindow] = useState(String(values.maxOfflineHours));
  const [home, setHome] = useState(values.daemonHome);
  const [prompt, setPrompt] = useState(values.prompt);
  const parsed = preferences.schema.safeParse({ ...values, delaySeconds: Number(delay), maxAttempts: Number(attempts), maxOfflineHours: Number(window), daemonHome: home.trim(), prompt });
  return <>
    <SettingsSection title="Timing">
      <SettingsCard>
        <SettingsInput label="Recovery delay (seconds)" hint="30 to 900. The delay doubles after each attempt, up to 15 minutes." initialValue={delay} onChangeText={setDelay} disabled={busy} />
        <SettingsInput label="Maximum automatic attempts" hint="1 to 10 per interruption. The count survives daemon restarts." initialValue={attempts} onChangeText={setAttempts} disabled={busy} />
        <SettingsInput label="Recovery window (hours)" hint="0.25 to 168. Older interruptions require review." initialValue={window} onChangeText={setWindow} disabled={busy} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Continuation message">
      <Text style={{ color: theme.colors.foregroundMuted }}>Sent to the existing session when recovery starts. This uses the session's current provider, model, and permissions.</Text>
      <TextInput value={prompt} onChangeText={setPrompt} multiline editable={!busy} accessibilityLabel="Continuation message" textAlignVertical="top"
        style={{ color: theme.colors.foreground, backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 140 }} />
    </SettingsSection>
    <SettingsSection title="Paseo home">
      <SettingsCard>
        <SettingsInput label="Home directory" hint="Leave empty for automatic detection. Must belong to the daemon running this plugin." initialValue={home} onChangeText={setHome} disabled={busy} />
        <SettingsAction label={parsed.success ? "Save timing and continuation message" : "Enter valid timing values and a message of 20 to 4000 characters"} actionLabel="Save" disabled={busy || !parsed.success} onPress={() => { if (parsed.success) save(parsed.data); }} />
      </SettingsCard>
    </SettingsSection>
  </>;
}
export function RecoverySettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  if (settings.status !== "ready") return <SettingsSection title="session-recovery">
    <Text style={{ color: theme.colors.foreground }}>{settings.status === "loading" ? "Loading settings…" : "Settings could not be read. Automatic recovery is paused."}</Text>
    {settings.status !== "loading" && <SettingsCard><SettingsAction label="Reload settings" actionLabel="Reload" onPress={() => { void settings.reload(); }} /><SettingsAction label="Restore defaults" actionLabel="Restore" onPress={() => { void settings.reset(); }} /></SettingsCard>}
  </SettingsSection>;
  const values = settings.values;
  const save = (v: Preferences) => { void settings.save(v, settings.revision); };
  return <View style={{ gap: 24 }}>
    <SettingsSection title="session-recovery">
      <Text style={{ color: theme.colors.foregroundMuted }}>Tracks turns observed after installation. It does not wake old idle sessions. Automatic recovery is on by default for eligible main sessions.</Text>
      <SettingsCard>
        <SettingsSwitch label="Automatic recovery" hint="Continue interrupted work after this daemon restarts. Turning this off keeps monitoring and manual review available." value={values.enabled} disabled={settings.saving} onValueChange={(enabled) => save({ ...values, enabled })} />
        <SettingsSwitch label="Automatically recover subagents" hint="Off by default. Every parent must be idle, available, and free of pending approvals. Provider-internal subagents are not managed here." value={values.recoverSubagents} disabled={settings.saving} onValueChange={(recoverSubagents) => save({ ...values, recoverSubagents })} />
        <SettingsSwitch label="Retry temporary provider errors" hint="Off by default. Only recognized connection and service error codes qualify; other errors require review." value={values.retryTransientErrors} disabled={settings.saving} onValueChange={(retryTransientErrors) => save({ ...values, retryTransientErrors })} />
      </SettingsCard>
      {settings.saveError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>Could not save settings. Reload and try again.</Text>}
    </SettingsSection>
    <Draft key={settings.revision} values={values} save={save} busy={settings.saving} theme={theme} />
    <SettingsSection title="When recovery pauses">
      <Text style={{ color: theme.colors.foregroundMuted }}>Stopped and completed turns are excluded. Questions, approvals, uncertain delivery, unavailable history, and unknown interruptions require your attention. Review the conversation before continuing.</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>Pending recovery protects sessions from the paired session-janitor plugin. Dismiss or exclude a candidate to release that protection. Other cleanup tools do not read these protections.</Text>
    </SettingsSection>
  </View>;
}
