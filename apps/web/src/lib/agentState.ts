import type { WorktreeSummary } from '@ade/shared';

export type AgentState = 'waiting' | 'working' | 'finished' | 'none';

/** Estado del agente de una tarea, tal como lo ve el usuario. */
export function agentState(wt: WorktreeSummary): AgentState {
  const run = wt.agent;
  if (!run) return 'none';
  if (run.status !== 'running') return 'finished';
  return run.activity === 'waiting' ? 'waiting' : 'working';
}

export const needsAttention = (wt: WorktreeSummary) => agentState(wt) === 'waiting';

export function taskTitle(wt: WorktreeSummary): string {
  return wt.title ?? wt.id.replace(/-[0-9a-f]{6}$/, '').replace(/-/g, ' ');
}
