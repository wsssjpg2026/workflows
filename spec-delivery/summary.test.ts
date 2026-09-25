import test from 'node:test';
import assert from 'node:assert/strict';
import * as e from './core.ts';
import { summarize } from './summary.ts';

/** 手工构造的最小合法账本；镜像 workflow.test.ts 的 fixture 字段集。 */
function fixture(overrides: Partial<e.State> = {}): e.State {
  return {
    schema: 1, id: 'summary-test', revision: 0,
    inputs: { spec: 12, targetBranch: 'codex/test-deepseek-harness', models: { L1: 'large', L2: 'middle', L3: 'small' } },
    spec: 12,
    repo: { root: '/unused', slug: 'example/test', host: 'github.com', defaultBranch: 'main' },
    status: 'planning', specCriteria: [], planEvidence: '',
    tickets: [], jobs: [], auditEpoch: 1, events: [],
    facts: { base: 'A', issueStates: {}, prs: {}, at: 'fixture' },
    ...overrides,
  };
}

function ticket(key: string, phase: e.Phase, closeout = false): e.Ticket {
  const t = e.buildTicket({ number: Number(key.replace(/\D/g, '')) || 1, kind: 'software', dependencies: [], criteria: ['c'], visual: false }, 'A', closeout);
  t.key = key; t.phase = phase; return t;
}

function job(id: string, status: e.Job['status'], executor: e.Job['executor'] = 'agent'): e.Job {
  return { id, ticket: '13', epoch: 1, action: 'implement', part: '', tier: 'L3', model: 'm', executor, fresh: false,
    contextKey: 'ctx', head: 'A', base: 'A', tests: 0, status, nativeId: '' };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('空账本投影为零计数且 validationOwner 为 null', () => {
  const state = fixture();
  assert.deepEqual(summarize(state), {
    schemaVersion: 1, spec: 12, targetBranch: 'codex/test-deepseek-harness', status: 'planning',
    tickets: { total: 0, done: 0, human: 0, blocked: 0, pending: 0 },
    jobs: { active: 0, leased: 0, running: 0 },
    validationOwner: null,
  });
});

test('混合 phase 的工单计数满足 total = done+human+blocked+pending', () => {
  const state = fixture();
  state.tickets = [
    ticket('13', 'done'), ticket('14', 'done', true), ticket('15', 'human'), ticket('16', 'blocked'),
    ticket('17', 'claim'), ticket('18', 'implement'), ticket('19', 'queued'), ticket('20', 'review'), ticket('21', 'cleanup'),
  ];
  const s = summarize(state);
  assert.deepEqual(s.tickets, { total: 9, done: 2, human: 1, blocked: 1, pending: 5 });
  assert.equal(s.tickets.total, s.tickets.done + s.tickets.human + s.tickets.blocked + s.tickets.pending);
});

test('混合 job 状态只把 leased/running 计入 active', () => {
  const state = fixture();
  state.jobs = [
    job('a', 'leased', 'agent'), job('b', 'leased', 'command'),
    job('c', 'running', 'agent'), job('d', 'running', 'main'), job('e', 'running', 'command'),
    job('f', 'done'), job('g', 'cancelled'),
  ];
  const s = summarize(state);
  assert.deepEqual(s.jobs, { active: 5, leased: 2, running: 3 });
});

test('终态与暂停状态原样透传', () => {
  for (const status of ['running', 'paused', 'waiting_human', 'complete', 'retired'] as const) {
    const state = fixture({ status, tickets: [ticket('13', 'blocked')] });
    const s = summarize(state);
    assert.equal(s.status, status);
    assert.equal(s.spec, 12);
    assert.equal(s.targetBranch, 'codex/test-deepseek-harness');
    assert.deepEqual(s.tickets, { total: 1, done: 0, human: 0, blocked: 1, pending: 0 });
  }
});

test('validationOwner 缺失或为空输出 null，否则原样输出', () => {
  assert.equal(summarize(fixture()).validationOwner, null);
  assert.equal(summarize(fixture({ validationOwner: '' })).validationOwner, null);
  assert.equal(summarize(fixture({ validationOwner: '13' })).validationOwner, '13');
});

test('投影不修改输入，冻结账本下仍可调用且输出独立于输入', () => {
  const state = fixture({ status: 'running', validationOwner: '13' });
  state.tickets = [ticket('13', 'verify'), ticket('14', 'done')];
  state.jobs = [job('a', 'running'), job('b', 'done')];
  const before = structuredClone(state);
  const s = summarize(state);
  assert.deepEqual(state, before, '输入被改写');
  const frozen = deepFreeze(structuredClone(state));
  assert.deepEqual(summarize(frozen), s, '冻结输入下结果不一致');
  assert.notEqual(s.tickets, state.tickets);
  assert.notEqual(s.jobs, state.jobs);
});

test('同一输入重复调用结果确定且序列化字节一致', () => {
  const state = fixture({ status: 'running', validationOwner: '13' });
  state.tickets = [ticket('13', 'accept'), ticket('14', 'done'), ticket('15', 'blocked')];
  state.jobs = [job('a', 'leased'), job('b', 'running'), job('c', 'cancelled')];
  const first = summarize(state), second = summarize(state);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(first), JSON.stringify(summarize(state)));
});
