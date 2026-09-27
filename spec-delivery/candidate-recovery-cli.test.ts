import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as engine from './core.ts';
import {defaultSkillBindings} from './skills.ts';

const entry = fileURLToPath(new URL('../spec-delivery.workflow.ts', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const artifactDigest = (files: string[]) => sha(JSON.stringify(files.map(file => ({ file: path.resolve(file), digest: sha(fs.readFileSync(file)) }))));

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
  const skillRoot=path.join(root,'.agents','skills');
  for(const name of ['implement','diagnosing-bugs','code-review','code-review-from-claude','handoff']) {
    const directory=path.join(skillRoot,name);fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'SKILL.md'),`---\nname: ${name}\n---\n\nFixture skill.\n`);
  }
  const statePath = path.join(run, 'state.json');
  const evidencePath = path.join(run, 'evidence.md'), handoffPath = path.join(run, 'handoff.md');
  const planPath = path.join(run, 'plan.md'), checksPath = path.join(run, 'checks.md');
  for (const p of [evidencePath, handoffPath, planPath, checksPath]) fs.writeFileSync(p, `actual ${path.basename(p)}\n`);
  const targetFile = path.join(run, 'target-sha'); fs.writeFileSync(targetFile, base);
  const prFile = path.join(run, 'pr-sha'); fs.writeFileSync(prFile, base);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs=require('fs'),a=process.argv.slice(2);
const endpoint=String(a.at(-1));
if(!a.includes('graphql')){
  if(endpoint.includes('/dependencies/')||endpoint.includes('/comments?')||endpoint.includes('/sub_issues?'))
    {console.log('[[]]');process.exit(0);}
  const issue=endpoint.split('/issues/')[1];
  if(issue&&Number.isInteger(Number(issue))){const number=Number(issue);console.log(JSON.stringify({number,
    title:number===100?'Spec':'Task',body:'Actual candidate recovery source',
    html_url:'https://github.com/example/test/issues/'+number,state:'open',assignees:[]}));process.exit(0);}
  console.error('unexpected gh '+a.join(' '));process.exit(2);
}
const base=fs.readFileSync(${JSON.stringify(targetFile)},'utf8').trim();
const pr=fs.readFileSync(${JSON.stringify(prFile)},'utf8').trim();
const query=a.find(x=>x.startsWith('query='))||'';
const repository={target:{target:{oid:base}},i100:{number:100,state:'OPEN'},i101:{number:101,state:'OPEN'},i102:{number:102,state:'OPEN'}};
if(query.includes('p201:'))repository.p201={number:201,url:'https://github.com/example/test/pull/201',state:'OPEN',headRefOid:pr,baseRefOid:base,baseRefName:'main',headRefName:'task',isDraft:false,mergeable:'MERGEABLE',mergeCommit:null};
console.log(JSON.stringify({data:{repository}}));
`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const ticket = engine.buildTicket({ number: 101, kind: 'software', dependencies: [], criteria: ['done'], visual: false }, base);
  ticket.phase = phase; ticket.branch = 'task'; ticket.worktree = worktree; ticket.head = candidateHead;
  ticket.planPath=planPath;ticket.checksPath=checksPath;
  if (withPr) {
    ticket.pr = 201;
    ticket.evidence.regular = { head: base, base, path: evidencePath };
    ticket.evidence.accept = { head: base, base, path: evidencePath };
  }
  const v3=engine.initialProtocolV3();v3.skillBindings=defaultSkillBindings(skillRoot);
  const state: engine.State = {
    schema: 1, protocol: engine.currentProtocol, v3, id: 'candidate-fixture', revision: 0,
    inputs: { spec: 100, targetBranch: 'main', models: { L1: 'large', L2: 'middle', L3: 'small' } },
    spec: 100, repo: { root, slug: 'example/test', host: 'github.com', defaultBranch: 'main' },
    status: 'running', policy: { agents: 4, issues: 2, tests: 1, noProgress: 2, rounds: 3 },
    specCriteria: ['done'], planEvidence: planPath, planSourceVersion: 'fixture-source-v1', tickets: [ticket], jobs: [],
    facts: { base, issueStates: { 100: 'OPEN', 101: 'OPEN' }, prs: {}, at: '' }, auditEpoch: 1, events: [],
  };
  // This fixture starts mid-delivery. Preserve the earlier L1 authorization that
  // a real run would have recorded before reserving an implement/integrate job.
  const seedSession = (nativeId: string, jobId: string): engine.NativeSession => {
    const observation = { source: 'native_host' as const, observationId: `event-${nativeId}`, jobId,
      nativeId, provider: 'fixture', model: 'large', observedAt: '2026-09-27T00:00:00.000Z' };
    const raw = JSON.stringify(observation), evidencePath = path.join(run, `${nativeId}.json`);
    fs.writeFileSync(evidencePath, raw + '\n');
    return { ...observation, evidencePath, evidenceDigest: sha(raw) };
  };
  engine.recordL1Decision(state, { id: 'seed-global-plan', kind: 'execution-plan', scope: '$spec',
    inputVersion: engine.inputVersion(state), sourceVersion: state.planSourceVersion,
    candidateVersion: engine.globalDecisionVersion(state), artifactPath: evidencePath,
    artifactFiles: [evidencePath], artifactDigest: artifactDigest([evidencePath]),
    session: seedSession('seed-global-l1', '$spec:execution-plan'), at: '2026-09-27T00:00:00.000Z' });
  if (phase === 'implement') engine.recordL1Decision(state, { id: 'seed-plan-check', kind: 'plan-check', scope: ticket.key,
    inputVersion: engine.inputVersion(state), sourceVersion: state.planSourceVersion,
    candidateVersion: engine.candidateVersion(state, ticket), artifactPath: planPath,
    artifactFiles: [planPath, checksPath], artifactDigest: artifactDigest([planPath, checksPath]),
    session: seedSession('seed-check-l1', 'seed-plan-check'), at: '2026-09-27T00:00:00.000Z' });
  const job = engine.reserve(state)[0];
  job.dispatchToken=`fixture-${sha(job.id)}`;
  state.v3!.dispatchRecords.push({jobId:job.id,attempt:1,token:job.dispatchToken,
    targetHost:'fixture',requestedModel:job.model,packetPath:'',requestPath:'',requestDigest:'',
    status:'prepared',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    events:[],instances:[{key:`token:${job.dispatchToken}`,nativeId:null,state:'requested',
      firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),events:[]}]});
  fs.writeFileSync(statePath, JSON.stringify(state));
  const sessions = path.join(run, 'native-sessions.json'); fs.writeFileSync(sessions, '{}');
  const observe = (nativeId: string, jobId: string, model: string) => {
    const all = JSON.parse(fs.readFileSync(sessions, 'utf8'));
    all[nativeId] = { source: 'native_host', observationId: `event-${nativeId}`, jobId,
      nativeId, provider: 'fixture', model, context:{contextId:nativeId,mode:'new',proofId:`context-${nativeId}`},
      observedAt: '2026-09-27T00:00:00.000Z' };
    fs.writeFileSync(sessions, JSON.stringify(all));
  };
  const observer = path.join(bin, 'native-observer');
  fs.writeFileSync(observer, `#!/usr/bin/env node\nconst fs=require('fs');const all=JSON.parse(fs.readFileSync(${JSON.stringify(sessions)},'utf8'));const [op,id,job]=process.argv.slice(2);const found=all[id];if(op!=='observe'||!found||found.jobId!==job)process.exit(2);console.log(JSON.stringify(found));\n`);
  fs.chmodSync(observer, 0o755);
  const skillObserver=path.join(bin,'skill-observer');
  fs.writeFileSync(skillObserver,`#!/usr/bin/env node
const fs=require('fs');const [op,id,job]=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));
if(op==='capabilities')console.log(JSON.stringify({source:'native_host',jobId:job,capability:id,
  capabilities:{sourceExecution:{allowed:true,acceptsOriginalFiles:true}}}));
else if(op==='result'){
  const invocation=state.v3.skillInvocations.find(i=>i.id===id);
  if(!invocation||invocation.jobId!==job)process.exit(2);
  const source=JSON.parse(fs.readFileSync(invocation.sourceArchivePath,'utf8'));
  console.log(JSON.stringify({source:'native_host',invocationId:id,jobId:job,nativeId:invocation.session.nativeId,
    observationId:invocation.session.observationId,mode:invocation.mode,
    bindingFingerprint:invocation.bindingFingerprint,terminal:true,
    loadedFiles:source.files.map(f=>({relativePath:f.relativePath,sha256:f.sha256}))}));
}else process.exit(2);
`);fs.chmodSync(skillObserver,0o755);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    SPEC_DELIVERY_HOST_OBSERVER: observer,SPEC_DELIVERY_SKILL_OBSERVER:skillObserver };
  const call = (...args: string[]) => {
    // The existing candidate-recovery fixture models an already leased manual actor.
    if(args[0]==='bind'&&fs.existsSync(args[1])) {
      const state=JSON.parse(fs.readFileSync(args[1],'utf8')) as engine.State;
      const job=state.jobs.find(j=>j.id===args[2]);
      if(job&&!state.v3?.dispatchRecords.find(d=>d.jobId===job.id)?.managed) {
        job.legacyManualLease=true;fs.writeFileSync(args[1],JSON.stringify(state));
      }
    }
    return spawnSync(process.execPath,[entry,...args],{cwd:root,env,encoding:'utf8'});
  };
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8')) as engine.State;
  const bindingPath = path.join(run, 'binding.json');
  fs.writeFileSync(bindingPath, JSON.stringify({ nativeId: `host-${job.id}`, model: job.model }));
  observe(`host-${job.id}`, job.id, job.model);
  const bound = call('bind', statePath, job.id, bindingPath);
  assert.equal(bound.status, 0, bound.stderr);
  return { root, run, base, worktree, statePath, evidencePath, handoffPath, planPath, checksPath,
    targetFile, prFile, job, call, readState, observe };
}

function receipt(x: ReturnType<typeof fixture>, head: string, base: string) {
  const ids=professionalSkills(x,x.job);
  return { complete: true, status: 'replan', head, base, evidencePath: x.evidencePath,
    handoffPath: x.handoffPath, data: { reason: 'implementation needs a revised plan',skillInvocationIds:ids } };
}
function finishSkill(x:ReturnType<typeof fixture>,job:engine.Job,capability:engine.SkillCapability) {
  const current=x.readState().v3!.skillInvocations.find(i=>i.jobId===job.id&&i.capability===capability&&i.result);
  if(current)return current.id;
  const key=sha(`${job.id}:${capability}`).slice(0,16);
  const request=path.join(x.run,`skill-request-${key}.json`);
  fs.writeFileSync(request,JSON.stringify({capability}));
  const started=x.call('skill-start',x.statePath,job.id,request);
  assert.equal(started.status,0,started.stderr);
  const id=JSON.parse(started.stdout).invocationId as string;
  const raw=capability==='handoff'?x.handoffPath:path.join(x.run,`skill-output-${key}.md`);
  if(capability!=='handoff')fs.writeFileSync(raw,`Completed fixture ${capability}\n`);
  const outcome=path.join(x.run,`skill-outcome-${key}.json`);
  fs.writeFileSync(outcome,JSON.stringify({status:'pass',blocking:false,rawOutputPath:raw,evidencePaths:[raw]}));
  const finished=x.call('skill-finish',x.statePath,id,outcome);assert.equal(finished.status,0,finished.stderr);
  return id;
}
function professionalSkills(x:ReturnType<typeof fixture>,job:engine.Job) {
  return [finishSkill(x,job,'diagnosis'),finishSkill(x,job,'handoff')];
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
  x.observe(`host-${job.id}`, job.id, job.model);
  const bound = x.call('bind', x.statePath, job.id, binding);
  assert.equal(bound.status, 0, bound.stderr);
  if(job.action==='implement')data={...data,skillInvocationIds:professionalSkills(x,job)};
  if(job.action==='author-review')data={...data,skillInvocationIds:[finishSkill(x,job,'authorReview')]};
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
    x.observe('native-L1-replan', planning.id, planning.model);
    assert.equal(x.call('bind', x.statePath, planning.id, bindFile).status, 0);
    const resultFile = path.join(x.run, 'replan-result.json');
    fs.writeFileSync(resultFile, JSON.stringify({ model: planning.model, complete: true, status: 'planned',
      head: x.base, base: x.base, evidencePath: x.evidencePath,
      data: { planPath: x.planPath, checksPath: x.checksPath } }));
    const stale = x.call('submit', x.statePath, planning.id, resultFile);
    assert.notEqual(stale.status, 0); assert.match(stale.stderr, /过期候选 SHA/);
    assert.equal(x.readState().tickets[0].phase, 'replan');
    const failedOnce = x.readState().tickets[0].failureBudget?.totalRetries;
    assert.equal(failedOnce, 2);
    assert.equal(x.readState().tickets[0].failures?.at(-1)?.category, 'receipt_validation');
    assert.notEqual(x.call('submit', x.statePath, planning.id, resultFile).status, 0);
    assert.equal(x.readState().tickets[0].failureBudget?.totalRetries, failedOnce);
    fs.writeFileSync(resultFile, JSON.stringify({ model: planning.model, complete: true, status: 'planned',
      head: m, base: x.base, evidencePath: x.evidencePath,
      data: { planPath: x.planPath, checksPath: x.checksPath } }));
    const current = x.call('submit', x.statePath, planning.id, resultFile);
    assert.equal(current.status, 0, current.stderr);
    assert.equal(x.readState().tickets[0].phase, 'plan_check');
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});

test('cancel and replacement attempts share one bounded host budget across job IDs', () => {
  const x = fixture('implement');
  try {
    stop(x);
    let saved = x.readState();
    assert.equal(saved.tickets[0].failureBudget?.totalRetries, 1);
    let next = JSON.parse(x.call('next', x.statePath).stdout);
    const replacement = next.jobs.find((j: engine.Job) => j.ticket === '101' && j.action === 'implement');
    assert.ok(replacement); assert.notEqual(replacement.id, x.job.id);
    const bindPath = path.join(x.run, 'replacement-binding.json');
    fs.writeFileSync(bindPath, JSON.stringify({ nativeId: `host-${replacement.id}`, model: replacement.model }));
    x.observe(`host-${replacement.id}`, replacement.id, replacement.model);
    assert.equal(x.call('bind', x.statePath, replacement.id, bindPath).status, 0);
    const secondEvidence = path.join(x.run, 'second-host-observation.md'); fs.writeFileSync(secondEvidence, 'second observed stop\n');
    const statusPath = path.join(x.run, 'second-stopped.json');
    fs.writeFileSync(statusPath, JSON.stringify([{ jobId: replacement.id, nativeId: `host-${replacement.id}`,
      state: 'stopped', processTreeStopped: true, evidencePath: secondEvidence }]));
    assert.equal(x.call('reconcile', x.statePath, statusPath).status, 0);
    saved = x.readState();
    assert.equal(saved.tickets[0].failureBudget?.totalRetries, 2);
    assert.equal(saved.tickets[0].failureBudget?.consecutiveNoProgress, 2);
    assert.equal(saved.tickets[0].phase, 'replan');
    next = JSON.parse(x.call('next', x.statePath).stdout);
    const replan = next.jobs.find((j: engine.Job) => j.ticket === '101' && j.action === 'replan');
    assert.ok(replan);
    fs.writeFileSync(bindPath, JSON.stringify({ nativeId: `host-${replan.id}`, model: replan.model }));
    x.observe(`host-${replan.id}`, replan.id, replan.model);
    assert.equal(x.call('bind', x.statePath, replan.id, bindPath).status, 0);
    assert.equal(x.call('stage', x.statePath, replan.id, JSON.stringify({ complete: true, status: 'planned',
      head: x.base, base: x.base, evidencePath: x.evidencePath,
      data: { planPath: x.planPath, checksPath: x.checksPath } })).status, 0);
    assert.equal(x.readState().tickets[0].failureBudget?.totalRetries, 2, 'successful replan does not replenish total retries');
    next = JSON.parse(x.call('next', x.statePath).stdout);
    const check = next.jobs.find((j: engine.Job) => j.ticket === '101' && j.action === 'plan-check');
    assert.ok(check);
    fs.writeFileSync(bindPath, JSON.stringify({ nativeId: `host-${check.id}`, model: check.model }));
    x.observe(`host-${check.id}`, check.id, check.model);
    assert.equal(x.call('bind', x.statePath, check.id, bindPath).status, 0);
    assert.equal(x.call('stage', x.statePath, check.id, JSON.stringify({ complete: true, status: 'changes',
      head: x.base, base: x.base, evidencePath: x.evidencePath,
      data: { reason: 'still no passing plan' } })).status, 0);
    saved = x.readState();
    assert.equal(saved.tickets[0].phase, 'blocked');
    assert.equal(saved.tickets[0].failureBudget?.totalRetries, 3);
    const metrics = x.call('metrics', x.statePath); assert.equal(metrics.status, 0, metrics.stderr);
    const reported = JSON.parse(metrics.stdout).tickets.find((t: {issue:number}) => t.issue === 101);
    assert.deepEqual(reported.failureBudget.byCategory, { host: 2, semantic: 1 });
    next = JSON.parse(x.call('next', x.statePath).stdout);
    assert.equal(next.jobs.filter((j: engine.Job) => j.ticket === '101').length, 0);
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});

test('a rejected correctable receipt cannot retry the same invariant action after its writer is stopped', () => {
  const x = fixture('implement');
  try {
    const resultPath = path.join(x.run, 'bad-candidate.json');
    fs.writeFileSync(resultPath, JSON.stringify({ model: x.job.model, ...receipt(x, '0'.repeat(40), x.base) }));
    const rejected = x.call('submit', x.statePath, x.job.id, resultPath);
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /本地候选 SHA/);
    assert.notEqual(x.call('submit', x.statePath, x.job.id, resultPath).status, 0);
    assert.equal(x.readState().tickets[0].failureBudget?.totalRetries, 1);
    assert.equal(x.readState().tickets[0].phase, 'implement', 'a corrected result may still use this lease');
    stop(x);
    const saved = x.readState();
    assert.equal(saved.tickets[0].failureBudget?.totalRetries, 1, 'stopping the rejected attempt does not double count it');
    assert.equal(saved.tickets[0].phase, 'replan');
    const next = JSON.parse(x.call('next', x.statePath).stdout);
    assert.equal(next.jobs.filter((j: engine.Job) => j.ticket === '101' && j.action === 'implement').length, 0);
    assert.equal(next.jobs.filter((j: engine.Job) => j.ticket === '101' && j.action === 'replan').length, 1);
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});

test('a real failing verification command records a test failure without consuming a model retry for pending CI', () => {
  const x = fixture('implement');
  try {
    const state = x.readState(); state.jobs = []; state.tickets[0].phase = 'self'; state.tickets[0].checksPath = x.checksPath;
    state.validationOwner = '101';
    fs.writeFileSync(x.checksPath, JSON.stringify({ scopeReason: 'actual command failure',
      commands: [{ name: 'fail', argv: [process.execPath, '-e', 'process.exit(7)'], timeoutSeconds: 5 }] }));
    // The fixture starts after an L1 approval; keep that seeded approval tied to this manifest.
    state.v3!.decisionRecords.find(d => d.kind === 'plan-check')!.artifactDigest = artifactDigest([x.planPath, x.checksPath]);
    fs.writeFileSync(x.statePath, JSON.stringify(state));
    const author=x.call('next',x.statePath);assert.equal(author.status,0,author.stderr);
    const authorJob=JSON.parse(author.stdout).jobs.find((j:engine.Job)=>j.action==='author-review');
    assert.ok(authorJob);completeAgent(x,authorJob,'reviewed',x.base);
    const next = JSON.parse(x.call('next', x.statePath).stdout);
    const verify = next.jobs.find((j: engine.Job) => j.action === 'verify'); assert.ok(verify);
    const executed = x.call('execute', x.statePath, verify.id); assert.equal(executed.status, 0, executed.stderr);
    const saved = x.readState();
    assert.equal(saved.tickets[0].phase, 'implement');
    assert.equal(saved.tickets[0].failures?.[0].category, 'test');
    assert.equal(saved.tickets[0].failureBudget?.totalRetries, 1);
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
    const selfNext=x.call('next',x.statePath);assert.equal(selfNext.status,0,selfNext.stderr);
    const self = JSON.parse(selfNext.stdout).jobs.filter((j: engine.Job) => j.action==='author-review');
    assert.equal(self.length, 1);
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

test('failure events are idempotent, unknown writers retain the queue, and a stopped writer yields to an independent ticket', () => {
  const x = fixture('implement');
  try {
    const secondWorktree = path.join(x.root, '.agents', 'worktrees', 'second');
    git(x.root, 'worktree', 'add', '-b', 'second', secondWorktree, x.base);
    const state = x.readState();
    const second = engine.buildTicket({ number: 102, kind: 'software', dependencies: [], criteria: ['done'], visual: false }, x.base);
    second.phase = 'queued'; second.head = x.base; second.branch = 'second'; second.worktree = secondWorktree;
    second.planPath=x.planPath;second.checksPath=x.checksPath;
    state.tickets.push(second); state.facts.issueStates['102'] = 'OPEN'; state.validationOwner = '101';
    fs.writeFileSync(x.statePath, JSON.stringify(state));
    fs.writeFileSync(path.join(x.worktree, 'source.txt'), 'unfinished but preserved\n');
    const first = x.call('stage', x.statePath, x.job.id, JSON.stringify(receipt(x, x.base, x.base)));
    assert.notEqual(first.status, 0); assert.match(first.stderr, /未提交变化/);
    let saved = x.readState();
    assert.equal(saved.tickets[0].phase, 'recovery');
    assert.deepEqual(saved.tickets[0].failures?.map(f => f.category), ['receipt_validation']);
    assert.equal(saved.tickets[0].failureBudget?.totalRetries, 1);
    const repeated = x.call('collect', x.statePath); assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(x.readState().tickets[0].failureBudget?.totalRetries, 1);
    let next = JSON.parse(x.call('next', x.statePath).stdout);
    assert.equal(x.readState().validationOwner, '101');
    assert.equal(next.jobs.filter((j: engine.Job) => j.ticket === '102').length, 0);
    const unknown = path.join(x.run, 'unknown-tree.json');
    fs.writeFileSync(unknown, JSON.stringify([{ jobId: x.job.id, nativeId: `host-${x.job.id}`,
      state: 'lost', evidencePath: x.evidencePath }]));
    assert.match(x.call('reconcile', x.statePath, unknown).stderr, /整个进程树/);
    assert.equal(x.readState().validationOwner, '101');
    stop(x);
    saved = x.readState();
    assert.equal(saved.tickets[0].phase, 'recovery');
    assert.equal(saved.tickets[0].failureBudget?.totalRetries, 1, 'stopping an already failed attempt does not count twice');
    assert.deepEqual(saved.tickets[0].failures?.map(f => f.category), ['receipt_validation']);
    const nextAfterStop=x.call('next',x.statePath);assert.equal(nextAfterStop.status,0,nextAfterStop.stderr);
    next = JSON.parse(nextAfterStop.stdout);
    assert.equal(x.readState().validationOwner, '102');
    assert.equal(next.jobs.filter((j: engine.Job) => j.ticket === '102' && j.action==='author-review').length, 1);
    assert.equal(next.jobs.filter((j: engine.Job) => j.ticket === '101').length, 0);
    git(x.worktree, 'add', 'source.txt'); git(x.worktree, 'commit', '-m', 'preserve recovered candidate');
    const recoveredHead = git(x.worktree, 'rev-parse', 'HEAD');
    const restored = recover(x, recoveredHead, x.base); assert.equal(restored.status, 0, restored.stderr);
    next = JSON.parse(x.call('next', x.statePath).stdout);
    const replan = next.jobs.find((j: engine.Job) => j.ticket === '101' && j.action === 'replan');
    assert.ok(replan); assert.equal(replan.head, recoveredHead);
    assert.equal(x.readState().tickets[0].failureBudget?.replans, 1);
    const bindPath = path.join(x.run, 'failed-replan-binding.json');
    fs.writeFileSync(bindPath, JSON.stringify({ nativeId: `host-${replan.id}`, model: replan.model }));
    x.observe(`host-${replan.id}`, replan.id, replan.model);
    assert.equal(x.call('bind', x.statePath, replan.id, bindPath).status, 0);
    const modelFailure = x.call('stage', x.statePath, replan.id, JSON.stringify({ complete: false, status: 'model_error',
      evidencePath: x.evidencePath }));
    assert.equal(modelFailure.status, 0, modelFailure.stderr);
    saved = x.readState();
    assert.equal(saved.tickets[0].phase, 'blocked');
    assert.equal(saved.tickets[0].failureBudget?.totalRetries, 2);
    assert.deepEqual(saved.tickets[0].failures?.map(f => f.category), ['receipt_validation', 'model']);
    assert.equal(x.call('collect', x.statePath).status, 0);
    assert.equal(x.readState().tickets[0].failureBudget?.totalRetries, 2);
    next = JSON.parse(x.call('next', x.statePath).stdout);
    assert.equal(next.jobs.filter((j: engine.Job) => j.ticket === '101').length, 0);
    const resolution = path.join(x.run, 'resolve-budget.json');
    const resolveNativeId = 'native-l1-resolve-budget';
    const resolveVersions = { decisionNativeId: resolveNativeId, inputVersion: engine.inputVersion(saved),
      candidateVersion: engine.candidateVersion(saved, saved.tickets[0]) };
    x.observe(resolveNativeId, `$resolve:101:${saved.tickets[0].epoch}`, saved.inputs.models.L1);
    fs.writeFileSync(resolution, JSON.stringify([{ ticket: '101', evidencePath: x.evidencePath,
      handoffPath: x.handoffPath, ...resolveVersions }]));
    assert.match(x.call('resolve', x.statePath, resolution).stderr, /失败预算解除阻塞/);
    saved = x.readState();
    fs.writeFileSync(resolution, JSON.stringify([{ ticket: '101', evidencePath: x.evidencePath, handoffPath: x.handoffPath,
      ...resolveVersions, failureEventId: saved.tickets[0].failures!.at(-1)!.id,
      newFacts: 'committed recovery head and new model evidence' }]));
    saved.status = 'paused'; fs.writeFileSync(x.statePath, JSON.stringify(saved));
    assert.equal(x.call('resolve', x.statePath, resolution).status, 0);
    assert.equal(x.readState().status, 'paused');
    assert.equal(JSON.parse(x.call('next', x.statePath).stdout).status, 'paused');
    saved = x.readState(); saved.status = 'retired'; fs.writeFileSync(x.statePath, JSON.stringify(saved));
    assert.notEqual(x.call('resolve', x.statePath, resolution).status, 0);
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});
