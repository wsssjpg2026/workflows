/** 运行账本的纯投影：把调度状态压成稳定的紧凑摘要契约。 */
import type { State } from './core.ts';

export interface SummaryTickets { total: number; done: number; human: number; blocked: number; pending: number }
export interface SummaryJobs { active: number; leased: number; running: number }
export interface Summary {
  schemaVersion: 1;
  spec: State['spec'];
  targetBranch: string;
  status: State['status'];
  tickets: SummaryTickets;
  jobs: SummaryJobs;
  validationOwner: string | null;
}

/** 只读投影：不修改输入、不读 IO、不取时钟；同一输入总是得到相同输出。 */
export function summarize(state: State): Summary {
  const total = state.tickets.length;
  let done = 0, human = 0, blocked = 0;
  for (const t of state.tickets) {
    if (t.phase === 'done') done++;
    else if (t.phase === 'human') human++;
    else if (t.phase === 'blocked') blocked++;
  }
  let leased = 0, running = 0;
  for (const j of state.jobs) {
    if (j.status === 'leased') leased++;
    else if (j.status === 'running') running++;
  }
  return {
    schemaVersion: 1,
    spec: state.spec,
    targetBranch: state.inputs.targetBranch,
    status: state.status,
    tickets: { total, done, human, blocked, pending: total - done - human - blocked },
    jobs: { active: leased + running, leased, running },
    validationOwner: state.validationOwner ? state.validationOwner : null,
  };
}
