import type { GoalControl } from "../shared/contracts";

export interface PillAgent {
  id: string; workspaceId?: string | null; archivedAt?: string | null; status: string;
  provider?: string; currentModeId?: string | null; lastUserMessageAt?: string | null;
  runtimeInfo?: { modeId?: string | null; provider?: string }; persistence?: { sessionId: string } | null;
  activeTurn?: { turnId: string } | null;
}
export interface PillRegistration { update(value: GoalControl | null): void; observe?(agent: PillAgent): void; remove(): void }
interface Target { agent: PillAgent; nextCheck: number; fresh: boolean; revision: number; observed: string; mounts: number; pill?: PillRegistration }
const goalProviders = new Set(["codex", "omp", "pi", "claude", "opencode"]);
function observation(agent: PillAgent): string {
  return JSON.stringify([agent.status, agent.activeTurn?.turnId, agent.provider, agent.currentModeId === undefined ? agent.runtimeInfo?.modeId : agent.currentModeId, agent.lastUserMessageAt, agent.persistence?.sessionId]);
}

export interface GoalPillController {
  providers(ids: readonly string[]): void;
  upsert(agent: PillAgent): void;
  snapshot(agents: PillAgent[]): void;
  remove(id: string): void;
  refresh(id: string, fresh?: boolean): Promise<GoalControl>;
  mount(id: string): () => void;
  poll(): Promise<void>;
  stop(): void;
}

// Paseo loads this bundle directly in Hermes on mobile, without Metro's class transform.
export function createGoalPillController(read: (id: string, fresh: boolean) => Promise<GoalControl>,
  add: (id: string, workspaceId: string) => PillRegistration, now = Date.now): GoalPillController {
  const targets = new Map<string, Target>();
  let customProviders = new Set<string>();
  const hasGoalEntry = (agent: PillAgent) => [agent.provider, agent.runtimeInfo?.provider]
    .some(id => !!id && (goalProviders.has(id) || customProviders.has(id)));
  const priority = new Set<string>();
  let stopped = false, polling = false;
  let pollPromise = Promise.resolve(), wakePoll: (() => void) | undefined;
  function upsert(agent: PillAgent): void {
    if (stopped) return;
    if (!agent.workspaceId || agent.archivedAt) { remove(agent.id); return; }
    let target = targets.get(agent.id);
    if (target?.agent.workspaceId !== agent.workspaceId) { remove(agent.id); target = undefined; }
    const observed = observation(agent);
    if (!target) {
      target = { agent, nextCheck: 0, fresh: polling, revision: 0, observed, mounts: 0 };
      targets.set(agent.id, target);
      if (target.fresh) priority.add(agent.id);
    }
    else {
      if (target.observed !== observed) { target.nextCheck = 0; target.fresh = true; priority.add(agent.id); target.revision++; }
      target.agent = agent; target.observed = observed;
    }
    // A supported provider's inspection entry must not depend on a goal RPC or
    // a scan of every saved conversation. The mounted composer checks its goal.
    if (hasGoalEntry(agent) && !target.pill) { target.pill = add(agent.id, agent.workspaceId); target.pill.update(null); }
    target.pill?.observe?.(agent);
  }
  function snapshot(agents: PillAgent[]): void {
    // A reconnect can invalidate host-owned registrations. Rebuild the snapshot.
    const visible = new Set([...targets].filter(([, target]) => target.pill).map(([id]) => id));
    for (const id of targets.keys()) remove(id);
    for (const a of agents) upsert(a);
    // Restore known controls before scanning a large directory after reconnect.
    for (const [id, target] of targets) { target.fresh = visible.has(id); if (target.fresh) priority.add(id); else priority.delete(id); }
  }
  function remove(id: string): void { targets.get(id)?.pill?.remove(); targets.delete(id); priority.delete(id); }
  async function refresh(id: string, fresh = true): Promise<GoalControl> {
    const target = targets.get(id);
    const revision = target ? ++target.revision : 0;
    const value = await read(id, fresh);
    if (stopped || !target || targets.get(id) !== target || target.revision !== revision) return value;
    if ((value.visible || value.objective) && value.workspaceId === target.agent.workspaceId) {
      if (!target.pill) target.pill = add(id, value.workspaceId!);
      target.pill.observe?.(target.agent);
      target.pill.update(value);
    } else if (hasGoalEntry(target.agent) && value.workspaceId === target.agent.workspaceId) {
      if (!target.pill) target.pill = add(id, target.agent.workspaceId!);
      target.pill.observe?.(target.agent);
      target.pill.update(null);
    }
    else { target.pill?.remove(); target.pill = undefined; }
    return value;
  }
  function mount(id: string): () => void {
    const target = targets.get(id);
    if (!target || stopped) return () => {};
    target.mounts++; target.nextCheck = 0; target.fresh = true; priority.add(id);
    void poll();
    let released = false;
    return () => { if (!released) { released = true; target.mounts = Math.max(0, target.mounts - 1); } };
  }
  const eligible = (target: Target) => target.mounts > 0;
  function poll(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (polling) { wakePoll?.(); return pollPromise; }
    polling = true;
    let done!: () => void;
    pollPromise = new Promise<void>((resolve) => { done = resolve; });
    const active = new Set<Target>();
    function next(): [string, Target] | undefined {
      const due = (target: Target) => eligible(target) && !active.has(target) && target.nextCheck <= now();
      for (const id of priority) {
        const target = targets.get(id);
        if (!target || !target.fresh) { priority.delete(id); continue; }
        if (due(target)) return [id, target];
      }
      return [...targets.entries()].filter(([, target]) => due(target))
        .sort(([, a], [, b]) => Number(b.agent.status === "running") - Number(a.agent.status === "running"))[0];
    }
    function pump(): void {
      while (!stopped && active.size < 4) {
        const entry = next();
        if (!entry) break;
        const [id, target] = entry;
        active.add(target);
        const fresh = target.fresh; target.fresh = false; priority.delete(id);
        target.nextCheck = now() + (target.agent.status === "running" || target.pill ? 15_000 : 60_000);
        const revision = target.revision + 1;
        void refresh(id, fresh).then((value) => {
          // 느린 요청이 끝난 시점부터 간격을 계산하고, 중간 변경을 보존한다.
          if (targets.get(id) === target && target.revision === revision && !target.fresh) {
            target.nextCheck = now() + (value.visible ? 15_000 : 300_000);
          }
        }, () => {
          if (targets.get(id) === target && target.revision === revision) {
            if (hasGoalEntry(target.agent)) target.pill?.update(null);
            else { target.pill?.remove(); target.pill = undefined; }
          }
        }).finally(() => { active.delete(target); pump(); });
      }
      if (active.size === 0) { polling = false; wakePoll = undefined; done(); }
    }
    // 느린 조회 하나가 진행 중이어도 나중에 열린 composer는 빈 슬롯을 쓴다.
    wakePoll = pump; pump();
    return pollPromise;
  }

  function stop(): void { stopped = true; for (const id of targets.keys()) remove(id); }
  function providers(ids: readonly string[]): void {
    if (stopped) return;
    customProviders = new Set(ids);
    for (const target of targets.values()) {
      if (hasGoalEntry(target.agent)) upsert(target.agent);
      else if (target.pill) { target.pill.remove(); target.pill = undefined; }
    }
  }
  return { providers, upsert, snapshot, remove, refresh, mount, poll, stop };
}
