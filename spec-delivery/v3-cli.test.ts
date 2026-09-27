import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeResult, resultPaths } from './host.ts';

const entry = fileURLToPath(new URL('../spec-delivery.workflow.ts', import.meta.url));
const git = (cwd: string, ...argv: string[]) => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inputs = { spec: 100, targetBranch: 'main', models: { L1: 'large', L2: 'middle', L3: 'small' } };

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-v3-cli-'));
  for (const name of ['implement', 'diagnosing-bugs', 'code-review', 'code-review-from-claude', 'handoff']) {
    const directory = path.join(temp, '.agents', 'skills', name); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n\nExecute ${name} in this fixture.\n`);
  }
  const root = path.join(temp, 'repo'), bare = path.join(temp, 'origin.git');
  fs.mkdirSync(root); git(temp, 'init', '--bare', bare); git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Workflow Test');
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n'); git(root, 'add', 'source.txt'); git(root, 'commit', '-m', 'base');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'remote', 'add', 'origin', bare); git(root, 'remote', 'set-url', '--push', 'origin', 'https://github.com/example/test.git');
  git(root, 'push', bare, 'main');
  const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
  const ghLog = path.join(temp, 'gh.log');
  const comments = path.join(temp, 'comments.json'); fs.writeFileSync(comments, '[]');
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs=require('fs'),a=process.argv.slice(2),endpoint=a.at(-1);
fs.appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(a)+'\\n');
const commentsFile=${JSON.stringify(comments)};
const issue=n=>({number:n,title:n===100?'Spec':'Task',body:'Delivery',html_url:'https://github.com/example/test/issues/'+n,state:'open',assignees:[]});
if(a[0]==='repo'&&a[1]==='view') console.log(JSON.stringify({nameWithOwner:'example/test',url:'https://github.com/example/test',defaultBranchRef:{name:'main'}}));
else if(a.includes('graphql')) console.log(JSON.stringify({data:{repository:{target:{target:{oid:${JSON.stringify(head)}}},i100:{number:100,state:'OPEN'},i101:{number:101,state:'OPEN'}}}}));
else if(a[0]==='issue'&&a[1]==='comment') {const rows=JSON.parse(fs.readFileSync(commentsFile));rows.push({html_url:'https://github.com/example/test/issues/101#issuecomment-1',body:fs.readFileSync(a[a.indexOf('--body-file')+1],'utf8')});fs.writeFileSync(commentsFile,JSON.stringify(rows));console.log(rows.at(-1).html_url);}
else if(endpoint.endsWith('/git/ref/heads/main')) console.log(JSON.stringify({ref:'refs/heads/main',object:{type:'commit',sha:${JSON.stringify(head)}}}));
else if(endpoint.endsWith('/issues/100/sub_issues?per_page=100')) console.log(JSON.stringify([[issue(101)]]));
else if(endpoint.endsWith('/issues/101/sub_issues?per_page=100')) console.log('[[]]');
else if(endpoint.includes('/blocked_by?')) console.log('[[]]');
else if(endpoint.includes('/comments?')) console.log(JSON.stringify([JSON.parse(fs.readFileSync(commentsFile))]));
else if(endpoint.endsWith('/issues/100')) console.log(JSON.stringify(issue(100)));
else if(endpoint.endsWith('/issues/101')) console.log(JSON.stringify(issue(101)));
else { console.error('unexpected gh '+a.join(' ')); process.exit(2); }
`);
  fs.chmodSync(gh, 0o755);
  const sessions = path.join(temp, 'native-sessions.json'); fs.writeFileSync(sessions, '{}');
  const observe = (nativeId: string, jobId: string, model: string, provider = 'fixture') => {
    const all = JSON.parse(fs.readFileSync(sessions, 'utf8'));
    all[nativeId] = { source: 'native_host', observationId: `event-${nativeId}`, jobId, nativeId, provider, model,
      context:{contextId:nativeId,mode:'new',proofId:`context-${nativeId}`},observedAt: '2026-09-27T00:00:00.000Z' };
    fs.writeFileSync(sessions, JSON.stringify(all));
  };
  const observer = path.join(bin, 'native-observer');
  fs.writeFileSync(observer, `#!/usr/bin/env node\nconst fs=require('fs');const all=JSON.parse(fs.readFileSync(${JSON.stringify(sessions)},'utf8'));const [op,id,job]=process.argv.slice(2);const found=all[id];if(op!=='observe'||!found||found.jobId!==job)process.exit(2);console.log(JSON.stringify(found));\n`);
  fs.chmodSync(observer, 0o755);
  const env = { ...process.env, HOME: temp, PATH: bin + path.delimiter + process.env.PATH, SPEC_DELIVERY_HOST_OBSERVER: observer };
  const call = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { cwd: root, env, encoding: 'utf8' });
  const inputPath = path.join(temp, 'input.json'); fs.writeFileSync(inputPath, JSON.stringify(inputs));
  const planEvidence = path.join(temp, 'plan-evidence.md'); fs.writeFileSync(planEvidence, 'L1 plan evidence\n');
  const planPath = path.join(temp, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    capabilities: { framework: 'test', mainModel: 'large', modelRouting: 'per_agent', models: ['large', 'middle', 'small'] },
    policy: { agents: 4, issues: 1, tests: 1, noProgress: 2, rounds: 3 },
    tickets: [{ number: 101, kind: 'software', dependencies: [], criteria: ['delivered'], visual: false }],
    specCriteria: ['delivered'], evidencePath: planEvidence,
  }));
  return { temp, root, head, call, inputPath, planPath, planEvidence, ghLog, observe, sessions, env };
}
function planned(x: ReturnType<typeof fixture>) {
  const started = x.call('init', x.inputPath); assert.equal(started.status, 0, started.stderr);
  const statePath = JSON.parse(started.stdout).statePath as string;
  const plan = JSON.parse(fs.readFileSync(x.planPath, 'utf8'));
  Object.assign(plan, JSON.parse(started.stdout).decisionContext, { decisionNativeId: 'native-global-plan' });
  fs.writeFileSync(x.planPath, JSON.stringify(plan));
  x.observe('native-global-plan', '$spec:execution-plan', 'large');
  const accepted = x.call('plan', statePath, x.planPath); assert.equal(accepted.status, 0, accepted.stderr);
  const driven = x.call('drive', statePath); assert.equal(driven.status, 0, driven.stderr);
  const planning = JSON.parse(driven.stdout).jobs.find((j: {action:string}) => j.action === 'plan');
  assert.ok(planning);
  return { statePath, planning };
}
function controlledHost(x: ReturnType<typeof fixture>) {
  const store = path.join(x.temp, 'host.json');
  fs.writeFileSync(store, JSON.stringify({ mode: 'normal', attempts: 0, starts: 0, actors: {} }));
  const adapter = path.join(x.temp, 'bin', 'controlled-host');
  fs.writeFileSync(adapter, `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const store=${JSON.stringify(store)}, sessions=${JSON.stringify(x.sessions)};
const [op,requestPath]=process.argv.slice(2), request=JSON.parse(fs.readFileSync(requestPath,'utf8'));
const state=JSON.parse(fs.readFileSync(path.join(path.dirname(requestPath),'..','state.json'),'utf8'));
const dispatch=state.v3.dispatchRecords.find(d=>d.token===request.token);
if(!dispatch||dispatch.requestPath!==requestPath||!['prepared','starting','running','completed','uncertain'].includes(dispatch.status))process.exit(81);
const db=JSON.parse(fs.readFileSync(store,'utf8'));
const save=()=>fs.writeFileSync(store,JSON.stringify(db));
const reply=(data)=>console.log(JSON.stringify({token:request.token,jobId:request.jobId,targetHost:request.targetHost,...data}));
const actor=db.actors[request.token];
if(op==='query') {
  if(db.mode==='unknown')reply({state:'unknown'});
  else if(db.mode==='wrong-association'&&actor)reply({state:actor.state,nativeId:actor.nativeId,jobId:'different-job'});
  else if(actor)reply({state:actor.state,nativeId:actor.nativeId,startedAt:actor.startedAt});
  else reply({state:'not_found',authoritative:true});
} else if(op==='start') {
  db.attempts++;
  if(db.mode==='before-start') {save();process.exit(82);}
  if(!actor) {
    const nativeId='host-actor-'+request.token;
    db.actors[request.token]={state:'running',nativeId,startedAt:'2026-09-27T00:00:00.000Z'};db.starts++;
    const all=JSON.parse(fs.readFileSync(sessions,'utf8'));
    all[nativeId]={source:'native_host',observationId:'host-observed-'+request.token,jobId:request.jobId,
      nativeId,provider:'fixture',model:request.requestedModel,
      context:{contextId:nativeId,mode:'new',proofId:'context-'+request.token},observedAt:'2026-09-27T00:00:00.000Z'};
    fs.writeFileSync(sessions,JSON.stringify(all));
  }
  save();
  if(db.mode==='lost-response')process.exit(83);
  reply({state:'running',nativeId:db.actors[request.token].nativeId,startedAt:db.actors[request.token].startedAt});
} else if(op==='collect') {
  if(!actor||actor.state!=='completed')process.exit(84);
  reply({state:'completed',nativeId:actor.nativeId,result:actor.result});
} else if(op==='cancel') {
  if(!actor)process.exit(86);
  actor.state='cancelled';save();reply({state:'cancelled',nativeId:actor.nativeId,cancelledAt:'2026-09-27T00:00:02.000Z'});
} else process.exit(85);
`);
  fs.chmodSync(adapter, 0o755); x.env.SPEC_DELIVERY_HOST_ADAPTER = adapter;
  const get = () => JSON.parse(fs.readFileSync(store, 'utf8'));
  const set = (mutate: (value: ReturnType<typeof get>) => void) => { const value = get(); mutate(value); fs.writeFileSync(store, JSON.stringify(value)); };
  return { store, get, set };
}
function approvedImplementation(x: ReturnType<typeof fixture>) {
  const { statePath, planning } = planned(x);
  const binding = path.join(x.temp, 'binding.json');
  x.observe('native-ticket-plan', planning.id, 'large');
  fs.writeFileSync(binding, JSON.stringify({ nativeId: 'native-ticket-plan' }));
  assert.equal(x.call('bind', statePath, planning.id, binding).status, 0);
  const checks = path.join(x.temp, 'checks.md'); fs.writeFileSync(checks, 'actual checks\n');
  assert.equal(x.call('stage', statePath, planning.id, JSON.stringify({ complete: true, status: 'planned',
    evidencePath: x.planEvidence, data: { planPath: x.planPath, checksPath: checks } })).status, 0);
  const next = x.call('next', statePath); assert.equal(next.status, 0, next.stderr);
  const checking = JSON.parse(next.stdout).jobs.find((j: {action:string}) => j.action === 'plan-check'); assert.ok(checking);
  x.observe('native-ticket-check', checking.id, 'large');
  fs.writeFileSync(binding, JSON.stringify({ nativeId: 'native-ticket-check' }));
  assert.equal(x.call('bind', statePath, checking.id, binding).status, 0);
  assert.equal(x.call('stage', statePath, checking.id, JSON.stringify({ complete: true, status: 'pass', evidencePath: x.planEvidence })).status, 0);
  return { statePath, checks, binding };
}

test('v3 公开 CLI 从五项输入初始化、规划、认领并登记一次 agent 结果', () => {
  const x = fixture();
  try {
    const started = x.call('init', x.inputPath); assert.equal(started.status, 0, started.stderr);
    const statePath = JSON.parse(started.stdout).statePath as string;
    const initial = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(initial.protocol, 3);
    assert.equal(initial.mainSession.source, 'unknown');
    assert.equal(initial.v3.executionPath, 'legacy-v02');
    assert.deepEqual(initial.v3.decisionRecords, []);
    assert.deepEqual(initial.v3.skillInvocations, []);
    assert.deepEqual(initial.v3.dispatchRecords, []);
    assert.deepEqual(initial.v3.skillBindings.map((binding: {capability:string})=>binding.capability),
      ['implementation','diagnosis','authorReview','prReview','handoff']);
    assert.deepEqual(Object.keys(initial.inputs).sort(), ['models', 'spec', 'targetBranch']);
    assert.equal(initial.repo.root, x.root);
    assert.equal(initial.facts.base, x.head);
    x.observe('host-main-session', '$main', 'host-mini');
    assert.equal(x.call('observe-main', statePath, 'host-main-session').status, 0);
    const plan = JSON.parse(fs.readFileSync(x.planPath, 'utf8'));
    plan.capabilities.mainModel = 'host-mini';
    Object.assign(plan, JSON.parse(started.stdout).decisionContext, { decisionNativeId: 'native-global-plan' });
    fs.writeFileSync(x.planPath, JSON.stringify(plan));
    x.observe('native-global-plan', '$spec:execution-plan', 'large');
    assert.equal(x.call('plan', statePath, x.planPath).status, 0);
    const driven = x.call('drive', statePath); assert.equal(driven.status, 0, driven.stderr);
    const progressed = JSON.parse(driven.stdout);
    assert.equal(progressed.completed.length, 1, 'drive 应执行真实认领命令');
    const planning = progressed.jobs.find((j: {action:string}) => j.action === 'plan');
    assert.ok(planning?.packetPath);
    const afterClaim = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(afterClaim.tickets[0].phase, 'plan');
    assert.equal(git(afterClaim.tickets[0].worktree, 'rev-parse', 'HEAD'), x.head);
    const binding = path.join(x.temp, 'binding.json'); fs.writeFileSync(binding, JSON.stringify({ nativeId: 'real-host-plan-1', model: 'large' }));
    x.observe('real-host-plan-1', planning.id, 'large');
    assert.equal(x.call('bind', statePath, planning.id, binding).status, 0);
    const checks = path.join(x.temp, 'checks.md'); fs.writeFileSync(checks, 'test command\n');
    const receipt = { complete: true, status: 'planned', evidencePath: x.planEvidence,
      data: { planPath: x.planPath, checksPath: checks } };
    const staged = x.call('stage', statePath, planning.id, JSON.stringify(receipt)); assert.equal(staged.status, 0, staged.stderr);
    const inspected = x.call('inspect', statePath); assert.equal(inspected.status, 0, inspected.stderr);
    const afterPlan = JSON.parse(inspected.stdout);
    assert.equal(afterPlan.tickets[0].phase, 'plan_check');
    assert.equal(afterPlan.mainSession.model, 'host-mini');
    assert.deepEqual(afterPlan.v3.decisionRecords.map((d: {kind:string}) => d.kind), ['execution-plan', 'ticket-plan']);
    assert.equal(afterPlan.v3.decisionRecords[1].session.model, 'large');
    const check = x.call('next', statePath); assert.equal(check.status, 0, check.stderr);
    const checking = JSON.parse(check.stdout).jobs.find((j: {action:string}) => j.action === 'plan-check');
    assert.ok(checking);
    x.observe('independent-l1-check', checking.id, 'large');
    fs.writeFileSync(binding, JSON.stringify({ nativeId: 'independent-l1-check', model: 'wrong-self-report' }));
    assert.equal(x.call('bind', statePath, checking.id, binding).status, 0);
    const checked = x.call('stage', statePath, checking.id, JSON.stringify({ complete: true, status: 'pass', evidencePath: x.planEvidence }));
    assert.equal(checked.status, 0, checked.stderr);
    const ready = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(ready.tickets[0].phase, 'implement');
    assert.equal(ready.v3.decisionRecords.at(-1).kind, 'plan-check');
    assert.notEqual(ready.v3.decisionRecords.at(-1).session.nativeId, ready.v3.decisionRecords.at(-2).session.nativeId);
    const next = x.call('next', statePath); assert.equal(next.status, 0, next.stderr);
    assert.ok(JSON.parse(next.stdout).jobs.some((j: {action:string}) => j.action === 'implement'));
    const summary = x.call('summary', statePath); assert.equal(summary.status, 0, summary.stderr);
    assert.equal(JSON.parse(summary.stdout).schemaVersion, 1);
    assert.equal(JSON.parse(summary.stdout).tickets.pending, 1);
    const metrics = x.call('metrics', statePath); assert.equal(metrics.status, 0);
    const counts = JSON.parse(metrics.stdout);
    assert.equal(counts.modelTasks, 3);
    assert.equal(counts.deterministicTasks, 1);
    assert.equal(counts.byTier.L1, 2);
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('公开 CLI 拒绝伪造配置模型的 L1 与过期输入、来源和决策产物', () => {
  const x = fixture();
  try {
    const started = x.call('init', x.inputPath); assert.equal(started.status, 0, started.stderr);
    const statePath = JSON.parse(started.stdout).statePath as string;
    const plan = JSON.parse(fs.readFileSync(x.planPath, 'utf8'));
    Object.assign(plan, JSON.parse(started.stdout).decisionContext, { decisionNativeId: 'native-global-plan', model: 'large', source: 'native_host' });
    fs.writeFileSync(x.planPath, JSON.stringify(plan));
    x.observe('native-global-plan', '$spec:execution-plan', 'middle');
    const wrong = x.call('plan', statePath, x.planPath); assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /实际 L1 provider\/model 与配置不符/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).status, 'planning');
    x.observe('native-global-plan', '$spec:execution-plan', 'large');
    plan.inputVersion = 'stale'; fs.writeFileSync(x.planPath, JSON.stringify(plan));
    assert.match(x.call('plan', statePath, x.planPath).stderr, /输入或 spec\/sub-issue 来源版本已过期/);
    Object.assign(plan, JSON.parse(started.stdout).decisionContext); plan.sourceVersion = 'stale';
    fs.writeFileSync(x.planPath, JSON.stringify(plan));
    assert.match(x.call('plan', statePath, x.planPath).stderr, /输入或 spec\/sub-issue 来源版本已过期/);
    Object.assign(plan, JSON.parse(started.stdout).decisionContext); fs.writeFileSync(x.planPath, JSON.stringify(plan));
    assert.equal(x.call('plan', statePath, x.planPath).status, 0);
    fs.appendFileSync(x.planPath, '\n ');
    const expired = x.call('next', statePath); assert.notEqual(expired.status, 0);
    assert.match(expired.stderr, /决策.*产物已过期或被修改|资源策略产物已过期或被修改/);
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('公开 CLI 拒绝错误 L3 和 L2 原生模型；provider 路由模型可通过', () => {
  const x = fixture();
  try {
    const input = JSON.parse(fs.readFileSync(x.inputPath, 'utf8'));
    input.models.L3 = 'deepseek-official/deepseek/deepseek-v4.1-flash';
    fs.writeFileSync(x.inputPath, JSON.stringify(input));
    const plan = JSON.parse(fs.readFileSync(x.planPath, 'utf8'));
    plan.capabilities.models[2] = input.models.L3;
    fs.writeFileSync(x.planPath, JSON.stringify(plan));
    const { statePath, binding } = approvedImplementation(x);
    const next = x.call('next', statePath); assert.equal(next.status, 0, next.stderr);
    const implementing = JSON.parse(next.stdout).jobs.find((j: {action:string}) => j.action === 'implement'); assert.ok(implementing);
    x.observe('wrong-l3', implementing.id, 'middle');
    fs.writeFileSync(binding, JSON.stringify({ nativeId: 'wrong-l3', model: input.models.L3, source: 'native_host' }));
    const wrongL3 = x.call('bind', statePath, implementing.id, binding); assert.notEqual(wrongL3.status, 0);
    assert.match(wrongL3.stderr, /实际 L3 provider\/model 与配置不符/);
    x.observe('wrong-provider', implementing.id, input.models.L3, 'fixture');
    fs.writeFileSync(binding, JSON.stringify({ nativeId: 'wrong-provider', model: input.models.L3 }));
    assert.match(x.call('bind', statePath, implementing.id, binding).stderr, /实际 L3 provider\/model 与配置不符/);
    x.observe('real-l3', implementing.id, 'deepseek/deepseek-v4.1-flash', 'deepseek-official');
    fs.writeFileSync(binding, JSON.stringify({ nativeId: 'real-l3', model: 'forged' }));
    assert.equal(x.call('bind', statePath, implementing.id, binding).status, 0);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.jobs.at(-1).session.provider, 'deepseek-official');
    assert.equal(state.jobs.at(-1).session.model, 'deepseek/deepseek-v4.1-flash');
    // Seed a separate later-stage L2 lease; the binding still goes through the public CLI.
    state.jobs = []; state.tickets[0].phase = 'accept'; state.validationOwner = state.tickets[0].key;
    fs.writeFileSync(statePath, JSON.stringify(state));
    const review = x.call('next', statePath); assert.equal(review.status, 0, review.stderr);
    const accepting = JSON.parse(review.stdout).jobs.find((j: {action:string}) => j.action === 'accept'); assert.ok(accepting);
    x.observe('wrong-l2', accepting.id, 'small');
    fs.writeFileSync(binding, JSON.stringify({ nativeId: 'wrong-l2', model: 'middle' }));
    const wrongL2 = x.call('bind', statePath, accepting.id, binding); assert.notEqual(wrongL2.status, 0);
    assert.match(wrongL2.stderr, /实际 L2 provider\/model 与配置不符/);
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('每票独立计划复核及过期工件门禁通过公开 CLI 生效', () => {
  const x = fixture();
  try {
    const { statePath, planning } = planned(x);
    const binding = path.join(x.temp, 'binding.json');
    x.observe('same-l1', planning.id, 'large');
    fs.writeFileSync(binding, JSON.stringify({ nativeId: 'same-l1' }));
    assert.equal(x.call('bind', statePath, planning.id, binding).status, 0);
    const checks = path.join(x.temp, 'checks.md'); fs.writeFileSync(checks, 'actual checks\n');
    assert.equal(x.call('stage', statePath, planning.id, JSON.stringify({ complete: true, status: 'planned',
      evidencePath: x.planEvidence, data: { planPath: x.planPath, checksPath: checks } })).status, 0);
    const next = x.call('next', statePath); assert.equal(next.status, 0, next.stderr);
    const checking = JSON.parse(next.stdout).jobs.find((j: {action:string}) => j.action === 'plan-check'); assert.ok(checking);
    x.observe('same-l1', checking.id, 'large');
    const same = x.call('bind', statePath, checking.id, binding);
    assert.notEqual(same.status, 0); assert.match(same.stderr, /独立任务不能复用已有上下文/);
    const rejectedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(rejectedState.tickets[0].phase, 'plan_check');
    // A fresh run with separate sessions reaches implementation, then a changed check file invalidates the approval.
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
  const y = fixture();
  try {
    const { statePath, checks } = approvedImplementation(y);
    fs.appendFileSync(checks, 'unapproved change\n');
    const expired = y.call('next', statePath); assert.notEqual(expired.status, 0);
    assert.match(expired.stderr, /plan-check 决策产物已过期或被修改/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).tickets[0].phase, 'implement');
  } finally { fs.rmSync(y.temp, { recursive: true, force: true }); }
});

test('重新配置后旧 L1 计划版本失效，主会话身份未知仍可由新 L1 重规划', () => {
  const x = fixture();
  try {
    const { statePath } = approvedImplementation(x);
    const before = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const config = path.join(x.temp, 'reconfigure.json');
    x.observe('new-l1-session', '$spec:execution-plan', 'new-large');
    fs.writeFileSync(config, JSON.stringify({ models: { L1: 'new-large', L2: 'middle', L3: 'small' },
      capabilities: { framework: 'test', mainModel: 'host-mini', modelRouting: 'per_agent', models: ['new-large', 'middle', 'small'] },
      evidencePath: x.planEvidence, decisionNativeId: 'new-l1-session', sourceVersion: before.planSourceVersion }));
    const changed = x.call('reconfigure', statePath, config); assert.equal(changed.status, 0, changed.stderr);
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(after.mainSession.source, 'unknown');
    assert.equal(after.tickets[0].phase, 'replan');
    assert.notEqual(after.v3.decisionRecords.at(-1).inputVersion, before.v3.decisionRecords.at(-1).inputVersion);
    const next = x.call('next', statePath); assert.equal(next.status, 0, next.stderr);
    assert.ok(JSON.parse(next.stdout).jobs.some((j: {action:string;model:string}) => j.action === 'replan' && j.model === 'new-large'));
    assert.ok(!JSON.parse(next.stdout).jobs.some((j: {action:string}) => j.action === 'implement'));
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('主会话只能转发有版本和真实 L1 会话的解除阻塞决定', () => {
  const x = fixture();
  try {
    const { statePath } = planned(x);
    const seeded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    seeded.jobs = []; seeded.tickets[0].phase = 'blocked'; seeded.tickets[0].reason = 'observed failure';
    fs.writeFileSync(statePath, JSON.stringify(seeded));
    const context = x.call('decision-context', statePath); assert.equal(context.status, 0, context.stderr);
    const versions = JSON.parse(context.stdout);
    const decision = path.join(x.temp, 'resolve.json');
    const item = { ticket: seeded.tickets[0].key, evidencePath: x.planEvidence, handoffPath: x.planEvidence,
      decisionNativeId: 'resolve-l1', inputVersion: versions.inputVersion,
      candidateVersion: versions.tickets[0].candidateVersion };
    fs.writeFileSync(decision, JSON.stringify([item]));
    x.observe('resolve-l1', `$resolve:${item.ticket}:${seeded.tickets[0].epoch}`, 'middle');
    const wrong = x.call('resolve', statePath, decision); assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /实际 L1 provider\/model 与配置不符/);
    item.candidateVersion = 'stale'; fs.writeFileSync(decision, JSON.stringify([item]));
    assert.match(x.call('resolve', statePath, decision).stderr, /候选版本已过期/);
    item.candidateVersion = versions.tickets[0].candidateVersion; fs.writeFileSync(decision, JSON.stringify([item]));
    x.observe('resolve-l1', `$resolve:${item.ticket}:${seeded.tickets[0].epoch}`, 'large');
    const resolved = x.call('resolve', statePath, decision); assert.equal(resolved.status, 0, resolved.stderr);
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(after.tickets[0].phase, 'replan');
    assert.equal(after.v3.decisionRecords.at(-1).kind, 'resolve');
    assert.equal(after.v3.decisionRecords.at(-1).session.model, 'large');
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('旧协议保持只读，暂停迁移有原账本备份且不会自动恢复；退役与未知协议拒绝推进', () => {
  const x = fixture();
  try {
    const init = x.call('init', x.inputPath); assert.equal(init.status, 0, init.stderr);
    const statePath = JSON.parse(init.stdout).statePath as string;
    const old = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    old.protocol = 2; delete old.v3; old.status = 'paused';
    const oldBytes = JSON.stringify(old); fs.writeFileSync(statePath, oldBytes);
    const again = x.call('init', x.inputPath); assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).migrationRequired, true);
    assert.equal(fs.readFileSync(statePath, 'utf8'), oldBytes, 'init 不应静默迁移旧账本');
    for (const op of ['summary', 'inspect', 'metrics']) assert.equal(x.call(op, statePath).status, 0, op);
    const denied = x.call('next', statePath); assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /upgrade.*协议 3/);
    const proof = path.join(x.temp, 'migration.json');
    fs.writeFileSync(proof, JSON.stringify({ evidencePath: x.planEvidence }));
    const migrated = x.call('upgrade', statePath, proof); assert.equal(migrated.status, 0, migrated.stderr);
    const result = JSON.parse(migrated.stdout);
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), oldBytes);
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(saved.protocol, 3); assert.equal(saved.status, 'paused');
    assert.equal(x.call('next', statePath).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).status, 'paused');
    saved.status = 'retired'; fs.writeFileSync(statePath, JSON.stringify(saved));
    assert.notEqual(x.call('init', x.inputPath).status, 0);
    assert.notEqual(x.call('upgrade', statePath, proof).status, 0);
    assert.notEqual(x.call('drive', statePath).status, 0);
    for (const op of ['summary', 'inspect', 'metrics']) assert.equal(x.call(op, statePath).status, 0, op);
    saved.protocol = 99; fs.writeFileSync(statePath, JSON.stringify(saved));
    for (const op of ['summary', 'inspect', 'next']) {
      const unsupported = x.call(op, statePath); assert.notEqual(unsupported.status, 0, op);
      assert.match(unsupported.stderr, /不支持的运行协议/);
    }
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('公开 CLI 在启动前落盘 token；启动前失败及响应丢失后按 token 查询，不重复实际启动', () => {
  const x = fixture();
  try {
    const { statePath, planning } = planned(x);
    const host = controlledHost(x);
    const before = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const dispatch = before.v3.dispatchRecords.find((d: {jobId:string}) => d.jobId === planning.id);
    assert.equal(dispatch.status, 'prepared');
    assert.equal(dispatch.jobId, planning.id);
    assert.equal(dispatch.attempt, 1);
    assert.equal(dispatch.targetHost, 'test');
    assert.equal(dispatch.requestedModel, 'large');
    assert.equal(JSON.parse(fs.readFileSync(dispatch.requestPath, 'utf8')).token, dispatch.token);
    host.set(db => { db.mode = 'before-start'; });
    const failed = x.call('dispatch', statePath, planning.id); assert.equal(failed.status, 0, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).status, 'uncertain');
    assert.equal(host.get().starts, 0);
    const uncertain = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(uncertain.jobs.find((j: {id:string})=>j.id===planning.id).nativeId, '');
    assert.equal(uncertain.v3.dispatchRecords.find((d: {jobId:string})=>d.jobId===planning.id).status, 'uncertain');
    host.set(db => { db.mode = 'normal'; });
    const retried = x.call('dispatch', statePath, planning.id); assert.equal(retried.status, 0, retried.stderr);
    assert.equal(JSON.parse(retried.stdout).status, 'running', retried.stdout);
    assert.equal(host.get().starts, 1, retried.stdout);
    const bound = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const j = bound.jobs.find((j: {id:string})=>j.id===planning.id);
    assert.equal(j.nativeId, 'host-actor-'+dispatch.token);
    assert.equal(j.session.observationId, 'host-observed-'+dispatch.token);
    assert.ok(bound.v3.dispatchRecords[0].events.every((e: {evidencePath:string;digest:string}) =>
      fs.existsSync(e.evidencePath) && e.digest.length===64));
    assert.equal(x.call('dispatch', statePath, planning.id).status, 0);
    assert.equal(host.get().starts, 1);
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('启动响应丢失、绑定前后和结果落盘后恢复；重复 collect 只提交一次', () => {
  const x = fixture();
  try {
    const { statePath, planning } = planned(x), host = controlledHost(x);
    host.set(db => { db.mode = 'lost-response'; });
    const lost = x.call('dispatch', statePath, planning.id); assert.equal(lost.status, 0, lost.stderr);
    assert.equal(JSON.parse(lost.stdout).status, 'uncertain');
    const token = JSON.parse(fs.readFileSync(statePath, 'utf8')).v3.dispatchRecords[0].token;
    assert.equal(host.get().starts, 1, lost.stdout);
    host.set(db => { db.mode = 'normal'; });
    const recovered = x.call('dispatch', statePath, planning.id); assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).status, 'running');
    assert.equal(host.get().starts, 1);
    const afterBind = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(afterBind.jobs.find((j: {id:string})=>j.id===planning.id).status, 'running');
    const checks = path.join(x.temp,'host-checks.md'); fs.writeFileSync(checks,'checked\n');
    const rawResult={complete:true,status:'planned',evidencePath:x.planEvidence,data:{planPath:x.planPath,checksPath:checks}};
    host.set(db => { db.actors[token].state='completed'; db.actors[token].result=rawResult; });
    // Model a process death after result and ready-file persistence but before core submission.
    const files=resultPaths(statePath,planning.id);
    const pending=JSON.parse(fs.readFileSync(statePath,'utf8'));
    fs.writeFileSync(files.result,JSON.stringify(normalizeResult(pending,pending.jobs.find((j:{id:string})=>j.id===planning.id),rawResult)));
    fs.writeFileSync(files.ready,JSON.stringify({jobId:planning.id,at:'2026-09-27T00:00:01.000Z',resultPath:files.result}));
    const collected = x.call('collect', statePath, planning.id); assert.equal(collected.status, 0, collected.stderr);
    const finished = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(finished.jobs.find((j: {id:string})=>j.id===planning.id).status, 'done');
    assert.equal(finished.tickets[0].phase, 'plan_check');
    assert.equal(finished.v3.dispatchRecords[0].status, 'completed');
    assert.ok(finished.v3.dispatchRecords[0].instances.some((i: {nativeId:string;state:string}) =>
      i.nativeId==='host-actor-'+token && i.state==='completed'));
    const revision = finished.revision;
    assert.equal(x.call('collect', statePath, planning.id).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(statePath,'utf8')).revision, revision);
    assert.equal(host.get().starts, 1);
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('托管 actor 的预存 ready 文件须等待宿主确认终态才可收取', () => {
  const x = fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    const checks=path.join(x.temp,'early-checks.md');fs.writeFileSync(checks,'checked\n');
    const result={complete:true,status:'planned',evidencePath:x.planEvidence,data:{planPath:x.planPath,checksPath:checks}};
    const staged=x.call('stage',statePath,planning.id,JSON.stringify(result));assert.equal(staged.status,0,staged.stderr);
    assert.deepEqual(JSON.parse(staged.stdout).submitted,[]);
    const started=x.call('dispatch',statePath,planning.id);assert.equal(started.status,0,started.stderr);
    assert.equal(JSON.parse(started.stdout).status,'running');
    const pending=x.call('collect',statePath,planning.id);assert.equal(pending.status,0,pending.stderr);
    assert.deepEqual(JSON.parse(pending.stdout).submitted,[]);
    assert.equal(JSON.parse(fs.readFileSync(statePath,'utf8')).jobs.find((j:{id:string})=>j.id===planning.id).status,'running');
    const token=JSON.parse(fs.readFileSync(statePath,'utf8')).v3.dispatchRecords[0].token;
    host.set(db=>{db.actors[token].state='completed';db.actors[token].result=result;});
    const completed=x.call('collect',statePath,planning.id);assert.equal(completed.status,0,completed.stderr);
    assert.equal(JSON.parse(fs.readFileSync(statePath,'utf8')).jobs.find((j:{id:string})=>j.id===planning.id).status,'done',completed.stdout);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('托管 actor 的无效终态回执记录失败事件并保留不确定派发', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'running');
    const token=JSON.parse(fs.readFileSync(statePath,'utf8')).v3.dispatchRecords[0].token;
    host.set(db=>{db.actors[token].state='completed';db.actors[token].result={complete:true,status:'planned',
      evidencePath:x.planEvidence,data:{planPath:x.planPath}};});
    const collected=x.call('collect',statePath,planning.id);assert.equal(collected.status,0,collected.stderr);
    assert.equal(JSON.parse(collected.stdout).polled[0].status,'uncertain');
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(state.v3.dispatchRecords[0].status,'uncertain');
    assert.equal(state.tickets[0].failures.at(-1).category,'receipt_validation');
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('宿主无法判明启动状态或没有可信原生会话时保留实例证据，拒绝盲目重派', () => {
  const x = fixture();
  try {
    const { statePath, planning } = planned(x), host = controlledHost(x);
    host.set(db => { db.mode = 'unknown'; });
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'uncertain');
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'uncertain');
    assert.equal(host.get().attempts, 0);
    host.set(db => { db.mode='lost-response'; });
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'uncertain');
    const state = JSON.parse(fs.readFileSync(statePath,'utf8'));
    const token = state.v3.dispatchRecords[0].token;
    const native = 'host-actor-'+token;
    fs.writeFileSync(x.sessions, '{}');
    host.set(db => { db.mode='normal'; });
    const query = x.call('collect',statePath,planning.id); assert.equal(query.status,0,query.stderr);
    const uncertain = JSON.parse(fs.readFileSync(statePath,'utf8'));
    const record = uncertain.v3.dispatchRecords[0];
    assert.equal(record.status,'uncertain');
    assert.equal(record.instances.find((i:{nativeId:string})=>i.nativeId===native).state,'running');
    assert.equal(host.get().starts,1);
    assert.equal(x.call('dispatch',statePath,planning.id).status,0);
    assert.equal(host.get().starts,1);
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('同批快 actor 的完成事件立即收取，慢 actor 的租约与实例保持运行', () => {
  const x = fixture();
  try {
    const { statePath } = approvedImplementation(x);
    const state = JSON.parse(fs.readFileSync(statePath,'utf8'));
    const worktree = state.tickets[0].worktree as string;
    fs.writeFileSync(path.join(worktree,'source.txt'),'implemented\n');
    git(worktree,'add','source.txt');git(worktree,'commit','-m','implement');
    const head = git(worktree,'rev-parse','HEAD');
    // Enter the self-review phase directly: this test covers per-actor collection, not skill invocation.
    state.tickets[0].phase='self'; state.tickets[0].head=head; state.tickets[0].base=x.head;
    state.tickets[0].pendingPushHead=head; state.validationOwner=state.tickets[0].key;
    fs.writeFileSync(statePath,JSON.stringify(state));
    const handoff=path.join(x.temp,'handoff.md');fs.writeFileSync(handoff,'implementation handoff\n');
    const selfNext=x.call('next',statePath);assert.equal(selfNext.status,0,selfNext.stderr);
    const jobs=JSON.parse(selfNext.stdout).jobs.filter((j:{action:string})=>['self-standards','self-spec'].includes(j.action));
    assert.equal(jobs.length,2);
    const host=controlledHost(x);
    for(const j of jobs){const launched=x.call('dispatch',statePath,j.id);assert.equal(launched.status,0,launched.stderr);assert.equal(JSON.parse(launched.stdout).status,'running');}
    const fast=jobs.find((j:{action:string})=>j.action==='self-standards');
    const slow=jobs.find((j:{action:string})=>j.action==='self-spec');
    const ledger=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const token=ledger.v3.dispatchRecords.find((d:{jobId:string})=>d.jobId===fast.id).token;
    host.set(db=>{db.actors[token].state='completed';db.actors[token].result={complete:true,status:'reviewed',head,base:x.head,
      evidencePath:handoff,findings:[]};});
    const collect=x.call('collect',statePath);assert.equal(collect.status,0,collect.stderr);
    const after=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(after.jobs.find((j:{id:string})=>j.id===fast.id).status,'done');
    assert.equal(after.jobs.find((j:{id:string})=>j.id===slow.id).status,'running');
    assert.equal(after.tickets[0].phase,'self');
    assert.equal(host.get().starts,2);
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('取消保留原生实例、时间与原始事件；任务写权等待独立停止证明', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'running');
    const cancelled=x.call('dispatch-cancel',statePath,planning.id);assert.equal(cancelled.status,0,cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).status,'cancelled');
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const dispatch=state.v3.dispatchRecords[0],native=dispatch.nativeId;
    assert.equal(dispatch.status,'cancelled');
    assert.equal(dispatch.instances.find((i:{nativeId:string})=>i.nativeId===native).state,'cancelled');
    assert.equal(dispatch.instances.find((i:{nativeId:string})=>i.nativeId===native).cancelledAt,'2026-09-27T00:00:02.000Z');
    assert.equal(state.jobs.find((j:{id:string})=>j.id===planning.id).status,'running');
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'cancelled');
    assert.equal(host.get().starts,1);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('错误 job 关联的原生实例被保留；宿主随后遗失 token 也不能重启同一任务', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    host.set(db=>{db.mode='lost-response';});
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'uncertain');
    const token=JSON.parse(fs.readFileSync(statePath,'utf8')).v3.dispatchRecords[0].token;
    host.set(db=>{db.mode='wrong-association';});
    const wrong=x.call('dispatch',statePath,planning.id);assert.equal(wrong.status,0,wrong.stderr);
    assert.match(JSON.parse(wrong.stdout).error,/token、job/);
    const observed=JSON.parse(fs.readFileSync(statePath,'utf8')).v3.dispatchRecords[0];
    assert.ok(observed.instances.some((i:{nativeId:string})=>i.nativeId==='host-actor-'+token));
    host.set(db=>{db.mode='normal';delete db.actors[token];});
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'uncertain');
    assert.equal(host.get().starts,1);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('drive 使用同一派发账本启动已预留 actor，重启后保持一个原生实例', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    const first=x.call('drive',statePath);assert.equal(first.status,0,first.stderr);
    assert.ok(JSON.parse(first.stdout).dispatched.some((d:{jobId:string;status:string})=>d.jobId===planning.id&&d.status==='running'));
    assert.equal(host.get().starts,1);
    const second=x.call('drive',statePath);assert.equal(second.status,0,second.stderr);
    assert.equal(host.get().starts,1);
    assert.equal(JSON.parse(fs.readFileSync(statePath,'utf8')).jobs.find((j:{id:string})=>j.id===planning.id).status,'running');
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('派发请求文件被改写后禁止调用宿主，即使改写者填入期望模型', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    const record=JSON.parse(fs.readFileSync(statePath,'utf8')).v3.dispatchRecords[0];
    const original=fs.readFileSync(record.requestPath);
    const forged=JSON.parse(original.toString());forged.requestedModel='large';forged.source='native_host';
    fs.writeFileSync(record.requestPath,JSON.stringify(forged));
    const denied=x.call('dispatch',statePath,planning.id);assert.equal(denied.status,0,denied.stderr);
    assert.equal(JSON.parse(denied.stdout).status,'uncertain');
    assert.equal(host.get().attempts,0);
    fs.writeFileSync(record.requestPath,original);
    const recovered=x.call('dispatch',statePath,planning.id);assert.equal(recovered.status,0,recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).status,'running');
    assert.equal(host.get().starts,1);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});
