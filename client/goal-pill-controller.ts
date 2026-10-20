import type { GoalControl } from "../shared/contracts";

export interface PillAgent {
  id: string; workspaceId?: string | null; archivedAt?: string | null; status: string;
  provider?: string; currentModeId?: string | null; lastUserMessageAt?: string | null;
  runtimeInfo?: { modeId?: string | null }; persistence?: { sessionId: string } | null;
}
export interface PillRegistration { update(value: GoalControl): void; remove(): void }
interface Target { agent: PillAgent; nextCheck: number; fresh: boolean; revision: number; observed: string; pill?: PillRegistration }
function observation(agent: PillAgent): string {
  return JSON.stringify([agent.status, agent.provider, agent.currentModeId === undefined ? agent.runtimeInfo?.modeId : agent.currentModeId, agent.lastUserMessageAt, agent.persistence?.sessionId]);
}

export class GoalPillController {
  private targets = new Map<string, Target>();
  private stopped = false;
  private polling = false;
  constructor(private readonly read: (id: string, fresh: boolean) => Promise<GoalControl>,
    private readonly add: (id: string, workspaceId: string) => PillRegistration, private readonly now = Date.now) {}
  upsert(agent: PillAgent): void {
    if (this.stopped) return;
    if (!agent.workspaceId || agent.archivedAt) { this.remove(agent.id); return; }
    let target = this.targets.get(agent.id);
    if (target?.agent.workspaceId !== agent.workspaceId) { this.remove(agent.id); target = undefined; }
    const observed = observation(agent);
    if (!target) this.targets.set(agent.id, { agent, nextCheck: 0, fresh: this.polling, revision: 0, observed });
    else {
      if (target.observed !== observed) { target.nextCheck = 0; target.fresh = true; target.revision++; }
      target.agent = agent; target.observed = observed;
    }
  }
  snapshot(agents: PillAgent[]): void {
    // A reconnect can invalidate host-owned registrations. Rebuild the snapshot.
    const visible = new Set([...this.targets].filter(([, target]) => target.pill).map(([id]) => id));
    for (const id of this.targets.keys()) this.remove(id);
    for (const a of agents) this.upsert(a);
    // Restore known controls before scanning a large directory after reconnect.
    for (const [id, target] of this.targets) target.fresh = visible.has(id);
  }
  remove(id: string): void { this.targets.get(id)?.pill?.remove(); this.targets.delete(id); }
  async refresh(id: string, fresh = true): Promise<GoalControl> {
    const target = this.targets.get(id);
    const revision = target ? ++target.revision : 0;
    const value = await this.read(id, fresh);
    if (this.stopped || !target || this.targets.get(id) !== target || target.revision !== revision) return value;
    if (value.visible && value.workspaceId === target.agent.workspaceId) {
      target.pill ??= this.add(id, value.workspaceId!);
      target.pill.update(value);
    } else { target.pill?.remove(); target.pill = undefined; }
    return value;
  }
  async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const due = [...this.targets.entries()].filter(([, t]) => t.nextCheck <= this.now())
        .sort(([, a], [, b]) => Number(b.agent.status === "running") - Number(a.agent.status === "running"));
      let cursor = 0;
      const worker = async () => {
        while (!this.stopped) {
          // Mode changes and newly observed sessions take priority over a large
          // initial directory. Slow lookups occupy at most one of four workers.
          const next = [...this.targets.entries()].find(([, t]) => t.fresh && t.nextCheck <= this.now()) ?? due[cursor++];
          if (!next) break;
          const [id, target] = next;
          if (this.targets.get(id) !== target || target.nextCheck > this.now()) continue;
          const fresh = target.fresh; target.fresh = false;
          target.nextCheck = this.now() + (target.agent.status === "running" || target.pill ? 15_000 : 60_000);
          const revision = target.revision + 1;
          try { await this.refresh(id, fresh); }
          catch {
            // A failed lookup must not leave an actionable stale control behind.
            if (this.targets.get(id) === target && target.revision === revision) { target.pill?.remove(); target.pill = undefined; }
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally { this.polling = false; }
  }
  stop(): void { this.stopped = true; for (const id of this.targets.keys()) this.remove(id); }
}
