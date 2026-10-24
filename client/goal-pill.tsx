import type { PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { goalControlRpc, type GoalControl } from "../shared/contracts";
import { readGoalRpc } from "../shared/goal-editor";
import { actOnGoalRpc } from "../shared/goal-actions";
import { createGoalPillController, type GoalPillController, type PillAgent } from "./goal-pill-controller";
import { GoalPillIcon } from "./goal-pill-icon";
import { GoalEditorContent } from "./goal-editor";
import { goalErrorText, goalPreviewLabel } from "./goal-presentation";

export function contributeGoalPills(client: PluginClientContext): () => void {
  const lifetime = new AbortController();
  const controller: GoalPillController = createGoalPillController(
    (id, fresh) => client.rpc(goalControlRpc, { id, fresh, preview: true }),
    (id, workspaceId) => {
      let current: GoalControl | null = null;
      let observed: PillAgent | undefined;
      let lastLabel = "Goal";
      let lastPlayback = "";
      let playback: PluginButtonRegistration | undefined;
      const observe = () => controller.mount(id);
      const Icon = (props: PluginButtonIconProps) => <GoalPillIcon {...props} observe={observe} />;
      const Content = (props: PluginButtonContentProps) => <GoalEditorContent {...props} agentId={id} showPlayback={false}
        onChanged={() => { void controller.refresh(id).catch(() => {}); }} />;
      const PlaybackContent = (props: PluginButtonContentProps) => <GoalEditorContent {...props} agentId={id} showPlayback
        onChanged={() => { void controller.refresh(id).catch(() => {}); }} />;
      const act = async () => {
        try {
        const expected = current;
        if (!expected?.key || !expected.nativeAction) throw new Error("Reload the current goal before changing it.");
        if (observed?.status === "closed" && expected.state === "active" && expected.nativeAction === "pause") {
          await controller.refresh(id).catch(() => {}); throw new Error("The session changed. Reload its controls.");
        }
        if (observed?.activeTurn && expected.nativeReconnect) {
          await controller.refresh(id).catch(() => {}); throw new Error("The session changed. Reload its controls.");
        }
        const latest = await client.rpc(readGoalRpc, { id });
        if (latest.key !== expected.key || latest.action !== expected.nativeAction || !!latest.nativeStart !== !!expected.nativeStart || !!latest.reconnect !== !!expected.nativeReconnect) {
          await controller.refresh(id).catch(() => {});
          throw new Error("The goal changed. Review it before trying again.");
        }
        if (!latest.actionTicket) throw new Error(latest.note || latest.actionNote || "Native controls are unavailable. Open the goal to review its state.");
        // OpenCode resume needs the sheet's explicit new-budget action.
        if (latest.source === "opencode" && latest.action === "resume" && !latest.reconnect) throw new Error("Open this goal and review the new budget window before resuming.");
        try { await client.rpc(actOnGoalRpc, { ticket: latest.actionTicket, confirmBudgetReset: false }); }
        finally { await controller.refresh(id).catch(() => {}); }
        } catch (error) { throw new Error(goalErrorText(error)); }
      };
      const pill = client.addComposerPill({ id: "goal-continuation", agentId: id, workspaceId,
        button: { title: "Goal", icon: Icon, label: "Goal", behavior: { kind: "popover", Content } } });
      const updateLabel = () => {
        const label = goalPreviewLabel(current, observed);
        if (label === lastLabel) return;
        lastLabel = label; pill.update({ label, title: "Goal" });
      };
      const updatePlayback = () => {
        const value = current;
        const action = value?.nativeAction;
        if (!action) { if (lastPlayback) playback?.update({ visible: false }); lastPlayback = ""; return; }
        const stalePause = observed?.status === "closed" && value.state === "active" && action === "pause";
        const staleReconnect = !!observed?.activeTurn && value.nativeReconnect === true;
        const shown = stalePause ? "resume" : staleReconnect ? "pause" : action;
        const disabled = value.nativeActionReady === false || stalePause || staleReconnect;
        const actionTitle = value.nativeStart ? "Start goal" : shown === "pause" ? "Pause goal" : "Resume goal";
        const blockedNote = stalePause || staleReconnect ? "Session changed. Checking goal controls."
          : value.nativeActionNote || "Controls unavailable. Open Goal to check.";
        const title = disabled ? `${actionTitle}: ${blockedNote}` : actionTitle;
        const signature = JSON.stringify([shown, disabled, value.source, value.nativeStart, value.nativeReconnect, title]);
        if (signature === lastPlayback) return;
        lastPlayback = signature;
        const button = { title,
          icon: shown === "pause" ? "Pause" : "Play", label: value.nativeStart ? "Start goal" : shown === "pause" ? "Pause" : "Resume", visible: true, disabled,
          behavior: action === "resume" && value.source === "opencode" && !value.nativeReconnect ? { kind: "popover" as const, Content: PlaybackContent } : { kind: "action" as const, onPress: act } };
        if (playback) playback.update(button);
        else playback = client.addComposerPill({ id: "goal-playback", agentId: id, workspaceId, button });
      };
      return { remove: () => { pill.remove(); playback?.remove(); }, observe: (agent) => { observed = agent; updateLabel(); updatePlayback(); }, update: (value) => {
        current = value;
        updateLabel(); updatePlayback();
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
