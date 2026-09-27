import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeResult, resultPaths } from './host.ts';
import { rawSourcesForJob } from './raw-sources.ts';
import * as core from './core.ts';

const entry = fileURLToPath(new URL('../spec-delivery.workflow.ts', import.meta.url));
const sha = (value:string) => createHash('sha256').update(value).digest('hex');
const git = (cwd: string, ...argv: string[]) => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inputs = { spec: 100, targetBranch: 'main', models: { L1: 'large', L2: 'middle', L3: 'small' } };

function fixture(withStandard = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-v3-cli-'));
  for (const name of ['implement', 'diagnosing-bugs', 'code-review', 'code-review-from-claude', 'handoff']) {
    const directory = path.join(temp, '.agents', 'skills', name); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n\nExecute ${name} in this fixture.\n`);
  }
  const root = path.join(temp, 'repo'), bare = path.join(temp, 'origin.git');
  fs.mkdirSync(root); git(temp, 'init', '--bare', bare); git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Workflow Test');
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n');
  if(withStandard)fs.writeFileSync(path.join(root,'AGENTS.md'),'# Fixture standard\nReview the changed source.\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'remote', 'add', 'origin', bare); git(root, 'remote', 'set-url', '--push', 'origin', 'https://github.com/example/test.git');
  git(root, 'push', bare, 'main');
  const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
  const ghLog = path.join(temp, 'gh.log');
  const comments = path.join(temp, 'comments.json'); fs.writeFileSync(comments, '[]');
  const issueSource=path.join(temp,'issue-source.txt');fs.writeFileSync(issueSource,'Delivery');
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs=require('fs'),a=process.argv.slice(2),endpoint=a.at(-1);
fs.appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(a)+'\\n');
const commentsFile=${JSON.stringify(comments)};
const issue=n=>({number:n,title:n===100?'Spec':'Task',body:fs.readFileSync(${JSON.stringify(issueSource)},'utf8'),html_url:'https://github.com/example/test/issues/'+n,state:'open',assignees:[]});
if(a[0]==='repo'&&a[1]==='view') console.log(JSON.stringify({nameWithOwner:'example/test',url:'https://github.com/example/test',defaultBranchRef:{name:'main'}}));
else if(a.includes('graphql')) console.log(JSON.stringify({data:{repository:{target:{target:{oid:${JSON.stringify(head)}}},i100:{number:100,state:'OPEN'},i101:{number:101,state:'OPEN'},p101:{number:101,url:'https://github.com/example/test/pull/101',state:'OPEN',headRefOid:${JSON.stringify(head)},baseRefOid:${JSON.stringify(head)},baseRefName:'main',headRefName:'test-review',isDraft:false,mergeable:'MERGEABLE',mergeCommit:null}}}}));
else if(['issue','pr'].includes(a[0])&&a[1]==='comment') {const rows=JSON.parse(fs.readFileSync(commentsFile));rows.push({html_url:'https://github.com/example/test/issues/101#issuecomment-'+(rows.length+1),body:fs.readFileSync(a[a.indexOf('--body-file')+1],'utf8')});fs.writeFileSync(commentsFile,JSON.stringify(rows));console.log(rows.at(-1).html_url);}
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
  return { temp, root, head, call, inputPath, planPath, planEvidence, ghLog, issueSource, observe, sessions, env };
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
  else if(db.mode==='wrong-association'&&actor)reply({state:actor.state,nativeId:actor.nativeId,jobId:'different-job',
    usage:actor.usage,provider:actor.provider});
  else if(actor)reply({state:actor.state,nativeId:actor.nativeId,startedAt:actor.startedAt,
    completedAt:actor.completedAt,usage:actor.usage,usageScope:actor.usageScope,
    modelCallId:actor.modelCallId,provider:actor.provider});
  else reply({state:'not_found',authoritative:true});
} else if(op==='start') {
  db.attempts++;
  if(db.mode==='before-start') {save();process.exit(82);}
  if(!actor) {
    const nativeId='host-actor-'+request.token;
    db.actors[request.token]={state:'running',nativeId,startedAt:'2026-09-27T00:00:00.000Z'};db.starts++;
    const all=JSON.parse(fs.readFileSync(sessions,'utf8'));
    all[nativeId]={source:'native_host',observationId:'host-observed-'+request.token,jobId:request.jobId,
      nativeId,provider:db.provider||'fixture',model:request.requestedModel,
      context:{contextId:nativeId,mode:'new',proofId:'context-'+request.token},observedAt:'2026-09-27T00:00:00.000Z'};
    fs.writeFileSync(sessions,JSON.stringify(all));
  }
  save();
  if(db.mode==='lost-response')process.exit(83);
  reply({state:'running',nativeId:db.actors[request.token].nativeId,startedAt:db.actors[request.token].startedAt});
} else if(op==='collect') {
  if(!actor||actor.state!=='completed')process.exit(84);
  reply({state:'completed',nativeId:actor.nativeId,result:actor.result,resultFile:actor.resultFile,
    finalText:actor.finalText,continuationSupported:actor.continuationSupported,
    completedAt:actor.completedAt,usage:actor.usage,usageScope:actor.usageScope,
    modelCallId:actor.modelCallId,provider:actor.provider});
} else if(op==='cancel') {
  if(!actor)process.exit(86);
  actor.state='cancelled';save();reply({state:'cancelled',nativeId:actor.nativeId,cancelledAt:'2026-09-27T00:00:02.000Z',
    usage:actor.usage,usageScope:actor.usageScope,modelCallId:actor.modelCallId,provider:actor.provider});
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
  const checks = path.join(x.temp, 'checks.md'); fs.writeFileSync(checks,
    JSON.stringify({scopeReason:'Fixture ticket acceptance',commands:[{name:'smoke',argv:['true'],timeoutSeconds:5}]}));
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
function recoveryDecision(statePath:string,jobId:string,kind:string,evidencePath:string,more:Record<string,unknown>={}) {
  const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
  const job=state.jobs.find((j:{id:string})=>j.id===jobId);
  const dispatch=state.v3.dispatchRecords.find((d:{jobId:string})=>d.jobId===jobId);
  return {kind,jobId,expectedRevision:state.revision,dispatchToken:dispatch.token,
    attempt:dispatch.attempt,expectedCandidateVersion:job.candidateVersion,
    reason:'L1 核对宿主证据后纠正当前回执',evidencePath,...more};
}
function recoveryFile(x:ReturnType<typeof fixture>,value:unknown) {
  const file=path.join(x.temp,`recovery-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file,JSON.stringify(value));return file;
}

function skillChildHarness(x: ReturnType<typeof fixture>, authorReviewPath?: string,
  professional: 'implementation'|'diagnosis'='implementation') {
  const { statePath, binding } = approvedImplementation(x), host = controlledHost(x);
  if(authorReviewPath) {
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const migration=path.join(x.temp,'review-migration.json');
    fs.writeFileSync(migration,JSON.stringify({expectedRevision:state.revision,evidencePath:x.planEvidence,
      replacements:{authorReview:authorReviewPath}}));
    const result=x.call('migrate-skills',statePath,migration);assert.equal(result.status,0,result.stderr);
  }
  const observer = path.join(x.temp, 'bin', 'skill-observer');
  fs.writeFileSync(observer, `#!/usr/bin/env node
const fs=require('fs');const [op,id,job]=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));
if(op==='capabilities') console.log(JSON.stringify({source:'native_host',jobId:job,capability:id,
  capabilities:{sourceExecution:{allowed:true,acceptsOriginalFiles:true}}}));
else if(op==='result') {
  const invocation=state.v3.skillInvocations.find(i=>i.id===id);
  if(!invocation||invocation.jobId!==job)process.exit(2);
  const source=JSON.parse(fs.readFileSync(invocation.sourceArchivePath,'utf8'));
  console.log(JSON.stringify({source:'native_host',invocationId:id,jobId:job,nativeId:invocation.session.nativeId,
    observationId:invocation.session.observationId,mode:invocation.mode,
    bindingFingerprint:invocation.bindingFingerprint,terminal:true,
    loadedFiles:source.files.map(f=>({relativePath:f.relativePath,sha256:f.sha256}))}));
} else process.exit(2);
`);
  fs.chmodSync(observer,0o755); x.env.SPEC_DELIVERY_SKILL_OBSERVER = observer;
  const call = (...args: string[]) => {
    const result=x.call(...args); assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  };
  const parentJob = call('next',statePath).jobs.find((j: {action:string})=>j.action==='implement');
  assert.ok(parentJob);
  x.observe('parent-skill-actor',parentJob.id,'small');
  fs.writeFileSync(binding,JSON.stringify({nativeId:'parent-skill-actor'}));
  call('bind',statePath,parentJob.id,binding);
  const request=path.join(x.temp,'skill-request.json');
  fs.writeFileSync(request,JSON.stringify({capability:professional}));
  const parent=call('skill-start',statePath,parentJob.id,request);
  const file=(name:string,value:unknown)=>{const p=path.join(x.temp,name);fs.writeFileSync(p,JSON.stringify(value));return p;};
  const finishSkill=(invocationId:string)=>{
    const raw=path.join(x.temp,`skill-${sha(invocationId).slice(0,12)}.md`);
    fs.writeFileSync(raw,'Actual complete professional work\n');
    return call('skill-finish',statePath,invocationId,file(`out-${sha(invocationId).slice(0,12)}.json`,
      {status:'pass',blocking:false,rawOutputPath:raw,evidencePaths:[raw]}));
  };
  const complete=(jobId:string,status:'completed'|'failed'='completed',data?:object)=>{
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const d=state.v3.dispatchRecords.find((d:{jobId:string})=>d.jobId===jobId);assert.ok(d);
    host.set(db=>{db.actors[d.token].state='completed';db.actors[d.token].result={complete:true,status,evidencePath:x.planEvidence,data};});
    call('dispatch',statePath,jobId);
  };
  return { statePath, host, parent, parentJob, call, file, finishSkill, complete };
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

test('取消保留原生实例、时间与原始事件；任务写权等待独立停止证明', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'running');
    const cancelDecision=recoveryDecision(statePath,planning.id,'cancel',x.planEvidence);
    const cancelled=x.call('dispatch-cancel',statePath,recoveryFile(x,cancelDecision));assert.equal(cancelled.status,0,cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).status,'cancelled');
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const dispatch=state.v3.dispatchRecords[0],native=dispatch.nativeId;
    assert.equal(dispatch.status,'cancelled');
    assert.equal(dispatch.instances.find((i:{nativeId:string})=>i.nativeId===native).state,'cancelled');
    assert.equal(dispatch.instances.find((i:{nativeId:string})=>i.nativeId===native).cancelledAt,'2026-09-27T00:00:02.000Z');
    assert.equal(state.jobs.find((j:{id:string})=>j.id===planning.id).status,'running');
    assert.equal(state.v3.recoveryRecords.at(-1).kind,'cancel');
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'cancelled');
    assert.equal(host.get().starts,1);
    const unproven=recoveryDecision(statePath,planning.id,'confirm-stop',x.planEvidence,
      {observedState:'stopped',processTreeStopped:false});
    assert.notEqual(x.call('recover-result',statePath,recoveryFile(x,unproven)).status,0);
    assert.equal(JSON.parse(fs.readFileSync(statePath,'utf8')).jobs.find((j:{id:string})=>j.id===planning.id).status,'running');
    const proven=recoveryDecision(statePath,planning.id,'confirm-stop',x.planEvidence,
      {observedState:'stopped',processTreeStopped:true});
    assert.equal(x.call('recover-result',statePath,recoveryFile(x,proven)).status,0);
    const stopped=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(stopped.jobs.find((j:{id:string})=>j.id===planning.id).status,'cancelled');
    assert.equal(stopped.v3.recoveryRecords.at(-1).kind,'confirm-stop');
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

test('技能双子任务走公开 CLI 预算和持久派发；乱序完成、失败重试及父门禁', () => {
  const x=fixture();
  try {
    const h=skillChildHarness(x), invocationId=h.parent.invocationId;
    const request=h.file('two-children.json',{children:[
      {key:'standards',tier:'L3',instruction:'Check standards independently'},
      {key:'spec',tier:'L3',instruction:'Check spec independently'},
    ]});
    h.call('skill-delegate',h.statePath,invocationId,request);
    h.call('skill-delegate',h.statePath,invocationId,request);
    const first=h.call('next',h.statePath).jobs.filter((j:{action:string})=>j.action==='skill-child');
    assert.equal(first.length,2);
    assert.deepEqual(first.map((j:{model:string})=>j.model),['small','small']);
    const state=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    assert.equal(state.v3.skillChildren.length,2);
    assert.equal(state.jobs.filter((j:{status:string;executor:string})=>
      ['leased','running'].includes(j.status)&&j.executor==='agent').length+1,4,
    '主控、父 actor 和两个子 actor 占满四个 agent 槽位');
    const childPacket=JSON.parse(fs.readFileSync(first[0].packetPath,'utf8'));
    assert.equal(childPacket.skillChild.parentInvocationId,invocationId);
    assert.equal(childPacket.skillChild.independent,true);
    assert.equal(childPacket.skillChild.candidateVersion,first[0].candidateVersion);
    x.observe('parent-skill-actor',first[0].id,'small');
    const reused=h.file('reused-native.json',{nativeId:'parent-skill-actor'});
    const denied=x.call('bind',h.statePath,first[0].id,reused);
    assert.notEqual(denied.status,0);assert.match(denied.stderr,/不能复用父会话/);
    for(const child of first) h.call('dispatch',h.statePath,child.id);
    h.complete(first[1].id);
    const midway=h.call('skill-continue',h.statePath,invocationId);
    assert.equal(midway.waiting,true);
    assert.deepEqual(midway.children.map((c:{state:string})=>c.state),['running','completed']);
    const early=x.call('skill-finish',h.statePath,invocationId,
      h.file('premature.json',{status:'pass',blocking:false,rawOutputPath:x.planEvidence,evidencePaths:[x.planEvidence]}));
    assert.notEqual(early.status,0);assert.match(early.stderr,/技能子任务.*在途租约/);
    h.complete(first[0].id,'failed');
    assert.deepEqual(h.call('skill-continue',h.statePath,invocationId).children.map((c:{state:string})=>c.state),
      ['failed','completed']);
    h.call('skill-retry',h.statePath,invocationId,h.file('retry.json',{keys:['standards']}));
    const retry=h.call('next',h.statePath).jobs.find((j:{action:string})=>j.action==='skill-child');
    assert.ok(retry);assert.notEqual(retry.id,first[0].id);
    h.call('dispatch',h.statePath,retry.id);h.complete(retry.id);
    assert.equal(h.call('skill-continue',h.statePath,invocationId).waiting,false);
    assert.equal(h.host.get().starts,3,'失败只重试一个子任务，不重跑已完成兄弟任务');
    assert.equal(h.finishSkill(invocationId).status,'pass');
    const after=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    assert.equal(after.jobs.filter((j:{action:string})=>j.action==='skill-child').length,3);
    assert.deepEqual(after.v3.skillChildren.map((c:{jobIds:string[]})=>c.jobIds.length),[2,1]);
    assert.notEqual(x.call('skill-delegate',h.statePath,invocationId,request).status,0);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('技能可在五项并行结果后追加确认任务；引用替代技能版本并从账本续接', () => {
  const x=fixture();
  try {
    const alternate=path.join(x.temp,'.agents','skills','code-review','method.md');
    fs.writeFileSync(alternate,'Alternate professional method\n');
    const h=skillChildHarness(x,path.join(path.dirname(alternate),'SKILL.md')), invocationId=h.parent.invocationId;
    h.call('skill-delegate',h.statePath,invocationId,h.file('lenses.json',{children:
      Array.from({length:5},(_,n)=>({key:`lens-${n}`,tier:'L2',instruction:`Independent lens ${n}`}))}));
    const seen=new Set<string>();
    while(h.call('skill-continue',h.statePath,invocationId).waiting) {
      const offered=h.call('next',h.statePath).jobs.filter((j:{action:string})=>j.action==='skill-child');
      for(const child of offered) if(!seen.has(child.id)) {h.call('dispatch',h.statePath,child.id);seen.add(child.id);}
      const state=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
      const running=state.jobs.filter((j:{action:string;status:string})=>j.action==='skill-child'&&j.status==='running');
      assert.ok(running.length>0);
      h.complete(running.at(-1).id);
      assert.ok(state.jobs.filter((j:{action:string;status:string})=>j.action==='skill-child'&&
        ['leased','running'].includes(j.status)).length<=2,'并行数遵守父 actor 占用后的预算');
    }
    assert.equal(seen.size,5);
    const firstSnapshot=h.call('skill-continue',h.statePath,invocationId);
    assert.equal(firstSnapshot.children.length,5);
    h.call('skill-delegate',h.statePath,invocationId,h.file('confirmations.json',{children:[
      {key:'confirm-a',tier:'L2',instruction:'Confirm earlier evidence',skillCapability:'authorReview'},
      {key:'confirm-b',tier:'L1',instruction:'Independent second confirmation'},
    ]}));
    const next=h.call('next',h.statePath).jobs.filter((j:{action:string})=>j.action==='skill-child');
    assert.equal(next.length,2);
    const nested=next.find((j:{part:string})=>j.part==='confirm-a');assert.ok(nested);
    const packet=JSON.parse(fs.readFileSync(nested.packetPath,'utf8'));
    const binding=JSON.parse(fs.readFileSync(h.statePath,'utf8')).v3.skillBindings.find((b:{capability:string})=>b.capability==='authorReview');
    assert.equal(packet.skillChild.dependencyFingerprint,binding.fingerprint);
    assert.ok(binding.files.some((f:{relativePath:string})=>f.relativePath==='method.md'));
    for(const child of next) h.call('dispatch',h.statePath,child.id);
    const nestedCall=h.call('skill-start',h.statePath,nested.id,h.file('nested-skill.json',{capability:'authorReview'}));
    assert.equal(h.finishSkill(nestedCall.invocationId).status,'pass');
    h.complete(nested.id,'completed',{skillInvocationIds:[nestedCall.invocationId]});
    h.complete(next.find((j:{part:string})=>j.part==='confirm-b').id);
    const final=h.call('skill-continue',h.statePath,invocationId);
    assert.equal(final.waiting,false);assert.equal(final.children.length,7);
    assert.equal(h.finishSkill(invocationId).status,'pass');
    assert.equal(h.host.get().starts,7);
    const saved=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    assert.equal(saved.jobs.filter((j:{action:string})=>j.action==='skill-child').length,7);
    assert.ok(saved.v3.skillChildren.every((c:{candidateVersion:string})=>
      c.candidateVersion===h.parentJob.candidateVersion));
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('父技能宿主中断后由新 actor 续接同一调用，已完成子结果保持原任务与身份', () => {
  const x=fixture();
  try {
    const h=skillChildHarness(x), invocationId=h.parent.invocationId;
    h.call('skill-delegate',h.statePath,invocationId,h.file('resume-children.json',{children:[
      {key:'first',tier:'L2',instruction:'First independent result'},
      {key:'second',tier:'L2',instruction:'Second independent result'},
    ]}));
    const children=h.call('next',h.statePath).jobs.filter((j:{action:string})=>j.action==='skill-child');
    for(const child of children)h.call('dispatch',h.statePath,child.id);
    h.complete(children[0].id);
    const proof=path.join(x.temp,'parent-stopped.md');fs.writeFileSync(proof,'Host confirmed old parent process tree stopped');
    h.call('reconcile',h.statePath,h.file('parent-stop.json',[{jobId:h.parentJob.id,
      nativeId:'parent-skill-actor',state:'stopped',evidencePath:proof,processTreeStopped:true}]));
    const replacement=h.call('next',h.statePath).jobs.find((j:{action:string})=>j.action==='implement');
    assert.ok(replacement);
    const packet=JSON.parse(fs.readFileSync(replacement.packetPath,'utf8'));
    assert.equal(packet.skillResume.invocationId,invocationId);
    h.call('dispatch',h.statePath,replacement.id);
    const before=x.call('skill-start',h.statePath,replacement.id,
      h.file('replacement-skill.json',{capability:'implementation'}));
    assert.notEqual(before.status,0);assert.match(before.stderr,/skill-resume/);
    const resumed=h.call('skill-resume',h.statePath,invocationId,
      h.file('resume.json',{jobId:replacement.id,evidencePath:proof}));
    assert.equal(resumed.parentJobId,replacement.id);
    assert.deepEqual(resumed.children.map((c:{state:string})=>c.state),['completed','running']);
    h.complete(children[1].id);
    assert.equal(h.finishSkill(invocationId).status,'pass');
    const saved=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    assert.equal(saved.v3.skillInvocations.find((i:{id:string})=>i.id===invocationId).resumeHistory.length,1);
    assert.equal(saved.v3.skillChildren[0].jobIds[0],children[0].id);
    assert.equal(saved.jobs.filter((j:{action:string})=>j.action==='skill-child').length,2);
    assert.equal(h.host.get().starts,3,'两个子任务和一个新父任务各启动一次');
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('技能子任务的畸形回执保留修订，不消耗父工单失败预算', () => {
  const x=fixture();
  try {
    const h=skillChildHarness(x),invocationId=h.parent.invocationId;
    h.call('skill-delegate',h.statePath,invocationId,h.file('malformed-child.json',
      {children:[{key:'review',tier:'L2',instruction:'Review candidate'}]}));
    const child=h.call('next',h.statePath).jobs.find((j:{action:string})=>j.action==='skill-child');
    assert.ok(child);
    h.call('dispatch',h.statePath,child.id);
    const before=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    const token=before.v3.dispatchRecords.find((d:{jobId:string})=>d.jobId===child.id).token;
    h.host.set(db=>{db.actors[token].state='completed';db.actors[token].result='{"complete":';});
    const polled=h.call('collect',h.statePath,child.id);
    assert.equal(polled.polled[0].status,'uncertain');
    const after=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    assert.equal(after.v3.receiptRecords.find((r:{jobId:string})=>r.jobId===child.id).revisions[0].status,'rejected');
    assert.equal(after.tickets[0].failureBudget?.totalRetries || 0,0);
    assert.equal(after.tickets[0].phase,'implement');
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('畸形回执逐字节归档，带版本修订只重验回执且并发旧决定失败', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x), binding=path.join(x.temp,'binding.json');
    x.observe('receipt-author',planning.id,'large');
    fs.writeFileSync(binding,JSON.stringify({nativeId:'receipt-author'}));
    assert.equal(x.call('bind',statePath,planning.id,binding).status,0);
    const checks=path.join(x.temp,'repair-checks.md');fs.writeFileSync(checks,'checked\n');
    const bad=Buffer.from('```json\n{"complete":true,"status":"planned"}\n```\n');
    const badFile=path.join(x.temp,'bad-receipt.bin');fs.writeFileSync(badFile,bad);
    const staged=x.call('stage-raw',statePath,planning.id,badFile);
    assert.notEqual(staged.status,0);
    const failed=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const record=failed.v3.receiptRecords.find((r:{jobId:string})=>r.jobId===planning.id);
    const original=record.revisions[0];
    assert.deepEqual(fs.readFileSync(original.rawPath),bad);
    assert.equal(original.status,'rejected');
    assert.equal(failed.tickets[0].failureBudget.totalRetries,1);
    assert.equal(failed.jobs.find((j:{id:string})=>j.id===planning.id).status,'running');
    const corrected=path.join(x.temp,'corrected.json');
    fs.writeFileSync(corrected,JSON.stringify({complete:true,status:'planned',evidencePath:x.planEvidence,
      data:{planPath:x.planPath,checksPath:checks}}));
    const decision=recoveryDecision(statePath,planning.id,'revise-receipt',x.planEvidence,
      {previousRevisionId:original.id,rawPath:corrected});
    const decisionFile=recoveryFile(x,decision),headBefore=git(x.root,'rev-parse','HEAD');
    const repaired=x.call('recover-result',statePath,decisionFile);
    assert.equal(repaired.status,0,repaired.stderr);
    const final=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const chain=final.v3.receiptRecords.find((r:{jobId:string})=>r.jobId===planning.id);
    assert.equal(chain.revisions.length,2);
    assert.equal(chain.revisions[1].previousId,original.id);
    assert.equal(chain.revisions[1].status,'accepted');
    assert.equal(final.jobs.find((j:{id:string})=>j.id===planning.id).status,'done');
    assert.deepEqual(fs.readFileSync(original.rawPath),bad);
    assert.equal(final.tickets[0].failureBudget.totalRetries,1);
    assert.equal(git(x.root,'rev-parse','HEAD'),headBefore);
    const stale=x.call('recover-result',statePath,decisionFile);
    assert.notEqual(stale.status,0);assert.match(stale.stderr,/版本已过期/);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('宿主结构化结果优先于冲突文件和终态文本；纯文件结果保留非法原文', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'running');
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const token=state.v3.dispatchRecords.find((d:{jobId:string})=>d.jobId===planning.id).token;
    const packet=JSON.parse(fs.readFileSync(state.v3.dispatchRecords[0].packetPath,'utf8'));
    const file=path.join(packet.outputDirectory,'host-result.json');fs.writeFileSync(file,'{"complete":');
    const checks=path.join(x.temp,'structured-checks.md');fs.writeFileSync(checks,'checked\n');
    host.set(db=>{db.actors[token].state='completed';db.actors[token].resultFile=file;
      db.actors[token].finalText='{"complete":false,"status":"wrong"}';
      db.actors[token].result={complete:true,status:'planned',evidencePath:x.planEvidence,
        data:{planPath:x.planPath,checksPath:checks}};});
    const structured=x.call('collect',statePath,planning.id);assert.equal(structured.status,0,structured.stderr);
    const accepted=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const rev=accepted.v3.receiptRecords.find((r:{jobId:string})=>r.jobId===planning.id).revisions[0];
    assert.equal(rev.source,'host_structured');
    assert.equal(accepted.jobs.find((j:{id:string})=>j.id===planning.id).status,'done');
    assert.equal(host.get().starts,1);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
  const y=fixture();
  try {
    const {statePath,planning}=planned(y),host=controlledHost(y);
    assert.equal(JSON.parse(y.call('dispatch',statePath,planning.id).stdout).status,'running');
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const token=state.v3.dispatchRecords[0].token;
    const packet=JSON.parse(fs.readFileSync(state.v3.dispatchRecords[0].packetPath,'utf8'));
    const file=path.join(packet.outputDirectory,'broken.json');
    const bytes=Buffer.from('{"complete":true,"status":"planned","evidencePath":"bad\\q"');
    fs.writeFileSync(file,bytes);
    host.set(db=>{db.actors[token].state='completed';db.actors[token].resultFile=file;
      db.actors[token].finalText='{"complete":true,"status":"planned"}';});
    const collected=y.call('collect',statePath,planning.id);assert.equal(collected.status,0,collected.stderr);
    assert.equal(JSON.parse(collected.stdout).polled[0].status,'uncertain');
    const failed=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const rev=failed.v3.receiptRecords.find((r:{jobId:string})=>r.jobId===planning.id).revisions[0];
    assert.equal(rev.source,'host_file');assert.deepEqual(fs.readFileSync(rev.rawPath),bytes);
    assert.equal(failed.jobs.find((j:{id:string})=>j.id===planning.id).status,'running');
  } finally {fs.rmSync(y.temp,{recursive:true,force:true});}
});

test('错误绑定经宿主实例日志纠正；相同版本的第二次纠正被拒绝', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    host.set(db=>{db.mode='lost-response';});
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'uncertain');
    host.set(db=>{db.mode='wrong-association';});
    assert.equal(JSON.parse(x.call('collect',statePath,planning.id).stdout).polled[0].status,'uncertain');
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const token=state.v3.dispatchRecords[0].token,nativeId='host-actor-'+token;
    assert.equal(state.jobs.find((j:{id:string})=>j.id===planning.id).nativeId,'');
    const decision=recoveryDecision(statePath,planning.id,'correct-binding',x.planEvidence,
      {expectedNativeId:'',nativeId});
    const decisionFile=recoveryFile(x,decision);
    const fixed=x.call('recover-result',statePath,decisionFile);assert.equal(fixed.status,0,fixed.stderr);
    const after=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(after.jobs.find((j:{id:string})=>j.id===planning.id).nativeId,nativeId);
    assert.equal(after.v3.recoveryRecords.at(-1).afterNativeId,nativeId);
    assert.equal(host.get().starts,1);
    const stale=x.call('recover-result',statePath,decisionFile);assert.notEqual(stale.status,0);
    assert.match(stale.stderr,/版本已过期/);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('独立回执修复者只提交原任务修订，不重复启动原业务实例', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'running');
    const token=JSON.parse(fs.readFileSync(statePath,'utf8')).v3.dispatchRecords[0].token;
    host.set(db=>{db.actors[token].state='completed';db.actors[token].result='{"complete":';});
    assert.equal(JSON.parse(x.call('collect',statePath,planning.id).stdout).polled[0].status,'uncertain');
    assert.equal(JSON.parse(x.call('collect',statePath,planning.id).stdout).polled[0].status,'uncertain');
    const failed=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(failed.tickets[0].failureBudget.totalRetries,1);
    const rev=failed.v3.receiptRecords.find((r:{jobId:string})=>r.jobId===planning.id).revisions[0];
    const decision=recoveryDecision(statePath,planning.id,'prepare-repair',x.planEvidence,
      {previousRevisionId:rev.id});
    const prepared=x.call('recover-result',statePath,recoveryFile(x,decision));
    assert.equal(prepared.status,0,prepared.stderr);
    const pending=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const repair=pending.jobs.find((j:{action:string})=>j.action==='repair-receipt');assert.ok(repair);
    const repairDispatch=pending.v3.dispatchRecords.find((d:{jobId:string})=>d.jobId===repair.id);
    const packet=JSON.parse(fs.readFileSync(repairDispatch.packetPath,'utf8'));
    assert.equal(packet.repairContext.rawPath,rev.rawPath);
    assert.equal(packet.resourceGrant.worktreeWrite,false);
    assert.equal(packet.contextIntent.kind,'independent');
    assert.equal(JSON.parse(fs.readFileSync(repairDispatch.requestPath,'utf8')).contextIntent.kind,'independent');
    assert.equal(JSON.parse(x.call('dispatch',statePath,repair.id).stdout).status,'running');
    const checks=path.join(x.temp,'independent-checks.md');fs.writeFileSync(checks,'checked\n');
    host.set(db=>{db.actors[repairDispatch.token].state='completed';
      db.actors[repairDispatch.token].result={complete:true,status:'planned',evidencePath:x.planEvidence,
        data:{planPath:x.planPath,checksPath:checks}};});
    const finished=x.call('collect',statePath,repair.id);assert.equal(finished.status,0,finished.stderr);
    const final=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(final.jobs.find((j:{id:string})=>j.id===planning.id).status,'done');
    assert.equal(final.jobs.find((j:{id:string})=>j.id===repair.id).status,'done');
    assert.notEqual(final.jobs.find((j:{id:string})=>j.id===planning.id).contextObservation.contextId,
      final.jobs.find((j:{id:string})=>j.id===repair.id).contextObservation.contextId);
    const chain=final.v3.receiptRecords.find((r:{jobId:string})=>r.jobId===planning.id);
    assert.equal(chain.revisions[1].previousId,rev.id);
    assert.equal(chain.revisions[1].repairJobId,repair.id);
    assert.equal(host.get().starts,2);
    assert.equal(Object.keys(host.get().actors).filter(t=>t===token).length,1);
    assert.deepEqual(fs.readFileSync(rev.rawPath),Buffer.from('{"complete":'));
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('可靠续接的原 actor 修订须匹配后续宿主事件和原始字节', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'running');
    const token=JSON.parse(fs.readFileSync(statePath,'utf8')).v3.dispatchRecords[0].token;
    host.set(db=>{db.actors[token].state='completed';db.actors[token].result='{"complete":';
      db.actors[token].continuationSupported=true;});
    assert.equal(JSON.parse(x.call('collect',statePath,planning.id).stdout).polled[0].status,'uncertain');
    const failed=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const previous=failed.v3.receiptRecords[0].currentId;
    const checks=path.join(x.temp,'continued-checks.md');fs.writeFileSync(checks,'checked\n');
    const corrected={complete:true,status:'planned',evidencePath:x.planEvidence,
      data:{planPath:x.planPath,checksPath:checks}};
    host.set(db=>{db.actors[token].result=corrected;});
    assert.equal(JSON.parse(x.call('collect',statePath,planning.id).stdout).polled[0].status,'uncertain');
    const evidence=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const continuedEvent=evidence.v3.dispatchRecords[0].events.at(-1).evidencePath;
    const rawPath=path.join(x.temp,'continued.json');fs.writeFileSync(rawPath,JSON.stringify(corrected));
    const decision=recoveryDecision(statePath,planning.id,'revise-receipt',x.planEvidence,
      {previousRevisionId:previous,rawPath,continuationHostEvent:continuedEvent});
    const wrong=path.join(x.temp,'wrong.json');fs.writeFileSync(wrong,'{}');
    const rejected=x.call('recover-result',statePath,recoveryFile(x,{...decision,rawPath:wrong}));
    assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/权威结果字节不符/);
    const accepted=x.call('recover-result',statePath,recoveryFile(x,decision));
    assert.equal(accepted.status,0,accepted.stderr);
    const final=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const revised=final.v3.receiptRecords[0].revisions[1];
    assert.equal(revised.previousId,previous);
    assert.equal(revised.sourceHostEvent,continuedEvent);
    assert.equal(revised.sourceNativeId,'host-actor-'+token);
    assert.equal(final.jobs.find((j:{id:string})=>j.id===planning.id).status,'done');
    assert.equal(host.get().starts,1);
    const instance=JSON.parse(x.call('metrics',statePath).stdout).reconciliation.instances
      .find((i:{nativeId:string})=>i.nativeId==='host-actor-'+token);
    assert.deepEqual(instance.receiptRevisions.map((r:{status:string})=>r.status),['rejected','accepted']);
    assert.ok(instance.jobFailureEvents.some((f:{category:string})=>f.category==='receipt_validation'));
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('不同失败修订耗尽统一预算后停止同候选重试，旧 ready 不会再消费', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),binding=path.join(x.temp,'binding.json');
    x.observe('budget-actor',planning.id,'large');
    fs.writeFileSync(binding,JSON.stringify({nativeId:'budget-actor'}));
    assert.equal(x.call('bind',statePath,planning.id,binding).status,0);
    const first=x.call('stage',statePath,planning.id,'{');assert.notEqual(first.status,0);
    for(const bad of ['not-json','```json\n{}\n```']) {
      const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
      const current=state.v3.receiptRecords.find((r:{jobId:string})=>r.jobId===planning.id).currentId;
      const rawPath=path.join(x.temp,`bad-${state.revision}.txt`);fs.writeFileSync(rawPath,bad);
      const decision=recoveryDecision(statePath,planning.id,'revise-receipt',x.planEvidence,
        {previousRevisionId:current,rawPath});
      const repaired=x.call('recover-result',statePath,recoveryFile(x,decision));
      assert.notEqual(repaired.status,0);
    }
    const exhausted=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(exhausted.tickets[0].failureBudget.totalRetries,3);
    assert.equal(exhausted.tickets[0].phase,'replan');
    assert.equal(exhausted.v3.receiptRecords[0].revisions.length,3);
    const collected=x.call('collect',statePath,planning.id);assert.equal(collected.status,0,collected.stderr);
    const after=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(after.tickets[0].failureBudget.totalRetries,3);
    assert.equal(after.jobs.find((j:{id:string})=>j.id===planning.id).status,'running');
    const next=x.call('next',statePath);assert.equal(next.status,0,next.stderr);
    assert.ok(!JSON.parse(next.stdout).jobs.some((j:{ticket:string})=>j.ticket===planning.ticket));
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('批准计划到 implement 内嵌双轴作者自检只采纳一次，并生成可发布候选', () => {
  const x=fixture();
  try {
    const plan=JSON.parse(fs.readFileSync(x.planPath,'utf8'));plan.policy.agents=5;
    fs.writeFileSync(x.planPath,JSON.stringify(plan));
    const h=skillChildHarness(x),statePath=h.statePath;
    const before=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const t=before.tickets[0], packet=JSON.parse(fs.readFileSync(h.parentJob.packetPath,'utf8'));
    assert.equal(packet.planPath,t.planPath);assert.equal(packet.checksPath,t.checksPath);
    assert.equal(packet.sourceUrl,'https://github.com/example/test/issues/101');
    const worktree=t.worktree as string;
    fs.writeFileSync(path.join(worktree,'source.txt'),'delivered\n');
    git(worktree,'add','source.txt');git(worktree,'commit','-m','Implement #101');
    const head=git(worktree,'rev-parse','HEAD');
    const tested=h.call('test',statePath,h.parentJob.id,h.file('author-test.json',
      {argv:['true'],timeoutSeconds:5,reason:'TDD acceptance smoke for #101'}));
    assert.equal(tested.exitCode,0);
    h.call('skill-delegate',statePath,h.parent.invocationId,h.file('embedded-review.json',{children:[
      {key:'author-review',tier:'L3',instruction:'Execute the currently bound two-axis authorReview on committed #101',
        skillCapability:'authorReview',head},
    ]}));
    const reviewer=h.call('next',statePath).jobs.find((j:{action:string})=>j.action==='skill-child');
    assert.ok(reviewer);h.call('dispatch',statePath,reviewer.id);
    const review=h.call('skill-start',statePath,reviewer.id,h.file('author-review-call.json',{capability:'authorReview'}));
    const source=JSON.parse(fs.readFileSync(review.sourceArchivePath,'utf8'));
    assert.ok(source.files.some((f:{relativePath:string})=>f.relativePath==='automation-context.md'));
    assert.match(Buffer.from(source.files.find((f:{relativePath:string})=>f.relativePath==='SKILL.md').dataBase64,'base64').toString(),
      /Standards[\s\S]*Spec/);
    h.call('skill-delegate',statePath,review.invocationId,h.file('two-axes.json',{children:[
      {key:'standards',tier:'L3',instruction:'Independent Standards axis for #101',independent:true},
      {key:'spec',tier:'L3',instruction:'Independent Spec axis for #101',independent:true},
    ]}));
    const axes=h.call('next',statePath).jobs.filter((j:{action:string})=>j.action==='skill-child');
    assert.equal(axes.length,2);
    for(const axis of axes)h.call('dispatch',statePath,axis.id);
    for(const axis of axes)h.complete(axis.id);
    assert.equal(h.call('skill-continue',statePath,review.invocationId).waiting,false);
    h.finishSkill(review.invocationId);
    h.complete(reviewer.id,'completed',{skillInvocationIds:[review.invocationId]});
    h.finishSkill(h.parent.invocationId);
    const handoff=h.call('skill-start',statePath,h.parentJob.id,h.file('handoff-call.json',{capability:'handoff'}));
    const handoffResult=h.finishSkill(handoff.invocationId);
    h.call('stage',statePath,h.parentJob.id,JSON.stringify({complete:true,status:'implemented',head,base:x.head,
      evidencePath:x.planEvidence,handoffPath:handoffResult.result.rawOutputPath,
      data:{skillInvocationIds:[h.parent.invocationId,handoff.invocationId]}}));
    const after=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(after.tickets[0].authorReview.invocationId,review.invocationId);
    assert.equal(after.tickets[0].evidence.self.head,head);
    assert.equal(after.v3.skillChildren.filter((c:{skillCapability:string})=>c.skillCapability==='authorReview').length,1);
    assert.equal(after.jobs.filter((j:{action:string})=>['self-standards','self-spec','author-review'].includes(j.action)).length,0);
    const verification=h.call('next',statePath).jobs.find((j:{action:string})=>j.action==='verify');
    assert.ok(verification);h.call('execute',statePath,verification.id);
    const ready=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(ready.tickets[0].phase,'publish');
    assert.equal(ready.tickets[0].evidence.tests.testedHead,head);
    fs.writeFileSync(x.issueSource,'Delivery with clarified acceptance');
    const changed=h.call('next',statePath).jobs;
    assert.equal(changed.filter((j:{action:string})=>j.action==='author-review').length,1);
    assert.equal(changed.filter((j:{action:string})=>['self-standards','self-spec'].includes(j.action)).length,0);
    const invalid=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(invalid.tickets[0].authorReview,undefined);
    assert.equal(invalid.tickets[0].evidence.tests,undefined);
    const renewed=changed.find((j:{action:string})=>j.action==='author-review');
    h.call('dispatch',statePath,renewed.id);
    const renewedCall=h.call('skill-start',statePath,renewed.id,h.file('renewed-author-review.json',{capability:'authorReview'}));
    h.call('skill-delegate',statePath,renewedCall.invocationId,h.file('renewed-axes.json',{children:[
      {key:'standards',tier:'L3',instruction:'Standards axis after issue change'},
      {key:'spec',tier:'L3',instruction:'Spec axis after issue change'},
    ]}));
    const renewedAxes=h.call('next',statePath).jobs.filter((j:{action:string})=>j.action==='skill-child');
    assert.equal(renewedAxes.length,2);
    for(const axis of renewedAxes)h.call('dispatch',statePath,axis.id);
    for(const axis of renewedAxes)h.complete(axis.id);
    h.finishSkill(renewedCall.invocationId);
    const running=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const dispatch=running.v3.dispatchRecords.find((d:{jobId:string})=>d.jobId===renewed.id);
    h.host.set(db=>{db.actors[dispatch.token].state='completed';db.actors[dispatch.token].result={
      complete:true,status:'reviewed',head,base:x.head,evidencePath:x.planEvidence,
      data:{skillInvocationIds:[renewedCall.invocationId]}};});
    h.call('dispatch',statePath,renewed.id);
    const reviewed=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(reviewed.tickets[0].phase,'verify');
    assert.equal(reviewed.tickets[0].authorReview.invocationId,renewedCall.invocationId);
    fs.writeFileSync(path.join(worktree,'source.txt'),'new candidate\n');
    git(worktree,'add','source.txt');git(worktree,'commit','-m','Revise #101');
    const stale=h.call('next',statePath);
    assert.equal(stale.status,'running');
    const recovery=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(recovery.tickets[0].phase,'recovery');
    assert.ok(!stale.jobs.some((j:{action:string})=>['verify','publish'].includes(j.action)));
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('替代 authorReview 包无需改变调度算法，仍由 implement 内一次真实调用通过门禁', () => {
  const x=fixture();
  try {
    const alternate=path.join(x.temp,'.agents','skills','code-review');
    fs.writeFileSync(path.join(alternate,'method.md'),'Alternative author review method\n');
    const h=skillChildHarness(x,path.join(alternate,'SKILL.md'));
    const state=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    const worktree=state.tickets[0].worktree as string;
    fs.writeFileSync(path.join(worktree,'source.txt'),'alternative review\n');
    git(worktree,'add','source.txt');git(worktree,'commit','-m','Implement #101 with alternative review');
    const head=git(worktree,'rev-parse','HEAD');
    h.call('skill-delegate',h.statePath,h.parent.invocationId,h.file('alternative-child.json',{children:[
      {key:'review',tier:'L3',instruction:'Run replacement authorReview',skillCapability:'authorReview',head},
    ]}));
    const child=h.call('next',h.statePath).jobs.find((j:{action:string})=>j.action==='skill-child');
    h.call('dispatch',h.statePath,child.id);
    const review=h.call('skill-start',h.statePath,child.id,h.file('alternative-call.json',{capability:'authorReview'}));
    const binding=JSON.parse(fs.readFileSync(h.statePath,'utf8')).v3.skillBindings.find((b:{capability:string})=>b.capability==='authorReview');
    assert.equal(binding.sourcePath,path.join(alternate,'SKILL.md'));
    assert.ok(binding.files.some((f:{relativePath:string})=>f.relativePath==='method.md'));
    h.finishSkill(review.invocationId);
    h.complete(child.id,'completed',{skillInvocationIds:[review.invocationId]});
    h.finishSkill(h.parent.invocationId);
    const handoff=h.call('skill-start',h.statePath,h.parentJob.id,h.file('alternative-handoff.json',{capability:'handoff'}));
    const handoffResult=h.finishSkill(handoff.invocationId);
    h.call('stage',h.statePath,h.parentJob.id,JSON.stringify({complete:true,status:'implemented',head,base:x.head,
      evidencePath:x.planEvidence,handoffPath:handoffResult.result.rawOutputPath,
      data:{skillInvocationIds:[h.parent.invocationId,handoff.invocationId]}}));
    const accepted=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    assert.equal(accepted.tickets[0].authorReview.bindingFingerprint,binding.fingerprint);
    assert.equal(accepted.tickets[0].evidence.self.head,head);
    assert.equal(accepted.jobs.filter((j:{action:string})=>['self-standards','self-spec'].includes(j.action)).length,0);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('diagnosing-bugs 路径在完成候选后补调一个 authorReview，跳过不能通过', () => {
  const x=fixture();
  try {
    const h=skillChildHarness(x,undefined,'diagnosis'),statePath=h.statePath;
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const worktree=state.tickets[0].worktree as string;
    fs.writeFileSync(path.join(worktree,'source.txt'),'diagnosed and fixed\n');
    git(worktree,'add','source.txt');git(worktree,'commit','-m','Diagnose #101');
    const head=git(worktree,'rev-parse','HEAD');
    h.finishSkill(h.parent.invocationId);
    const handoff=h.call('skill-start',statePath,h.parentJob.id,h.file('diagnosis-handoff.json',{capability:'handoff'}));
    const handoffResult=h.finishSkill(handoff.invocationId);
    h.call('stage',statePath,h.parentJob.id,JSON.stringify({complete:true,status:'implemented',head,base:x.head,
      evidencePath:x.planEvidence,handoffPath:handoffResult.result.rawOutputPath,
      data:{skillInvocationIds:[h.parent.invocationId,handoff.invocationId]}}));
    const offered=h.call('next',statePath).jobs;
    assert.equal(offered.filter((j:{action:string})=>j.action==='author-review').length,1);
    const reviewer=offered.find((j:{action:string})=>j.action==='author-review');
    h.call('dispatch',statePath,reviewer.id);
    const review=h.call('skill-start',statePath,reviewer.id,h.file('diagnosis-review.json',{capability:'authorReview'}));
    const skipped=h.call('skill-finish',statePath,review.invocationId,h.file('skipped-review.json',
      {status:'skipped',blocking:false}));
    assert.equal(skipped.status,'skipped');
    const rejected=x.call('submit',statePath,reviewer.id,h.file('skipped-outer-result.json',
      {model:'small',complete:true,status:'reviewed',head,base:x.head,
        evidencePath:x.planEvidence,data:{skillInvocationIds:[review.invocationId]}}));
    assert.notEqual(rejected.status,0);
    assert.match(rejected.stderr,/作者自检未完整通过/);
    const after=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(after.tickets[0].evidence.self,undefined);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('公开 CLI 以替代 prReview 执行 regular/fresh、归档原文并幂等发布两轮报告', () => {
  const x=fixture();
  try {
    const {statePath,binding}=approvedImplementation(x);
    const observer=path.join(x.temp,'bin','review-skill-observer');
    fs.writeFileSync(observer,`#!/usr/bin/env node
const fs=require('fs');const [op,id,job]=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));
if(op==='capabilities') console.log(JSON.stringify({source:'native_host',jobId:job,capability:id,
  capabilities:{sourceExecution:{allowed:true,acceptsOriginalFiles:true}}}));
else if(op==='result') {
  const invocation=state.v3.skillInvocations.find(i=>i.id===id);
  if(!invocation||invocation.jobId!==job)process.exit(2);
  const source=JSON.parse(fs.readFileSync(invocation.sourceArchivePath,'utf8'));
  console.log(JSON.stringify({source:'native_host',invocationId:id,jobId:job,nativeId:invocation.session.nativeId,
    observationId:invocation.session.observationId,mode:invocation.mode,
    bindingFingerprint:invocation.bindingFingerprint,terminal:true,
    loadedFiles:source.files.map(f=>({relativePath:f.relativePath,sha256:f.sha256}))}));
} else process.exit(2);
`);
    fs.chmodSync(observer,0o755);x.env.SPEC_DELIVERY_SKILL_OBSERVER=observer;
    const invoke=(...args:string[])=>{const r=x.call(...args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
    let state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    let t=state.tickets[0];
    t.phase='self';t.epoch++;t.pr=101;t.head=x.head;t.base=x.head;t.worktree=x.root;t.branch='main';
    state.validationOwner=t.key;
    fs.writeFileSync(statePath,JSON.stringify(state));
    const author=invoke('next',statePath).jobs.find((job:{action:string})=>job.action==='author-review');
    assert.ok(author);
    x.observe('pr-author',author.id,'small');
    fs.writeFileSync(binding,JSON.stringify({nativeId:'pr-author'}));
    invoke('bind',statePath,author.id,binding);
    const authorRequest=path.join(x.temp,'author-request.json');
    fs.writeFileSync(authorRequest,JSON.stringify({capability:'authorReview'}));
    const authorStarted=invoke('skill-start',statePath,author.id,authorRequest);
    const authorRaw=path.join(x.temp,'author-report.md');
    fs.writeFileSync(authorRaw,'Standards: pass\nSpec: pass\n');
    const authorOutcome=path.join(x.temp,'author-outcome.json');
    fs.writeFileSync(authorOutcome,JSON.stringify({status:'pass',blocking:false,
      rawOutputPath:authorRaw,evidencePaths:[authorRaw]}));
    const authorFinished=invoke('skill-finish',statePath,authorStarted.invocationId,authorOutcome);
    invoke('stage',statePath,author.id,JSON.stringify({complete:true,status:'reviewed',
      head:x.head,base:x.head,evidencePath:authorFinished.result.rawOutputPath,
      data:{skillInvocationIds:[authorStarted.invocationId]}}));
    state=JSON.parse(fs.readFileSync(statePath,'utf8'));t=state.tickets[0];
    assert.ok(t.authorReview,'作者自检应有真实绑定调用与来源证明');
    t.phase='review';t.epoch++;
    t.evidence.tests={head:x.head,base:x.head,path:x.planEvidence};
    fs.writeFileSync(statePath,JSON.stringify(state));
    const replacement=path.join(x.temp,'.agents','skills','code-review-from-claude','SKILL.md');
    fs.writeFileSync(replacement,'---\nname: alternate-pr-review\n---\n\nReview holistically, use verbal verdicts and original reports.\n');
    const migration=path.join(x.temp,'review-migration.md');fs.writeFileSync(migration,'Use an alternative pinned review method');
    const migrationRequest=path.join(x.temp,'review-migration.json');
    fs.writeFileSync(migrationRequest,JSON.stringify({expectedRevision:state.revision,evidencePath:migration,
      replacements:{prReview:replacement}}));
    const migrated=x.call('migrate-skills',statePath,migrationRequest);
    assert.equal(migrated.status,0,migrated.stderr);
    let regularSourceArchive='';
    for(const phase of ['review','fresh']) {
      const next=invoke('next',statePath);
      const j=next.jobs.find((job:{action:string})=>job.action==='pr-review');assert.ok(j);
      assert.equal(j.fresh,phase==='fresh');
      if(phase==='fresh')assert.equal(j.contextIntent.kind,'independent');
      const reviewPacket=JSON.parse(fs.readFileSync(j.packetPath,'utf8'));
      assert.ok(reviewPacket.sourceArchive?.manifestPath);
      assert.equal(reviewPacket.sourceArchive.cacheHit,true,'两轮复用作者阶段已固定的原始来源');
      if(phase==='review')regularSourceArchive=reviewPacket.sourceArchive.manifestPath;
      if(phase==='fresh') {
        assert.equal(reviewPacket.sourceArchive.manifestPath,regularSourceArchive);
        assert.equal(reviewPacket.rawSources.archivePath,reviewPacket.sourceArchive.manifestPath);
        assert.equal(reviewPacket.historyIndexPath,'');
        assert.deepEqual(reviewPacket.prior,[]);
        assert.equal(reviewPacket.handoffRef,null);
        assert.ok(reviewPacket.sourceArchive.files.every((file:{kind:string})=>
          ['spec','issue','diff','standard','history'].includes(file.kind)));
        const raw=reviewPacket.sourceArchive.files.map((file:{archivePath:string})=>
          fs.readFileSync(file.archivePath,'utf8')).join('\n');
        assert.ok(!raw.includes('review holistic report'));
        assert.ok(!JSON.stringify(reviewPacket).includes('Standards: pass'));
      }
      x.observe(`pr-${phase}`,j.id,'middle');
      fs.writeFileSync(binding,JSON.stringify({nativeId:`pr-${phase}`}));
      invoke('bind',statePath,j.id,binding);
      const request=path.join(x.temp,`request-${phase}.json`);fs.writeFileSync(request,JSON.stringify({capability:'prReview'}));
      const started=invoke('skill-start',statePath,j.id,request);
      assert.equal(started.mode,'source_execution');
      const source=JSON.parse(fs.readFileSync(started.sourceArchivePath,'utf8'));
      assert.equal(source.name,'alternate-pr-review');
      const raw=path.join(x.temp,`report-${phase}.md`);fs.writeFileSync(raw,`${phase} holistic report: no issues, no numeric score.\n`);
      const outcome=path.join(x.temp,`outcome-${phase}.json`);
      fs.writeFileSync(outcome,JSON.stringify({status:'pass',blocking:false,rawOutputPath:raw,evidencePaths:[raw]}));
      const finished=invoke('skill-finish',statePath,started.invocationId,outcome);
      assert.equal(finished.result.originalOutputPath,raw);
      invoke('stage',statePath,j.id,JSON.stringify({complete:true,status:'reviewed',
        evidencePath:finished.result.rawOutputPath,data:{skillInvocationIds:[started.invocationId]}}));
      const report=invoke('next',statePath).jobs.find((job:{action:string})=>job.action==='review-report');
      assert.ok(report);assert.equal(report.executor,'command');
      invoke('execute',statePath,report.id);
      const saved=JSON.parse(fs.readFileSync(statePath,'utf8'));
      assert.equal(saved.tickets[0].phase,phase==='review'?'fresh':'accept');
      assert.equal(saved.tickets[0].evidence[phase==='review'?'regular':'fresh'].skillInvocationId,started.invocationId);
    }
    const comments=JSON.parse(fs.readFileSync(path.join(x.temp,'comments.json'),'utf8')) as {body:string}[];
    assert.equal(comments.filter(c=>c.body.includes(':review:')).length,1);
    assert.equal(comments.filter(c=>c.body.includes(':fresh:')).length,1);
    assert.ok(comments.some(c=>c.body.includes('review holistic report: no issues')));
    assert.ok(comments.some(c=>c.body.includes('fresh holistic report: no issues')));
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('公开 CLI 对 regular 空发现与 fresh 阻断签发真实 L1 分歧裁决并保留原报告',()=>{
  const x=fixture();
  try {
    const {statePath,binding}=approvedImplementation(x);
    let state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    let t=state.tickets[0];
    t.phase='self';t.epoch++;t.pr=101;t.head=x.head;t.base=x.head;t.worktree=x.root;t.branch='main';
    state.validationOwner=t.key;fs.writeFileSync(statePath,JSON.stringify(state));
    const replacement=path.join(x.temp,'.agents','skills','code-review-from-claude','SKILL.md');
    fs.writeFileSync(replacement,'---\nname: alternate-pr-review\n---\n\nProfessional verbal verdict, no score or fixed lenses.\n');
    const observer=path.join(x.temp,'bin','review-skill-observer');
    fs.writeFileSync(observer,`#!/usr/bin/env node
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
`);
    fs.chmodSync(observer,0o755);x.env.SPEC_DELIVERY_SKILL_OBSERVER=observer;
    const invoke=(...args:string[])=>{const result=x.call(...args);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
    const author=invoke('next',statePath).jobs.find((job:{action:string})=>job.action==='author-review');
    assert.ok(author);
    x.observe('dispute-author',author.id,'small');
    fs.writeFileSync(binding,JSON.stringify({nativeId:'dispute-author'}));
    invoke('bind',statePath,author.id,binding);
    const authorRequest=path.join(x.temp,'dispute-author-request.json');
    fs.writeFileSync(authorRequest,JSON.stringify({capability:'authorReview'}));
    const authorStarted=invoke('skill-start',statePath,author.id,authorRequest);
    const authorRaw=path.join(x.temp,'dispute-author-report.md');
    fs.writeFileSync(authorRaw,'Standards: pass\nSpec: pass\n');
    const authorOutcome=path.join(x.temp,'dispute-author-outcome.json');
    fs.writeFileSync(authorOutcome,JSON.stringify({status:'pass',blocking:false,
      rawOutputPath:authorRaw,evidencePaths:[authorRaw]}));
    const authorFinished=invoke('skill-finish',statePath,authorStarted.invocationId,authorOutcome);
    invoke('stage',statePath,author.id,JSON.stringify({complete:true,status:'reviewed',head:x.head,base:x.head,
      evidencePath:authorFinished.result.rawOutputPath,data:{skillInvocationIds:[authorStarted.invocationId]}}));
    state=JSON.parse(fs.readFileSync(statePath,'utf8'));t=state.tickets[0];
    assert.ok(t.authorReview);
    t.phase='review';t.epoch++;t.evidence.tests={head:x.head,base:x.head,path:x.planEvidence};
    fs.writeFileSync(statePath,JSON.stringify(state));
    const migration=path.join(x.temp,'review-migration.md');fs.writeFileSync(migration,'Bind a pinned alternative review method');
    const request=path.join(x.temp,'review-migration.json');
    fs.writeFileSync(request,JSON.stringify({expectedRevision:state.revision,evidencePath:migration,replacements:{prReview:replacement}}));
    const migrated=x.call('migrate-skills',statePath,request);assert.equal(migrated.status,0,migrated.stderr);
    for(const phase of ['review','fresh'] as const) {
      const j=invoke('next',statePath).jobs.find((job:{action:string})=>job.action==='pr-review');assert.ok(j);
      x.observe(`dispute-${phase}`,j.id,'middle');
      fs.writeFileSync(binding,JSON.stringify({nativeId:`dispute-${phase}`}));invoke('bind',statePath,j.id,binding);
      const skillRequest=path.join(x.temp,`skill-request-${phase}.json`);
      fs.writeFileSync(skillRequest,JSON.stringify({capability:'prReview'}));
      const started=invoke('skill-start',statePath,j.id,skillRequest);
      const raw=path.join(x.temp,`dispute-report-${phase}.md`);
      fs.writeFileSync(raw,phase==='review'?'No findings; an observation was filtered.\n':'Retained blocking finding.\n');
      const outcome=path.join(x.temp,`dispute-outcome-${phase}.json`);
      fs.writeFileSync(outcome,JSON.stringify({status:phase==='review'?'pass':'changes_required',
        blocking:phase==='fresh',rawOutputPath:raw,evidencePaths:[raw]}));
      const finished=invoke('skill-finish',statePath,started.invocationId,outcome);
      invoke('stage',statePath,j.id,JSON.stringify({complete:true,status:'reviewed',
        evidencePath:finished.result.rawOutputPath,data:{skillInvocationIds:[started.invocationId]}}));
      const report=invoke('next',statePath).jobs.find((job:{action:string})=>job.action==='review-report');
      assert.ok(report);invoke('execute',statePath,report.id);
    }
    const before=JSON.parse(fs.readFileSync(statePath,'utf8'));
    assert.equal(before.tickets[0].phase,'fresh');
    assert.equal(before.v3.reviewDisagreements.length,1);
    const disagreement=before.v3.reviewDisagreements[0];
    const next=invoke('next',statePath);
    const adjudication=next.jobs.find((job:{action:string})=>job.action==='adjudicate');assert.ok(adjudication);
    assert.equal(adjudication.tier,'L1');assert.equal(adjudication.contextIntent.kind,'independent');
    const p=JSON.parse(fs.readFileSync(adjudication.packetPath,'utf8'));
    assert.equal(p.reviewDisagreement.regular.blocking,false);
    assert.equal(p.reviewDisagreement.fresh.blocking,true);
    assert.ok(fs.readFileSync(p.reviewDisagreement.regular.reportPath,'utf8').includes('No findings'));
    assert.ok(fs.readFileSync(p.reviewDisagreement.fresh.reportPath,'utf8').includes('Retained'));
    assert.ok(p.reviewDisagreement.regular.evidence.length>0);
    assert.ok(p.reviewDisagreement.fresh.evidence.length>0);
    x.observe('l1-review-adjudication',adjudication.id,'large');
    fs.writeFileSync(binding,JSON.stringify({nativeId:'l1-review-adjudication'}));
    invoke('bind',statePath,adjudication.id,binding);
    const data={disagreementId:disagreement.id,regularInvocationId:disagreement.regularInvocationId,
      freshInvocationId:disagreement.freshInvocationId,skillFingerprint:disagreement.skillFingerprint,
      blocking:false,rationale:'Fresh finding concerns behavior outside this PR; source reports were compared.',
      skillRuleRefs:['SKILL.md#review-method']};
    const decisionPath=path.join(x.temp,'adjudication.json');
    fs.writeFileSync(decisionPath,JSON.stringify({...data,head:x.head,base:x.head,candidateVersion:disagreement.candidateVersion}));
    invoke('stage',statePath,adjudication.id,JSON.stringify({complete:true,status:'resolved',head:x.head,base:x.head,
      evidencePath:decisionPath,data}));
    const after=JSON.parse(fs.readFileSync(statePath,'utf8')) as core.State;
    assert.equal(after.tickets[0].phase,'accept');
    assert.equal(after.tickets[0].evidence.fresh?.adjudicationId,adjudication.id);
    assert.equal(after.v3?.decisionRecords.at(-1)?.kind,'adjudication');
    assert.equal(after.v3?.decisionRecords.at(-1)?.session.nativeId,'l1-review-adjudication');
    assert.equal(core.mergeGate(after,after.tickets[0]),false,'裁决没有代替 L2 验收和 CI');
    assert.equal(after.tickets[0].evidence.accept,undefined);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('离线 metrics 保留两种 provider 原文和未知费用，重复观测不重计并可同口径比较', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    host.set(db=>{db.provider='openai';});
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'running');
    const token=JSON.parse(fs.readFileSync(statePath,'utf8')).v3.dispatchRecords[0].token;
    const checks=path.join(x.temp,'metrics-checks.md');fs.writeFileSync(checks,'checked\n');
    const openaiUsage={input_tokens:100,output_tokens:40,total_tokens:140,
      input_tokens_details:{cached_tokens:25},output_tokens_details:{reasoning_tokens:15}};
    host.set(db=>{db.actors[token].state='completed';db.actors[token].completedAt='2026-09-27T00:00:02.000Z';
      db.actors[token].usage=openaiUsage;db.actors[token].provider='openai';
      db.actors[token].result={complete:true,status:'planned',evidencePath:x.planEvidence,
        data:{planPath:x.planPath,checksPath:checks}};});
    assert.equal(x.call('collect',statePath,planning.id).status,0);
    const orphanProof=path.join(x.temp,'orphan-host.json');
    fs.writeFileSync(orphanProof,JSON.stringify({source:'native_host',nativeId:'orphan-anon',targetHost:'test'}));
    const anthropicUsage={input_tokens:30,output_tokens:10,cache_read_input_tokens:20,
      cache_creation_input_tokens:5,cost_usd:0.02};
    const record=path.join(x.temp,'orphan-usage.json');
    fs.writeFileSync(record,JSON.stringify([
      {nativeId:'orphan-anon',targetHost:'test',evidencePath:orphanProof,provider:'anthropic',
        state:'cancelled',usage:anthropicUsage},
      {nativeId:'orphan-anon',targetHost:'test',evidencePath:orphanProof,provider:'anthropic',
        state:'cancelled',usage:anthropicUsage,usageScope:'model_call',modelCallId:'call-A'},
    ]));
    assert.equal(x.call('record-host',statePath,record).status,0);
    assert.equal(x.call('record-host',statePath,record).status,0);
    const stateBytes=fs.readFileSync(statePath),ghBytes=fs.readFileSync(x.ghLog);
    x.env.SPEC_DELIVERY_HOST_ADAPTER='/nonexistent/adapter';
    const measured=x.call('metrics',statePath);assert.equal(measured.status,0,measured.stderr);
    assert.deepEqual(fs.readFileSync(statePath),stateBytes);
    assert.deepEqual(fs.readFileSync(x.ghLog),ghBytes);
    const m=JSON.parse(measured.stdout).reconciliation;
    assert.equal(m.scope.observedNativeInstanceCount,2);
    assert.equal(m.scope.verifiedNativeSessionCount,1);
    assert.equal(m.scope.observedModelCallCount,1);
    assert.equal(m.scope.totalModelCallCount,null);
    assert.equal(m.scope.coversMainSessionUsage,false);
    assert.equal(m.scope.commandJobCount,0);
    const original=m.instances.find((i:{nativeId:string})=>i.nativeId==='host-actor-'+token);
    const orphan=m.instances.find((i:{nativeId:string})=>i.nativeId==='orphan-anon');
    assert.equal(original.provider,'openai');
    assert.equal(original.selectedUsage[0].normalized.inputTokens.value,100);
    assert.equal(original.selectedUsage[0].normalized.cachedReadTokens.value,25);
    assert.equal(original.selectedUsage[0].normalized.reasoningTokens.value,15);
    assert.equal(original.selectedUsage[0].normalized.totalTokens.value,140);
    assert.equal(original.selectedUsage[0].normalized.explicitCost.value,null);
    assert.equal(original.timing.executionMs,2000);
    assert.equal(orphan.usageObservations.length,2);
    assert.equal(orphan.usageBasis,'latest_session_snapshot');
    assert.deepEqual(orphan.unexplainedReasons.includes('no_final_job_binding'),true);
    assert.equal(orphan.selectedUsage[0].normalized.cachedReadTokens.value,20);
    assert.equal(orphan.selectedUsage[0].normalized.totalTokens.value,null);
    assert.equal(orphan.selectedUsage[0].normalized.modelMs.value,null);
    assert.equal(m.explicitCostByCurrency.find((c:{provider:string})=>c.provider==='anthropic').amount,0.02);
    assert.equal(m.rawFieldTotals.find((f:{provider:string;path:string})=>
      f.provider==='openai'&&f.path==='input_tokens').sum,100);
    assert.equal(m.rawFieldTotals.find((f:{provider:string;path:string})=>
      f.provider==='anthropic'&&f.path==='input_tokens').sum,30);
    assert.ok(!m.rawFieldTotals.some((f:{path:string})=>f.path==='cost_usd'));
    assert.ok(m.instancesMissingExplicitCost.includes(original.key));
    const file=orphan.usageObservations[0].sourcePath;
    assert.deepEqual(fs.readFileSync(file),fs.readFileSync(record));
    const before=path.join(x.temp,'before-metrics.json');fs.writeFileSync(before,stateBytes);
    const after=JSON.parse(stateBytes.toString());after.v3.detachedInstances=[];
    const afterPath=path.join(x.temp,'after-metrics.json');fs.writeFileSync(afterPath,JSON.stringify(after));
    const comparison=x.call('metrics-compare',before,afterPath);
    assert.equal(comparison.status,0,comparison.stderr);
    const compared=JSON.parse(comparison.stdout);
    assert.equal(compared.delta.observedNativeInstanceCount,-1);
    assert.equal(compared.sameRun,true);
    assert.equal(compared.sameTicketSet,true);
    assert.equal(compared.beforeMeasures.explicitCostByCurrency[0].amount,0.02);
    assert.deepEqual(compared.afterMeasures.explicitCostByCurrency,[]);
    assert.deepEqual(fs.readFileSync(statePath),stateBytes);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('纠错前后的两个原生实例与取消用量都出现在同一离线对账中', () => {
  const x=fixture();
  try {
    const {statePath,planning}=planned(x),host=controlledHost(x);
    assert.equal(JSON.parse(x.call('dispatch',statePath,planning.id).stdout).status,'running');
    const first=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const dispatch=first.v3.dispatchRecords[0],oldNative='host-actor-'+dispatch.token;
    x.observe('corrected-actor',planning.id,'large');
    host.set(db=>{db.actors[dispatch.token].nativeId='corrected-actor';});
    assert.equal(JSON.parse(x.call('collect',statePath,planning.id).stdout).polled[0].status,'uncertain');
    const decision=recoveryDecision(statePath,planning.id,'correct-binding',x.planEvidence,
      {expectedNativeId:oldNative,nativeId:'corrected-actor',processTreeStopped:true});
    assert.equal(x.call('recover-result',statePath,recoveryFile(x,decision)).status,0);
    const oldEvent=dispatch.instances.find((i:{nativeId:string})=>i.nativeId===oldNative).events.at(-1).evidencePath;
    const usageFile=path.join(x.temp,'cancelled-usage.json');
    fs.writeFileSync(usageFile,JSON.stringify([{jobId:planning.id,nativeId:oldNative,
      dispatchToken:dispatch.token,evidencePath:oldEvent,state:'cancelled',
      usage:{prompt_tokens:75,completion_tokens:20,total_tokens:95,prompt_cache_hit_tokens:30}}]));
    assert.equal(x.call('record-host',statePath,usageFile).status,0);
    const metrics=x.call('metrics',statePath);assert.equal(metrics.status,0,metrics.stderr);
    const m=JSON.parse(metrics.stdout).reconciliation;
    assert.equal(m.scope.observedNativeInstanceCount,2);
    const old=m.instances.find((i:{nativeId:string})=>i.nativeId===oldNative);
    const current=m.instances.find((i:{nativeId:string})=>i.nativeId==='corrected-actor');
    assert.equal(old.status,'cancelled');assert.deepEqual(old.boundJobIds,[]);
    assert.ok(old.unexplainedReasons.includes('no_final_job_binding'));
    assert.equal(old.selectedUsage[0].normalized.cachedReadTokens.value,30);
    assert.deepEqual(current.boundJobIds,[planning.id]);
    assert.equal(m.scope.dispatchAttemptCount,1);
    assert.equal(m.scope.observedModelCallCount,0);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('技能子任务的实际 usage、外部等待和未知时间边界分开统计', () => {
  const x=fixture();
  try {
    const h=skillChildHarness(x),request=h.file('metrics-child.json',{children:[
      {key:'analysis',tier:'L3',instruction:'Independent analysis'}]});
    h.call('skill-delegate',h.statePath,h.parent.invocationId,request);
    const child=h.call('next',h.statePath).jobs.find((j:{action:string})=>j.action==='skill-child');
    assert.ok(child);
    h.call('dispatch',h.statePath,child.id);
    const d=JSON.parse(fs.readFileSync(h.statePath,'utf8')).v3.dispatchRecords.find((r:{jobId:string})=>r.jobId===child.id);
    h.host.set(db=>{db.actors[d.token].usage={prompt_tokens:22,completion_tokens:8,
      completion_tokens_details:{reasoning_tokens:3}};db.actors[d.token].provider='child-provider';});
    h.complete(child.id);
    const proof=path.join(x.temp,'external-wait.md');fs.writeFileSync(proof,'Waiting on external CI\n');
    const current=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    const start=h.file('wait-start.json',{expectedRevision:current.revision,id:'ci-wait-1',kind:'external',
      scope:'101',startedAt:'2026-09-27T01:00:00.000Z',evidencePath:proof,reason:'CI pending'});
    h.call('record-wait',h.statePath,start);
    const open=h.call('metrics',h.statePath).reconciliation.durationSummary;
    assert.equal(open.externalWaitMs.sumKnownMs,null);
    const afterStart=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    h.call('record-wait',h.statePath,h.file('wait-close.json',{expectedRevision:afterStart.revision,
      id:'ci-wait-1',kind:'external',scope:'101',startedAt:'2026-09-27T01:00:00.000Z',
      endedAt:'2026-09-27T01:01:00.000Z',evidencePath:proof,reason:'CI passed'}));
    const afterClose=JSON.parse(fs.readFileSync(h.statePath,'utf8'));
    h.call('record-wait',h.statePath,h.file('recovery-wait.json',{expectedRevision:afterClose.revision,
      id:'repair-1',kind:'recovery',scope:child.id,startedAt:'2026-09-27T01:02:00.000Z',
      endedAt:'2026-09-27T01:03:30.000Z',evidencePath:proof,reason:'receipt repair'}));
    const report=h.call('metrics',h.statePath).reconciliation;
    assert.equal(report.scope.skillChildRequestCount,1);
    assert.equal(report.durationSummary.externalWaitMs.sumKnownMs,60000);
    assert.equal(report.durationSummary.recoveryWaitMs.sumKnownMs,90000);
    assert.equal(report.durationSummary.runWallMs,null);
    const native=JSON.parse(fs.readFileSync(h.statePath,'utf8')).jobs.find((j:{id:string})=>j.id===child.id).nativeId;
    const instance=report.instances.find((i:{nativeId:string})=>i.nativeId===native);
    assert.equal(instance.selectedUsage[0].normalized.inputTokens.value,22);
    assert.equal(instance.selectedUsage[0].normalized.reasoningTokens.value,3);
    assert.equal(instance.timing.launchMs,null,'宿主没有真实启动边界时不能用绑定时间代替');
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});

test('公开 CLI 复用固定候选原始来源，来源与候选变化失效且损坏缓存明确失败', () => {
  const x=fixture(true);
  try {
    const {statePath}=approvedImplementation(x);
    const actualGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
    const reads=path.join(x.temp,'source-git-reads.log');
    const wrapper=path.join(x.temp,'bin','git');
    fs.writeFileSync(wrapper,`#!/usr/bin/env node
const fs=require('fs'),{spawnSync}=require('child_process'),args=process.argv.slice(2);
if(args[0]==='diff'||args[0]==='log'||args[0]==='ls-tree'||args[0]==='show')
  fs.appendFileSync(${JSON.stringify(reads)},JSON.stringify(args)+'\\n');
const child=spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});
process.exit(child.status===null?1:child.status);
`);
    fs.chmodSync(wrapper,0o755);
    const sourceReads=()=>fs.existsSync(reads)?fs.readFileSync(reads,'utf8').trim().split('\n').filter(Boolean)
      .map(line=>JSON.parse(line) as string[]):[];
    const issue=()=>{const r=x.call('next',statePath);assert.equal(r.status,0,r.stderr);
      const job=JSON.parse(r.stdout).jobs.find((j:{action:string})=>j.action==='implement');assert.ok(job);
      return {job,packet:JSON.parse(fs.readFileSync(job.packetPath,'utf8'))};};
    const first=issue();
    assert.equal(first.packet.sourceArchive.cacheHit,false);
    assert.deepEqual(first.packet.sourceArchive.files.map((f:{kind:string})=>f.kind).slice(0,4),
      ['spec','issue','diff','history']);
    const standard=first.packet.sourceArchive.files.find((f:{kind:string})=>f.kind==='standard');
    assert.ok(standard);
    assert.match(fs.readFileSync(standard.archivePath,'utf8'),/Fixture standard/);
    const initialReads=sourceReads();
    const materialized=initialReads.filter(args=>args[0]!=='diff'||
      args.includes(first.job.head)&&args.includes(first.job.base));
    assert.equal(materialized.length,5,'首次读取：两次候选 diff、一次 log、一次 ls-tree、一次规范 show');
    const liveReads=()=>fs.readFileSync(x.ghLog,'utf8').trim().split('\n').filter(Boolean)
      .map(line=>JSON.parse(line) as string[]).filter(args=>args.includes('graphql')).length;
    const initialLiveReads=liveReads();
    assert.ok(initialReads.some(args=>args[0]==='diff'&&args.includes('--binary')));
    assert.ok(initialReads.some(args=>args[0]==='log'));
    assert.ok(initialReads.some(args=>args[0]==='show'));
    const second=issue();
    assert.equal(second.job.id,first.job.id);
    assert.equal(second.packet.sourceArchive.cacheHit,true);
    assert.equal(second.packet.sourceArchive.manifestPath,first.packet.sourceArchive.manifestPath);
    assert.deepEqual(sourceReads(),initialReads,'命中后不重读 diff、标准或候选历史');
    assert.ok(liveReads()>initialLiveReads,'缓存命中仍实时读取目标与 issue/PR 状态');
    const archive=second.packet.sourceArchive;
    const diff=archive.files.find((f:{kind:string})=>f.kind==='diff');assert.ok(diff);
    const original=fs.readFileSync(diff.archivePath);
    fs.rmSync(diff.archivePath);
    const stateBefore=fs.readFileSync(statePath);
    const broken=x.call('next',statePath);
    assert.notEqual(broken.status,0);
    assert.match(broken.stderr,/原始来源缓存文件缺失/);
    assert.deepEqual(fs.readFileSync(statePath),stateBefore);
    fs.writeFileSync(diff.archivePath,original,{flag:'wx'});
    const oldIssue=fs.readFileSync(x.issueSource);
    fs.rmSync(x.issueSource);
    const unreadable=x.call('next',statePath);
    assert.notEqual(unreadable.status,0);
    assert.match(unreadable.stderr,/GitHub observation:/);
    assert.deepEqual(fs.readFileSync(statePath),stateBefore);
    fs.writeFileSync(x.issueSource,oldIssue);
    fs.writeFileSync(x.issueSource,'   ');
    const empty=x.call('next',statePath);
    assert.notEqual(empty.status,0);
    assert.match(empty.stderr,/正文缺失/);
    assert.deepEqual(fs.readFileSync(statePath),stateBefore);
    fs.writeFileSync(x.issueSource,'Updated spec source\n');
    const changedSource=issue();
    assert.equal(changedSource.packet.sourceArchive.cacheHit,false);
    assert.notEqual(changedSource.packet.sourceArchive.manifestPath,archive.manifestPath);
    assert.ok(fs.existsSync(archive.manifestPath),'旧来源归档保留供审计');
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
    const ticket=state.tickets[0],job=state.jobs.find((j:{id:string})=>j.id===first.job.id);
    fs.writeFileSync(path.join(ticket.worktree,'source.txt'),'changed candidate\n');
    git(ticket.worktree,'add','source.txt');git(ticket.worktree,'commit','-m','new candidate');
    const newHead=git(ticket.worktree,'rev-parse','HEAD');
    ticket.head=newHead;job.head=newHead;job.candidateVersion=core.candidateVersion(state,ticket);
    fs.writeFileSync(statePath,JSON.stringify(state));
    const changedCandidate=(()=>{const previousPath=process.env.PATH;
      try {process.env.PATH=x.env.PATH;return rawSourcesForJob(state,ticket,job,statePath);}
      finally {process.env.PATH=previousPath;}})();
    assert.notEqual(changedCandidate.manifestPath,changedSource.packet.sourceArchive.manifestPath);
    assert.equal(changedCandidate.candidate.head,newHead);
    const changedDiff=changedCandidate.files.find(f=>f.kind==='diff');assert.ok(changedDiff);
    assert.match(fs.readFileSync(changedDiff.archivePath,'utf8'),/changed candidate/);
    const stalePlan=x.call('next',statePath);
    assert.notEqual(stalePlan.status,0,'手工替换候选不能绕过原计划门禁');
    assert.match(stalePlan.stderr,/plan-check 决策产物已过期/);
  } finally {fs.rmSync(x.temp,{recursive:true,force:true});}
});
