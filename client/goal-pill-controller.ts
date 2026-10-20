import type { GoalControl } from "../shared/contracts";

export interface PillAgent { id: string; workspaceId?: string | null; archivedAt?: string | null; status: string }
export interface PillRegistration { update(value: GoalControl): void; remove(): void }
interface Target { agent: PillAgent; nextCheck: number; pill?: PillRegistration }

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
    if (!target) this.targets.set(agent.id, { agent, nextCheck: 0 });
    else { if (target.agent.status !== agent.status) target.nextCheck = 0; target.agent = agent; }
  }
  snapshot(agents: PillAgent[]): void {
    // A reconnect can invalidate host-owned registrations. Rebuild the snapshot.
    for (const id of this.targets.keys()) this.remove(id);
    for (const a of agents) this.upsert(a);
  }
  remove(id: string): void { this.targets.get(id)?.pill?.remove(); this.targets.delete(id); }
  async refresh(id: string, fresh = true): Promise<GoalControl> {
    const target = this.targets.get(id);
    const value = await this.read(id, fresh);
    if (this.stopped || !target || this.targets.get(id) !== target) return value;
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
      for (const [id, target] of due) {
        if (this.stopped) break;
        if (this.targets.get(id) !== target) continue;
        target.nextCheck = this.now() + (target.agent.status === "running" || target.pill ? 15_000 : 60_000);
        try { await this.refresh(id, false); }
        catch {
          // A failed lookup must not leave an actionable stale control behind.
          if (this.targets.get(id) === target) { target.pill?.remove(); target.pill = undefined; }
        }
      }
    } finally { this.polling = false; }
  }
  stop(): void { this.stopped = true; for (const id of this.targets.keys()) this.remove(id); }
}
