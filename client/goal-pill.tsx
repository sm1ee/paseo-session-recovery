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
        const latest = await client.rpc(readGoalRpc, { id });
        if (latest.key !== expected.key || latest.action !== expected.nativeAction || !!latest.nativeStart !== !!expected.nativeStart) {
          await controller.refresh(id).catch(() => {});
          throw new Error("The goal changed. Review it before trying again.");
        }
        if (!latest.actionTicket) throw new Error(latest.note || latest.actionNote || "Native controls are unavailable. Open the goal to review its state.");
        // OpenCode resume needs the sheet's explicit new-budget action.
        if (latest.source === "opencode" && latest.action === "resume") throw new Error("Open this goal and review the new budget window before resuming.");
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
      return { remove: () => { pill.remove(); playback?.remove(); }, observe: (agent) => { observed = agent; updateLabel(); }, update: (value) => {
        current = value;
        updateLabel();
        const action = value?.nativeAction;
        if (!action) { playback?.update({ visible: false }); return; }
        const button = { title: value.nativeStart ? "Start goal" : action === "pause" ? "Pause goal" : "Resume goal",
          icon: action === "pause" ? "Pause" : "Play", label: value.nativeStart ? "Start goal" : action === "pause" ? "Pause" : "Resume", visible: true, disabled: value.nativeActionReady === false,
          behavior: action === "resume" && value.source === "opencode" ? { kind: "popover" as const, Content: PlaybackContent } : { kind: "action" as const, onPress: act } };
        if (playback) playback.update(button);
        else playback = client.addComposerPill({ id: "goal-playback", agentId: id, workspaceId, button });
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
