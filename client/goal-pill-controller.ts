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

export interface GoalPillController {
  upsert(agent: PillAgent): void;
  snapshot(agents: PillAgent[]): void;
  remove(id: string): void;
  refresh(id: string, fresh?: boolean): Promise<GoalControl>;
  poll(): Promise<void>;
  stop(): void;
}

// Paseo loads this bundle directly in Hermes on mobile, without Metro's class transform.
export function createGoalPillController(read: (id: string, fresh: boolean) => Promise<GoalControl>,
  add: (id: string, workspaceId: string) => PillRegistration, now = Date.now): GoalPillController {
  const targets = new Map<string, Target>();
  let stopped = false, polling = false;
  function upsert(agent: PillAgent): void {
    if (stopped) return;
    if (!agent.workspaceId || agent.archivedAt) { remove(agent.id); return; }
    let target = targets.get(agent.id);
    if (target?.agent.workspaceId !== agent.workspaceId) { remove(agent.id); target = undefined; }
    const observed = observation(agent);
    if (!target) targets.set(agent.id, { agent, nextCheck: 0, fresh: polling, revision: 0, observed });
    else {
      if (target.observed !== observed) { target.nextCheck = 0; target.fresh = true; target.revision++; }
      target.agent = agent; target.observed = observed;
    }
  }
  function snapshot(agents: PillAgent[]): void {
    // A reconnect can invalidate host-owned registrations. Rebuild the snapshot.
    const visible = new Set([...targets].filter(([, target]) => target.pill).map(([id]) => id));
    for (const id of targets.keys()) remove(id);
    for (const a of agents) upsert(a);
    // Restore known controls before scanning a large directory after reconnect.
    for (const [id, target] of targets) target.fresh = visible.has(id);
  }
  function remove(id: string): void { targets.get(id)?.pill?.remove(); targets.delete(id); }
  async function refresh(id: string, fresh = true): Promise<GoalControl> {
    const target = targets.get(id);
    const revision = target ? ++target.revision : 0;
    const value = await read(id, fresh);
    if (stopped || !target || targets.get(id) !== target || target.revision !== revision) return value;
    if (value.visible && value.workspaceId === target.agent.workspaceId) {
      if (!target.pill) target.pill = add(id, value.workspaceId!);
      target.pill.update(value);
    } else { target.pill?.remove(); target.pill = undefined; }
    return value;
  }
  async function poll(): Promise<void> {
    if (stopped || polling) return;
    polling = true;
    try {
      const due = [...targets.entries()].filter(([, t]) => t.nextCheck <= now())
        .sort(([, a], [, b]) => Number(b.agent.status === "running") - Number(a.agent.status === "running"));
      let cursor = 0;
      const worker = async () => {
        while (!stopped) {
          // Mode changes and newly observed sessions take priority over a large
          // initial directory. Slow lookups occupy at most one of four workers.
          const next = [...targets.entries()].find(([, t]) => t.fresh && t.nextCheck <= now()) ?? due[cursor++];
          if (!next) break;
          const [id, target] = next;
          if (targets.get(id) !== target || target.nextCheck > now()) continue;
          const fresh = target.fresh; target.fresh = false;
          target.nextCheck = now() + (target.agent.status === "running" || target.pill ? 15_000 : 60_000);
          const revision = target.revision + 1;
          try {
            const value = await refresh(id, fresh);
            // Goal이 없는 대화는 목록 변경 전까지 자주 재조회하지 않는다.
            // 느린 요청의 완료 직후 같은 대화를 다시 읽는 루프도 방지한다.
            if (targets.get(id) === target && target.revision === revision && !target.fresh) {
              target.nextCheck = now() + (value.visible ? 15_000 : 300_000);
            }
          }
          catch {
            // A failed lookup must not leave an actionable stale control behind.
            if (targets.get(id) === target && target.revision === revision) { target.pill?.remove(); target.pill = undefined; }
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally { polling = false; }
  }
  function stop(): void { stopped = true; for (const id of targets.keys()) remove(id); }
  return { upsert, snapshot, remove, refresh, poll, stop };
}
