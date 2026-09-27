import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as engine from './core.ts';

const entry = fileURLToPath(new URL('../spec-delivery.workflow.ts', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(phase: 'implement' | 'integrate', withPr = false, prepareTask?: (worktree: string) => string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-candidate-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Workflow Test');
  fs.writeFileSync(path.join(root, 'source.txt'), 'shared line\n');
  git(root, 'add', 'source.txt'); git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  const worktree = path.join(root, '.agents', 'worktrees', 'task');
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(root, 'worktree', 'add', '-b', 'task', worktree, base);
  const candidateHead = prepareTask?.(worktree) || base;
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n/.agents/\n');
  const run = path.join(root, '.agents', 'workflow-runs', 'test');
  fs.mkdirSync(run, { recursive: true });
  const statePath = path.join(run, 'state.json');
  const evidencePath = path.join(run, 'evidence.md'), handoffPath = path.join(run, 'handoff.md');
  const planPath = path.join(run, 'plan.md'), checksPath = path.join(run, 'checks.md');
  for (const p of [evidencePath, handoffPath, planPath, checksPath]) fs.writeFileSync(p, `actual ${path.basename(p)}\n`);
  const targetFile = path.join(run, 'target-sha'); fs.writeFileSync(targetFile, base);
  const prFile = path.join(run, 'pr-sha'); fs.writeFileSync(prFile, base);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs=require('fs'),a=process.argv.slice(2);
if(!a.includes('graphql')){console.error('unexpected gh '+a.join(' '));process.exit(2);}
const base=fs.readFileSync(${JSON.stringify(targetFile)},'utf8').trim();
const pr=fs.readFileSync(${JSON.stringify(prFile)},'utf8').trim();
const query=a.find(x=>x.startsWith('query='))||'';
const repository={target:{target:{oid:base}},i100:{number:100,state:'OPEN'},i101:{number:101,state:'OPEN'}};
if(query.includes('p201:'))repository.p201={number:201,url:'https://github.com/example/test/pull/201',state:'OPEN',headRefOid:pr,baseRefOid:base,baseRefName:'main',headRefName:'task',isDraft:false,mergeable:'MERGEABLE',mergeCommit:null};
console.log(JSON.stringify({data:{repository}}));
`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const ticket = engine.buildTicket({ number: 101, kind: 'software', dependencies: [], criteria: ['done'], visual: false }, base);
  ticket.phase = phase; ticket.branch = 'task'; ticket.worktree = worktree; ticket.head = candidateHead;
  if (withPr) {
    ticket.pr = 201;
    ticket.evidence.regular = { head: base, base, path: evidencePath };
    ticket.evidence.accept = { head: base, base, path: evidencePath };
  }
  const state: engine.State = {
    schema: 1, protocol: engine.currentProtocol, v3: engine.initialProtocolV3(), id: 'candidate-fixture', revision: 0,
    inputs: { spec: 100, targetBranch: 'main', models: { L1: 'large', L2: 'middle', L3: 'small' } },
    spec: 100, repo: { root, slug: 'example/test', host: 'github.com', defaultBranch: 'main' },
    status: 'running', policy: { agents: 4, issues: 2, tests: 1, noProgress: 2, rounds: 3 },
    specCriteria: ['done'], planEvidence: planPath, tickets: [ticket], jobs: [],
    facts: { base, issueStates: { 100: 'OPEN', 101: 'OPEN' }, prs: {}, at: '' }, auditEpoch: 1, events: [],
  };
  const job = engine.reserve(state)[0];
  fs.writeFileSync(statePath, JSON.stringify(state));
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const call = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { cwd: root, env, encoding: 'utf8' });
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as engine.State;
  const bindingPath = path.join(run, 'binding.json');
  fs.writeFileSync(bindingPath, JSON.stringify({ nativeId: `host-${job.id}`, model: job.model }));
  const bound = call('bind', statePath, job.id, bindingPath);
  assert.equal(bound.status, 0, bound.stderr);
  return { root, run, base, worktree, statePath, evidencePath, handoffPath, planPath, checksPath,
    targetFile, prFile, job, call, readState };
}

function receipt(x: ReturnType<typeof fixture>, head: string, base: string) {
  return { complete: true, status: 'replan', head, base, evidencePath: x.evidencePath,
    handoffPath: x.handoffPath, data: { reason: 'implementation needs a revised plan' } };
}
function stop(x: ReturnType<typeof fixture>) {
  const file = path.join(x.run, 'stopped.json');
  fs.writeFileSync(file, JSON.stringify([{ jobId: x.job.id, nativeId: `host-${x.job.id}`,
    state: 'stopped', processTreeStopped: true, evidencePath: x.evidencePath }]));
  const result = x.call('reconcile', x.statePath, file);
  assert.equal(result.status, 0, result.stderr);
}
function recover(x: ReturnType<typeof fixture>, head: string, base: string) {
  const state = x.readState(), decision = path.join(x.run, 'recover.json');
  fs.writeFileSync(decision, JSON.stringify({ expectedRevision: state.revision,
    expectedRecoveryHead: state.tickets[0].recovery!.observedHead, resolvedHead: head, resolvedBase: base,
    evidencePath: x.evidencePath, handoffPath: x.handoffPath, reason: 'resolved and committed work' }));
  return x.call('recover-workspace', x.statePath, '101', decision);
}
function completeAgent(x: ReturnType<typeof fixture>, job: engine.Job, status: string, head: string, data: Record<string, unknown> = {}) {
  const binding = path.join(x.run, `binding-${job.action}-${job.epoch}-${job.part}.json`);
  fs.writeFileSync(binding, JSON.stringify({ nativeId: `host-${job.id}`, model: job.model }));
  const bound = x.call('bind', x.statePath, job.id, binding);
  assert.equal(bound.status, 0, bound.stderr);
  const staged = x.call('stage', x.statePath, job.id, JSON.stringify({ complete: true, status, head, base: job.base,
    evidencePath: x.evidencePath, handoffPath: x.handoffPath, data,
    ...(['self-standards', 'self-spec'].includes(job.action) ? { findings: [] } : {}) }));
  assert.equal(staged.status, 0, staged.stderr);
}

test('commit H→M requesting replan hands M to L1, preserves unpushed candidate and separates test trees', () => {
  const x = fixture('implement', true);
  try {
    fs.writeFileSync(path.join(x.worktree, 'source.txt'), 'new committed work\n');
    git(x.worktree, 'add', 'source.txt'); git(x.worktree, 'commit', '-m', 'implementation');
    const m = git(x.worktree, 'rev-parse', 'HEAD');
    const request = path.join(x.run, 'test.json');
    fs.writeFileSync(request, JSON.stringify({ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 5, reason: 'local candidate test' }));
    const tested = x.call('test', x.statePath, x.job.id, request);
    assert.equal(tested.status, 0, tested.stderr);
    const testReceipt = JSON.parse(tested.stdout);
    assert.deepEqual({ pr: testReceipt.candidate.prHead, base: testReceipt.candidate.targetBase, local: testReceipt.candidate.localHead },
      { pr: x.base, base: x.base, local: m });
    assert.equal(testReceipt.candidate.testedTree, git(x.worktree, 'rev-parse', 'HEAD^{tree}'));
    assert.equal(testReceipt.candidateStable, true);
    const staged = x.call('stage', x.statePath, x.job.id, JSON.stringify(receipt(x, m, x.base)));
    assert.equal(staged.status, 0, staged.stderr);
    const after = x.readState().tickets[0];
    assert.equal(after.phase, 'replan'); assert.equal(after.head, m); assert.equal(after.base, x.base);
    assert.equal(after.handoffPath, x.handoffPath); assert.equal(after.reason, 'implementation needs a revised plan');
    assert.deepEqual(after.evidence, {}, 'old review/acceptance evidence must be invalidated');
    assert.equal(git(x.root, 'rev-parse', after.recoveryRef!), m, 'intermediate commit has a durable Git ref');
    const next = x.call('next', x.statePath); assert.equal(next.status, 0, next.stderr);
    const planning = JSON.parse(next.stdout).jobs.find((j: engine.Job) => j.action === 'replan');
    assert.equal(planning.head, m); assert.equal(planning.base, x.base);
    assert.equal(JSON.parse(fs.readFileSync(planning.packetPath, 'utf8')).handoffPath, x.handoffPath);
    assert.equal(x.readState().tickets[0].head, m, 'remote PR at H must not overwrite local M');
    const bindFile = path.join(x.run, 'replan-binding.json');
    fs.writeFileSync(bindFile, JSON.stringify({ nativeId: 'native-L1-replan', model: planning.model }));
    assert.equal(x.call('bind', x.statePath, planning.id, bindFile).status, 0);
    const resultFile = path.join(x.run, 'replan-result.json');
    fs.writeFileSync(resultFile, JSON.stringify({ model: planning.model, complete: true, status: 'planned',
      head: x.base, base: x.base, evidencePath: x.evidencePath,
      data: { planPath: x.planPath, checksPath: x.checksPath } }));
    const stale = x.call('submit', x.statePath, planning.id, resultFile);
    assert.notEqual(stale.status, 0); assert.match(stale.stderr, /过期候选 SHA/);
    assert.equal(x.readState().tickets[0].phase, 'replan');
    fs.writeFileSync(resultFile, JSON.stringify({ model: planning.model, complete: true, status: 'planned',
      head: m, base: x.base, evidencePath: x.evidencePath,
      data: { planPath: x.planPath, checksPath: x.checksPath } }));
    const current = x.call('submit', x.statePath, planning.id, resultFile);
    assert.equal(current.status, 0, current.stderr);
    assert.equal(x.readState().tickets[0].phase, 'plan_check');
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});

test('uncommitted WIP enters durable recovery and resumes only after actor stop and committed resolution', () => {
  const x = fixture('implement');
  try {
    fs.writeFileSync(path.join(x.worktree, 'source.txt'), 'unfinished author work\n');
    fs.writeFileSync(path.join(x.worktree, 'new-note.txt'), 'untracked work that must survive\n');
    const before = fs.readFileSync(path.join(x.worktree, 'source.txt'), 'utf8');
    const rejected = x.call('stage', x.statePath, x.job.id, JSON.stringify(receipt(x, x.base, x.base)));
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /未提交变化/);
    let ticket = x.readState().tickets[0];
    assert.equal(ticket.phase, 'recovery'); assert.equal(ticket.recovery?.kind, 'wip');
    assert.equal(fs.readFileSync(path.join(x.worktree, 'source.txt'), 'utf8'), before);
    const snapshot = JSON.parse(fs.readFileSync(ticket.recovery!.snapshotPath, 'utf8'));
    assert.match(fs.readFileSync(snapshot.worktreePatchPath, 'utf8'), /unfinished author work/);
    assert.equal(fs.readFileSync(path.join(snapshot.savedFilesPath, 'new-note.txt'), 'utf8'), 'untracked work that must survive\n');
    assert.equal(git(x.root, 'rev-parse', ticket.recovery!.recoveryRef!), x.base);
    const held = x.call('next', x.statePath);
    assert.equal(held.status, 0, held.stderr);
    assert.deepEqual(JSON.parse(held.stdout).jobs, []);
    assert.equal(JSON.parse(held.stdout).recoveries[0].kind, 'wip');
    const request = path.join(x.run, 'blocked-test.json');
    fs.writeFileSync(request, JSON.stringify({ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 5, reason: 'must wait' }));
    assert.match(x.call('test', x.statePath, x.job.id, request).stderr, /工作区正在恢复/);
    const premature = recover(x, x.base, x.base);
    assert.notEqual(premature.status, 0); assert.match(premature.stderr, /尚未确认停止/);
    const unknown = path.join(x.run, 'unknown-execution.json');
    fs.writeFileSync(unknown, JSON.stringify([{ jobId: x.job.id, nativeId: `host-${x.job.id}`,
      state: 'lost', evidencePath: x.evidencePath }]));
    const unsafe = x.call('reconcile', x.statePath, unknown);
    assert.notEqual(unsafe.status, 0); assert.match(unsafe.stderr, /整个进程树/);
    stop(x);
    const stillDirty = recover(x, x.base, x.base);
    assert.notEqual(stillDirty.status, 0); assert.match(stillDirty.stderr, /工作区必须干净/);
    fs.rmSync(path.join(x.worktree, 'new-note.txt'));
    git(x.worktree, 'add', 'source.txt'); git(x.worktree, 'commit', '-m', 'resolve WIP');
    const m = git(x.worktree, 'rev-parse', 'HEAD');
    const resumed = recover(x, m, x.base); assert.equal(resumed.status, 0, resumed.stderr);
    ticket = x.readState().tickets[0];
    assert.equal(ticket.phase, 'replan'); assert.equal(ticket.head, m);
    assert.equal(ticket.recovery, undefined); assert.equal(ticket.recoveryHistory?.length, 1);
    assert.equal(git(x.root, 'rev-parse', ticket.recoveryRef!), m);
    const next = x.call('next', x.statePath); assert.equal(next.status, 0, next.stderr);
    assert.equal(JSON.parse(next.stdout).jobs.find((j: engine.Job) => j.action === 'replan').head, m);
    // The recovered candidate returns to normal planning, implementation and real command verification.
    const replanJob = JSON.parse(next.stdout).jobs.find((j: engine.Job) => j.action === 'replan');
    fs.writeFileSync(x.checksPath, JSON.stringify({ scopeReason: 'validate recovered candidate',
      commands: [{ name: 'node smoke', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 5 }] }));
    completeAgent(x, replanJob, 'planned', m, { planPath: x.planPath, checksPath: x.checksPath });
    const checkJob = JSON.parse(x.call('next', x.statePath).stdout).jobs.find((j: engine.Job) => j.action === 'plan-check');
    completeAgent(x, checkJob, 'pass', m);
    const implementJob = JSON.parse(x.call('next', x.statePath).stdout).jobs.find((j: engine.Job) => j.action === 'implement');
    fs.writeFileSync(path.join(x.worktree, 'source.txt'), 'recovered plan implementation\n');
    git(x.worktree, 'add', 'source.txt'); git(x.worktree, 'commit', '-m', 'implement recovered plan');
    const n = git(x.worktree, 'rev-parse', 'HEAD');
    completeAgent(x, implementJob, 'implemented', n);
    const self = JSON.parse(x.call('next', x.statePath).stdout).jobs.filter((j: engine.Job) => j.action.startsWith('self-'));
    assert.equal(self.length, 2);
    for (const job of self) completeAgent(x, job, 'reviewed', n);
    const verify = JSON.parse(x.call('next', x.statePath).stdout).jobs.find((j: engine.Job) => j.action === 'verify');
    assert.ok(verify);
    const verified = x.call('execute', x.statePath, verify.id);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(x.readState().tickets[0].phase, 'publish');
    const tests = x.readState().tickets[0].evidence.tests!;
    assert.equal(tests.testedHead, n);
    assert.equal(tests.testedTree, git(x.worktree, 'rev-parse', 'HEAD^{tree}'));
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});

test('real text merge conflict preserves all index stages and resolves through the CLI to integrated M/B', () => {
  const x = fixture('integrate', false, worktree => {
    fs.writeFileSync(path.join(worktree, 'source.txt'), 'task side\n');
    git(worktree, 'add', 'source.txt'); git(worktree, 'commit', '-m', 'task change');
    return git(worktree, 'rev-parse', 'HEAD');
  });
  try {
    const a = git(x.worktree, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(x.root, 'source.txt'), 'target side\n');
    git(x.root, 'add', 'source.txt'); git(x.root, 'commit', '-m', 'target change');
    const b = git(x.root, 'rev-parse', 'HEAD'); fs.writeFileSync(x.targetFile, b);
    const merge = spawnSync('git', ['merge', '--no-edit', b], { cwd: x.worktree, encoding: 'utf8' });
    assert.notEqual(merge.status, 0, 'fixture must create a genuine conflict');
    assert.match(git(x.worktree, 'status', '--porcelain'), /UU source\.txt/);
    const conflictedBytes = fs.readFileSync(path.join(x.worktree, 'source.txt'), 'utf8');
    assert.match(conflictedBytes, /<<<<<<< HEAD/);
    const rejected = x.call('stage', x.statePath, x.job.id, JSON.stringify(receipt(x, a, b)));
    assert.notEqual(rejected.status, 0);
    let ticket = x.readState().tickets[0];
    assert.equal(ticket.phase, 'recovery'); assert.equal(ticket.recovery?.kind, 'conflict');
    const snapshot = JSON.parse(fs.readFileSync(ticket.recovery!.snapshotPath, 'utf8'));
    assert.match(fs.readFileSync(snapshot.unmergedPath, 'utf8'), /source\.txt/);
    assert.equal(fs.readFileSync(path.join(snapshot.savedFilesPath, 'source.txt'), 'utf8'), conflictedBytes);
    assert.equal(fs.readFileSync(path.join(x.worktree, 'source.txt'), 'utf8'), conflictedBytes);
    assert.equal(git(x.root, 'rev-parse', ticket.recovery!.recoveryRef!), a);
    stop(x);
    fs.writeFileSync(path.join(x.worktree, 'source.txt'), 'resolved task and target\n');
    git(x.worktree, 'add', 'source.txt'); git(x.worktree, 'commit', '-m', 'merge and resolve');
    const m = git(x.worktree, 'rev-parse', 'HEAD');
    assert.equal(git(x.worktree, 'rev-list', '--parents', '-n', '1', m).split(' ').length, 3);
    const resumed = recover(x, m, b); assert.equal(resumed.status, 0, resumed.stderr);
    ticket = x.readState().tickets[0];
    assert.equal(ticket.head, m); assert.equal(ticket.base, b); assert.equal(ticket.integrationHead, m);
    const next = x.call('next', x.statePath); assert.equal(next.status, 0, next.stderr);
    const planning = JSON.parse(next.stdout).jobs.find((j: engine.Job) => j.action === 'replan');
    assert.equal(planning.head, m); assert.equal(planning.base, b);
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});

test('clean integration commit can request L1 replan with the new target base', () => {
  const x = fixture('integrate', false, worktree => {
    fs.writeFileSync(path.join(worktree, 'source.txt'), 'task change\n');
    git(worktree, 'add', 'source.txt'); git(worktree, 'commit', '-m', 'task candidate');
    return git(worktree, 'rev-parse', 'HEAD');
  });
  try {
    fs.writeFileSync(path.join(x.root, 'target.txt'), 'new target file\n');
    git(x.root, 'add', 'target.txt'); git(x.root, 'commit', '-m', 'target advanced');
    const b = git(x.root, 'rev-parse', 'HEAD'); fs.writeFileSync(x.targetFile, b);
    git(x.worktree, 'merge', '--no-edit', b);
    const m = git(x.worktree, 'rev-parse', 'HEAD');
    const staged = x.call('stage', x.statePath, x.job.id, JSON.stringify(receipt(x, m, b)));
    assert.equal(staged.status, 0, staged.stderr);
    const ticket = x.readState().tickets[0];
    assert.equal(ticket.phase, 'replan'); assert.equal(ticket.head, m); assert.equal(ticket.base, b);
    assert.equal(ticket.integrationHead, m);
    assert.equal(git(x.root, 'rev-parse', ticket.recoveryRef!), m);
    const next = x.call('next', x.statePath); assert.equal(next.status, 0, next.stderr);
    const planning = JSON.parse(next.stdout).jobs.find((j: engine.Job) => j.action === 'replan');
    assert.equal(planning.head, m); assert.equal(planning.base, b);
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});

test('unreported local commit is classified as unknown candidate and anchored before recovery', () => {
  const x = fixture('implement');
  try {
    fs.writeFileSync(path.join(x.worktree, 'source.txt'), 'committed without a usable receipt\n');
    git(x.worktree, 'add', 'source.txt'); git(x.worktree, 'commit', '-m', 'orphan-risk commit');
    const m = git(x.worktree, 'rev-parse', 'HEAD');
    stop(x);
    const ticket = x.readState().tickets[0];
    assert.equal(ticket.phase, 'recovery'); assert.equal(ticket.recovery?.kind, 'unknown_candidate');
    assert.equal(ticket.recovery?.observedHead, m);
    assert.equal(git(x.root, 'rev-parse', ticket.recovery!.recoveryRef!), m);
    const resumed = recover(x, m, x.base);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(x.readState().tickets[0].phase, 'replan');
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});
