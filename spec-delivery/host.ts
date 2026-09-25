import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensure, type Job, type Result, type State } from './core.ts';

/** 模型只返回任务内容；任务身份和模型来自已验证的宿主绑定。 */
export function normalizeResult(s: State, j: Job, value: unknown): Result {
  ensure(value && typeof value === 'object' && !Array.isArray(value), 'actor 结果必须是 JSON 对象');
  const raw = structuredClone(value) as Result;
  ensure(typeof raw.complete === 'boolean' && typeof raw.status === 'string', '缺少 complete/status');
  const absolute = (p: string) => path.resolve(s.repo.root, p);
  ensure(typeof raw.evidencePath === 'string' && !!raw.evidencePath, '缺少实际证据路径');
  raw.model = j.model;
  raw.base ??= j.base;
  if (!['implement', 'integrate'].includes(j.action)) raw.head ??= j.head;
  raw.evidencePath = absolute(raw.evidencePath);
  if (raw.handoffPath) raw.handoffPath = absolute(raw.handoffPath);
  for (const field of ['planPath', 'checksPath', 'visualEvidence']) {
    if (typeof raw.data?.[field] === 'string') raw.data[field] = absolute(raw.data[field] as string);
  }
  if (['confirm', 'adjudicate'].includes(j.action) && raw.findings?.length === 1) {
    raw.findings[0].identity = j.finding?.identity;
    raw.findings[0].sources = j.finding?.sources;
  }
  return raw;
}

export function resultPaths(statePath: string, id: string) {
  const directory = path.join(path.dirname(statePath), 'jobs', createHash('sha256').update(id).digest('hex').slice(0, 20));
  return { result: path.join(directory, 'result.json'), ready: path.join(directory, 'host-ready.json') };
}

export function metrics(s: State) {
  const count = (key: 'action' | 'tier' | 'status') => s.jobs.reduce((out, j) => {
    out[j[key]] = (out[j[key]] || 0) + 1; return out;
  }, {} as Record<string, number>);
  return { run: s.id, status: s.status, jobs: s.jobs.length, byAction: count('action'), byTier: count('tier'), byStatus: count('status'),
    observation: s.telemetry || null, validationOwner: s.validationOwner || null,
    tickets: s.tickets.map(t => ({ issue: t.number, phase: t.phase, invalidations: t.baseInvalidations || 0, queueSkips: t.queueSkips || 0 })),
    tasks: s.jobs.map(j => ({ id: j.id, model: j.model, nativeId: j.nativeId, timing: j.timing || null, usage: j.usage || null })),
    note: 'null 表示未获取；绑定时间不是模型开始时间。ghInvocations 是 CLI 调用次数，不是 HTTP 分页请求数。' };
}
