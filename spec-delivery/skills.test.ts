import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as core from './core.ts';
import * as skills from './skills.ts';
import { main, packet } from '../spec-delivery.workflow.ts';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const original = {
  implement: path.join(os.homedir(), '.agents', 'skills', 'implement', 'SKILL.md'),
  handoff: path.join(os.homedir(), '.agents', 'skills', 'handoff', 'SKILL.md'),
};
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-skill-'));
  const statePath = path.join(root, 'run', 'state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const skillRoot = path.join(root, '.agents', 'skills');
  const names = ['implement', 'diagnosing-bugs', 'code-review', 'code-review-from-claude', 'handoff'];
  for (const name of names) {
    const directory = path.join(skillRoot, name); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'),
      `---\nname: ${name}\n${name === 'implement' || name === 'handoff' ? 'disable-model-invocation: true\n' : ''}---\n\nExecute the bound ${name} workflow.\n`);
  }
  const fixture = { implement: path.join(skillRoot, 'implement', 'SKILL.md'),
    handoff: path.join(skillRoot, 'handoff', 'SKILL.md') };
  const v3 = core.initialProtocolV3(); v3.skillBindings = skills.defaultSkillBindings(skillRoot);
  const s: core.State = { schema: 1, protocol: 3, v3, id: 'skill-test', revision: 0,
    inputs: { spec: 100, targetBranch: 'main', models: { L1: 'large', L2: 'middle', L3: 'small' } },
    spec: 100, repo: { root, slug: 'example/test', host: 'github.com', defaultBranch: 'main' }, status: 'running',
    policy: { agents: 4, issues: 2, tests: 1, noProgress: 3, rounds: 3 }, specCriteria: [], planEvidence: '',
    tickets: [], jobs: [], facts: { base: 'base', issueStates: {}, prs: {}, at: '' }, auditEpoch: 1, events: [] };
  const t = core.buildTicket({ number: 101, kind: 'software', dependencies: [], criteria: ['done'], visual: false }, 'base');
  t.phase = 'implement'; t.head = 'head'; t.base = 'base'; t.worktree = path.join(root, 'worktree'); s.tickets.push(t);
  const sessionPath = path.join(root, 'session.json');
  const observation = JSON.stringify({source:'native_host',nativeId:'host/actor',provider:'fixture',model:'small'});
  fs.writeFileSync(sessionPath, observation);
  const session: core.NativeSession = { source: 'native_host', observationId: 'observed-actor', jobId: 'job-1',
    nativeId: 'host/actor', provider: 'fixture', model: 'small', observedAt: new Date().toISOString(),
    evidencePath: sessionPath, evidenceDigest: sha(observation) };
  const j: core.Job = { id: 'job-1', ticket: t.key, epoch: t.epoch, action: 'implement', part: '', tier: 'L3',
    model: 'small', executor: 'agent', fresh: false, contextKey: 'author', head: t.head, base: t.base,
    tests: 0, status: 'running', nativeId: session.nativeId, session, inputVersion: core.inputVersion(s),
    candidateVersion: core.candidateVersion(s, t) };
  s.jobs.push(j);
  fs.writeFileSync(statePath, JSON.stringify(s));
  const output = (call: skills.PreparedSkillCall, status: core.SkillStatus, blocking: boolean, raw = 'Actual skill output') => {
    const directory = path.join(root, 'outputs', sha(call.invocation.id).slice(0, 12));
    fs.mkdirSync(directory, { recursive: true });
    const rawOutputPath = path.join(directory, 'raw.md'); fs.writeFileSync(rawOutputPath, raw);
    const hostReceiptPath = path.join(directory, 'host.json');
    fs.writeFileSync(hostReceiptPath, JSON.stringify({ source: 'native_host', invocationId: call.invocation.id,
      jobId: j.id, nativeId: j.nativeId, observationId: j.session!.observationId,
      mode: call.invocation.mode, nativeEntry: call.nativeEntry,
      loadedFiles: call.invocation.mode === 'source_execution'
        ? call.source.files.map(f => ({relativePath:f.relativePath,sha256:f.sha256})) : undefined,
      bindingFingerprint: call.invocation.bindingFingerprint, terminal: true }));
    return { status, blocking, rawOutputPath, evidencePaths: [rawOutputPath], hostReceiptPath } satisfies skills.SkillOutcome;
  };
  return { root, skillRoot, fixture, statePath, s, t, j, output,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('绑定的 implement/handoff 以真实 source/native 路径调用，字节保持相同并保留原文来源', async () => {
  const x = setup();
  const before = Object.fromEntries(Object.entries(x.fixture).map(([name, file]) => [name, sha(fs.readFileSync(file))]));
  try {
    let nativeCalls = 0, sourceCalls = 0;
    const nativeBinding = skills.bindingFor(x.s, 'implementation');
    const nativeHost: skills.SkillHostAdapter = {
      async capabilities() { return { nativeExplicit: { supported: true, registrations: [
        { entry: 'Skill:implement', sourcePath: nativeBinding.sourcePath, fingerprint: nativeBinding.fingerprint } ] } }; },
      async invokeNative(call) { nativeCalls++; assert.equal(call.invocation.mode, 'native_explicit');
        assert.match(Buffer.from(call.source.files.find(f => f.relativePath === 'SKILL.md')!.dataBase64, 'base64').toString(),
          /disable-model-invocation: true/); return x.output(call, 'pass', false); },
    };
    const persist = (state: core.State) => fs.writeFileSync(x.statePath, JSON.stringify(state));
    const implementation = await skills.invokeBoundSkill(x.s, x.j, 'implementation', nativeHost, x.statePath, persist);
    assert.equal(nativeCalls, 1);
    const sourceHost: skills.SkillHostAdapter = {
      async capabilities() { return { nativeExplicit: { supported: true, registrations: [] },
        sourceExecution: { allowed: true, acceptsOriginalFiles: true } }; },
      async executeSource(call) { sourceCalls++; assert.equal(call.invocation.mode, 'source_execution');
        const source = call.source.files.find(f => f.relativePath === 'SKILL.md')!;
        assert.equal(Buffer.from(source.dataBase64, 'base64').equals(fs.readFileSync(x.fixture.handoff)), true);
        return x.output(call, 'pass', false, 'Original handoff document\n\nsuggested skills: code-review\n'); },
    };
    const handoff = await skills.invokeBoundSkill(x.s, x.j, 'handoff', sourceHost, x.statePath, persist);
    assert.equal(sourceCalls, 1);
    const archive = path.join(x.root, 'run', 'handoff-archived.md');
    fs.copyFileSync(handoff.result.rawOutputPath, archive);
    for (const result of [implementation.result, handoff.result]) {
      fs.unlinkSync(result.originalOutputPath!);
      fs.unlinkSync(result.originalHostReceiptPath);
    }
    skills.verifySkillResultFiles(x.s, x.j, [implementation.invocation.id, handoff.invocation.id], archive);
    const evidencePath = path.join(x.root, 'evidence.md'); fs.writeFileSync(evidencePath, 'implemented candidate');
    const r: core.Result = { model: 'small', complete: true, status: 'implemented', head: 'new-head', base: 'base',
      evidencePath, handoffPath: archive,
      data: { skillInvocationIds: [implementation.invocation.id, handoff.invocation.id] } };
    assert.throws(() => core.submit(x.s, x.j.id, r), /内嵌 code-review/);
    assert.deepEqual(Object.fromEntries(Object.entries(x.fixture).map(([name, file]) => [name, sha(fs.readFileSync(file))])), before);
  } finally { x.cleanup(); }
});

test('作者审查的阻断结论返回实现，不能形成候选通过证据', async () => {
  const x=setup();
  try {
    x.j.action='author-review';x.t.phase='self';
    const host:skills.SkillHostAdapter={
      async capabilities(){return {sourceExecution:{allowed:true,acceptsOriginalFiles:true}};},
      async executeSource(call){return x.output(call,'changes_required',true,'Review found a blocking defect');},
    };
    const review=await skills.invokeBoundSkill(x.s,x.j,'authorReview',host,x.statePath,
      state=>fs.writeFileSync(x.statePath,JSON.stringify(state)));
    const evidencePath=path.join(x.root,'review.md');fs.writeFileSync(evidencePath,'Review requires changes');
    core.submit(x.s,x.j.id,{model:x.j.model,complete:true,status:'reviewed',head:x.j.head,base:x.j.base,
      evidencePath,data:{skillInvocationIds:[review.invocation.id],reason:'Fix defect'}});
    assert.equal(x.t.phase,'implement');
    assert.equal(x.t.authorReview,undefined);
    assert.equal(x.t.evidence.self,undefined);
  } finally {x.cleanup();}
});

test('已安装的原始 implement/handoff 保持原文与 frontmatter',
  { skip: !Object.values(original).every(file => fs.existsSync(file)) }, () => {
    const before = Object.fromEntries(Object.entries(original).map(([name, file]) => [name, sha(fs.readFileSync(file))]));
    const implementation = skills.resolveSkill('implementation', original.implement);
    const handoff = skills.resolveSkill('handoff', original.handoff);
    assert.match(fs.readFileSync(implementation.sourcePath, 'utf8'), /disable-model-invocation: true/);
    assert.match(fs.readFileSync(handoff.sourcePath, 'utf8'), /^---\r?\n/);
    assert.deepEqual(Object.fromEntries(Object.entries(original).map(([name, file]) => [name, sha(fs.readFileSync(file))])), before);
  });

test('缺少正式技能来源时明确指出缺失绑定', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-skill-missing-'));
  try {
    assert.throws(() => skills.defaultSkillBindings(root), /implementation 技能来源不可读取/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('能力不足、原生版本不匹配、空白产物与四类结论均有明确门禁', () => {
  const x = setup();
  try {
    assert.throws(() => skills.prepareSkillCall(x.s, x.j, 'implementation', { nativeExplicit: {supported:true,
      registrations:[{entry:'Skill:implement',sourcePath:x.fixture.implement,fingerprint:'wrong'}]} }, x.statePath), /宿主没有已注册/);
    const prepare = () => skills.prepareSkillCall(x.s, x.j, 'implementation',
      { sourceExecution: {allowed:true,acceptsOriginalFiles:true} }, x.statePath);
    const call = prepare();
    assert.equal(prepare().alreadyStarted, true, '重复准备不能暗中重启技能');
    const blank = x.output(call, 'pass', false, '  \n');
    assert.throws(() => skills.finishSkillCall(x.s, call.invocation.id, blank), /产物为空/);
    const incomplete = { ...x.output(call, 'incomplete', true), rawOutputPath: undefined, evidencePaths: [] };
    assert.equal(skills.finishSkillCall(x.s, call.invocation.id, incomplete).status, 'incomplete');
    const evidencePath = path.join(x.root, 'evidence.md'); fs.writeFileSync(evidencePath, 'attempted');
    assert.throws(() => core.submit(x.s, x.j.id, {model:'small',complete:true,status:'implemented',head:'new',base:'base',
      evidencePath,handoffPath:evidencePath,data:{skillInvocationIds:[call.invocation.id]}}), /未完成或跳过/);
    for (const [status, blocking] of [['changes_required',true],['skipped',true]] as const) {
      const extra = skills.prepareSkillCall(x.s, x.j, 'diagnosis',
        { sourceExecution: { allowed:true, acceptsOriginalFiles:true } }, x.statePath);
      const out = x.output(extra, status, blocking);
      assert.equal(skills.finishSkillCall(x.s, extra.invocation.id, out).status, status);
      // Different statuses are preserved in the original invocation record; neither is silently turned into pass.
      assert.equal(x.s.v3!.skillInvocations.at(-1)!.result!.status, status);
    }
  } finally { x.cleanup(); }
});

test('替代技能与依赖漂移须显式迁移，相关审查证据被撤销', () => {
  const x = setup();
  try {
    const dir = path.join(x.root, 'alternate'); fs.mkdirSync(dir);
    const source = path.join(dir, 'SKILL.md'); const resource = path.join(dir, 'method.md');
    fs.writeFileSync(source, '---\nname: alternate-review\n---\n\nRead [method](method.md), then review.\n');
    fs.writeFileSync(resource, 'method v1');
    x.t.phase = 'review'; x.t.evidence.regular = {head:x.t.head,base:x.t.base,path:'old'};
    x.j.status = 'cancelled';
    const proof = path.join(x.root, 'migration.md'); fs.writeFileSync(proof, 'Explicit maintenance migration');
    const changed = skills.migrateSkillBindings(x.s, {prReview:source}, proof);
    assert.deepEqual(changed, ['prReview']); assert.equal(x.t.phase, 'review');
    assert.equal(x.t.evidence.regular, undefined);
    const binding = skills.bindingFor(x.s, 'prReview');
    assert.equal(binding.name, 'alternate-review');
    fs.writeFileSync(resource, 'method v2');
    assert.throws(() => skills.verifySkillBinding(binding), /版本漂移/);
    const further = skills.migrateSkillBindings(x.s, {}, proof);
    assert.deepEqual(further, ['prReview']);
    assert.notEqual(skills.bindingFor(x.s, 'prReview').fingerprint, binding.fingerprint);
  } finally { x.cleanup(); }
});

test('公开 CLI skill-start/skill-finish 留下来源、实际模式及原始产物', async () => {
  const x = setup();
  const previousObserver=process.env.SPEC_DELIVERY_SKILL_OBSERVER;
  try {
    const requestPath = path.join(x.root, 'host-capabilities.json');
    fs.writeFileSync(requestPath, JSON.stringify({capability:'implementation'}));
    const outcomePath = path.join(x.root,'outcome.json');
    const observer = path.join(x.root,'skill-observer');
    fs.writeFileSync(observer,`#!/usr/bin/env node\nconst fs=require('fs');const [op,id,job]=process.argv.slice(2);\nif(op==='capabilities')console.log(JSON.stringify({source:'native_host',jobId:job,capability:id,capabilities:{sourceExecution:{allowed:true,acceptsOriginalFiles:true}}}));\nelse if(op==='result'){const outcome=JSON.parse(fs.readFileSync(${JSON.stringify(outcomePath)},'utf8'));process.stdout.write(fs.readFileSync(outcome.hostReceiptPath,'utf8'));}\nelse process.exit(2);\n`);
    fs.chmodSync(observer,0o755);process.env.SPEC_DELIVERY_SKILL_OBSERVER=observer;
    const started = await main(['skill-start',x.statePath,x.j.id,requestPath]) as {invocationId:string;mode:string;sourceArchivePath:string};
    assert.equal(started.mode, 'source_execution'); assert.ok(fs.existsSync(started.sourceArchivePath));
    const live = JSON.parse(fs.readFileSync(x.statePath,'utf8')) as core.State;
    const call = {invocation: live.v3!.skillInvocations[0], source: JSON.parse(fs.readFileSync(started.sourceArchivePath,'utf8')),
      alreadyStarted:false} as skills.PreparedSkillCall;
    fs.writeFileSync(outcomePath,JSON.stringify(x.output(call,'pass',false)));
    const finished = await main(['skill-finish',x.statePath,started.invocationId,outcomePath]) as {status:string};
    assert.equal(finished.status,'pass');
    const saved = JSON.parse(fs.readFileSync(x.statePath,'utf8')) as core.State;
    assert.equal(saved.v3!.skillInvocations[0].mode,'source_execution');
    assert.equal(saved.v3!.skillInvocations[0].result!.rawOutputSha256,sha('Actual skill output'));
  } finally {
    if(previousObserver===undefined)delete process.env.SPEC_DELIVERY_SKILL_OBSERVER;
    else process.env.SPEC_DELIVERY_SKILL_OBSERVER=previousObserver;
    x.cleanup();
  }
});

test('公开 CLI 技能迁移需要当前修订与依据，并保留旧指纹记录', async () => {
  const x = setup();
  try {
    x.j.status = 'cancelled'; x.t.phase = 'fresh';
    x.t.evidence.regular = {head:x.t.head,base:x.t.base,path:'regular'};
    fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    const alternate = path.join(x.root,'new-review','SKILL.md'); fs.mkdirSync(path.dirname(alternate));
    fs.writeFileSync(alternate,'---\nname: new-pr-review\n---\n\nReview the candidate and report blockers.\n');
    const proof = path.join(x.root,'reason.md'); fs.writeFileSync(proof,'Switch PR review method');
    const request = path.join(x.root,'migration.json');
    fs.writeFileSync(request,JSON.stringify({expectedRevision:x.s.revision+1,evidencePath:proof,replacements:{prReview:alternate}}));
    await assert.rejects(main(['migrate-skills',x.statePath,request]),/已过期/);
    fs.writeFileSync(request,JSON.stringify({expectedRevision:x.s.revision,evidencePath:proof,replacements:{prReview:alternate}}));
    const migrated = await main(['migrate-skills',x.statePath,request]) as {changed:string[]};
    assert.deepEqual(migrated.changed,['prReview']);
    const saved=JSON.parse(fs.readFileSync(x.statePath,'utf8')) as core.State;
    assert.equal(saved.tickets[0].phase,'review');
    assert.equal(saved.tickets[0].evidence.regular,undefined);
    assert.equal(saved.v3!.skillMigrations?.[0].changes[0].capability,'prReview');
    assert.notEqual(saved.v3!.skillMigrations?.[0].changes[0].previousFingerprint,
      saved.v3!.skillMigrations?.[0].changes[0].nextFingerprint);
  } finally { x.cleanup(); }
});

test('较早 v3 运行缺少技能绑定时可在无在途 actor 后显式固定默认来源', () => {
  const x = setup();
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = x.root;
    delete x.s.v3!.skillBindings; x.j.status = 'cancelled';
    const proof = path.join(x.root,'upgrade-proof.md'); fs.writeFileSync(proof,'Stopped old actors');
    const changed = skills.migrateSkillBindings(x.s, {}, proof);
    assert.equal(changed.length, 5);
    assert.equal(x.s.v3!.skillBindings?.length, 5);
    assert.equal(x.t.phase, 'replan');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    x.cleanup();
  }
});

test('fresh 父调用强制子任务独立上下文，技能文字不能改写三档模型路由', () => {
  const x=setup();
  try {
    x.j.action='self-spec';x.j.fresh=true;x.t.phase='self';
    const invocation=skills.prepareSkillCall(x.s,x.j,'authorReview',
      {sourceExecution:{allowed:true,acceptsOriginalFiles:true}},x.statePath).invocation;
    assert.throws(()=>skills.delegateSkillChildren(x.s,invocation.id,[
      {key:'bad',instruction:'Try a different model',tier:'L3',model:'large'} as skills.SkillChildSpec
    ]),/模型只能来自/);
    const rows=skills.delegateSkillChildren(x.s,invocation.id,[
      {key:'independent',instruction:'Check independently',tier:'L3',independent:false}
    ]);
    assert.equal(rows[0].model,'small');assert.equal(rows[0].fresh,true);
    assert.equal(rows[0].independent,true);
    const child=core.reserve(x.s).find(j=>j.action==='skill-child');assert.ok(child);
    assert.equal(child.fresh,true);assert.equal(child.contextIntent?.kind,'independent');
    assert.notEqual(child.contextKey,x.j.contextKey);
    assert.equal(child.parentInvocationId,invocation.id);
    assert.equal(child.candidateVersion,x.j.candidateVersion);
    const task=packet(x.s,child,x.statePath);
    assert.deepEqual(task.prior,[]);
    assert.equal(task.blockingReason,'');
    assert.deepEqual(task.objectiveEvidence,{tests:undefined,visual:undefined});
  } finally {x.cleanup();}
});

function contextFixture(mode:'resumed'|'new') {
  const x=setup();
  x.t.phase='review';x.t.epoch=2;x.t.pr=0;
  x.j.action='review-lens';x.j.part='0';x.j.epoch=1;x.j.tier='L2';x.j.model='middle';x.j.status='done';
  x.j.contextIntent={kind:'independent',fresh:false,lineage:'101:review-review-lens-0'};
  x.j.session!.model='middle';
  x.j.session!.context={contextId:'context-original',mode:'new',proofId:'original-context-proof'};
  const originalObservation=JSON.stringify({source:'native_host',nativeId:x.j.nativeId,jobId:x.j.id,
    provider:'fixture',model:'middle',context:x.j.session!.context});
  fs.writeFileSync(x.j.session!.evidencePath,originalObservation);
  x.j.session!.evidenceDigest=sha(originalObservation);
  x.j.contextObservation={source:'native_host',...x.j.session!.context,nativeId:x.j.nativeId,
    evidencePath:x.j.session!.evidencePath,evidenceDigest:x.j.session!.evidenceDigest};
  x.j.result={model:'middle',complete:true,status:'reviewed',head:x.t.head,base:x.t.base,
    evidencePath:x.j.session!.evidencePath,findings:[]};
  const successor:core.Job={...structuredClone(x.j),id:'job-2',epoch:x.t.epoch,status:'leased',nativeId:'',
    session:undefined,contextObservation:undefined,result:undefined,part:'0',
    contextIntent:core.contextIntentFor(x.s,x.t.key,'review-lens','0',false),
    contextKey:'review-continuation',candidateVersion:core.candidateVersion(x.s,x.t)};
  assert.equal(successor.contextIntent!.kind,'continue');x.s.jobs.push(successor);
  const sessionsPath=path.join(x.root,'context-sessions.json');
  const nativeId=mode==='resumed'?'host/resumed':'host/new';
  const sessions:Record<string,unknown>={
    [nativeId]:{source:'native_host',observationId:'observed-successor',jobId:successor.id,nativeId,
      provider:'fixture',model:'middle',observedAt:new Date().toISOString(),
      context:mode==='resumed'?{contextId:'context-original',mode:'resumed',resumedFromContextId:'context-original',proofId:'resume-proof'}
        :{contextId:'context-new',mode:'new',proofId:'new-context-proof'}},
    'l1-handoff':{source:'native_host',observationId:'observed-l1',jobId:`$handoff:${successor.id}`,nativeId:'l1-handoff',
      provider:'fixture',model:'large',observedAt:new Date().toISOString(),
      context:{contextId:'context-l1-verification',mode:'new',proofId:'l1-proof'}}};
  fs.writeFileSync(sessionsPath,JSON.stringify(sessions));
  const observer=path.join(x.root,'context-observer');
  fs.writeFileSync(observer,`#!/usr/bin/env node\nconst fs=require('fs');const [op,id,job]=process.argv.slice(2);const all=JSON.parse(fs.readFileSync(${JSON.stringify(sessionsPath)},'utf8'));\nif(op==='availability'){console.log(JSON.stringify({source:'native_host',nativeId:id,jobId:job,state:'unavailable',observationId:'lost-'+id,observedAt:new Date().toISOString()}));}\nelse if(op==='observe'&&all[id]&&all[id].jobId===job)console.log(JSON.stringify(all[id]));else process.exit(2);\n`);
  fs.chmodSync(observer,0o755);
  const bindingPath=path.join(x.root,'context-binding.json');fs.writeFileSync(bindingPath,JSON.stringify({nativeId}));
  fs.writeFileSync(x.statePath,JSON.stringify(x.s));
  return {...x,successor,nativeId,observer,bindingPath,sessionsPath,
    result:():core.Result=>({model:'middle',complete:true,status:'reviewed',head:x.t.head,base:x.t.base,
      evidencePath:x.j.session!.evidencePath,findings:[]})};
}

test('可续接与不可续接宿主都保留同一审查结果，且区别真实上下文来源', async () => {
  for(const mode of ['resumed','new'] as const) {
    const x=contextFixture(mode),previousObserver=process.env.SPEC_DELIVERY_HOST_OBSERVER;
    const previousSkillObserver=process.env.SPEC_DELIVERY_SKILL_OBSERVER;
    try {
      process.env.SPEC_DELIVERY_HOST_OBSERVER=x.observer;
      const bound=await main(['bind',x.statePath,x.successor.id,x.bindingPath]);assert.ok(bound);
      let state=JSON.parse(fs.readFileSync(x.statePath,'utf8')) as core.State;
      const current=state.jobs.find(j=>j.id===x.successor.id)!;
      assert.equal(current.contextObservation?.mode,mode);
      if(mode==='resumed')assert.equal(core.contextReady(current),true);
      else {
        assert.equal(core.contextReady(current),false);
        assert.throws(()=>core.submit(structuredClone(state),current.id,x.result()),/交接/);
        const outcomePath=path.join(x.root,'handoff-outcome.json');
        const skillObserver=path.join(x.root,'skill-context-observer');
        fs.writeFileSync(skillObserver,`#!/usr/bin/env node\nconst fs=require('fs');const [op,id,job]=process.argv.slice(2);\nif(op==='capabilities')console.log(JSON.stringify({source:'native_host',jobId:job,capability:id,capabilities:{sourceExecution:{allowed:true,acceptsOriginalFiles:true}}}));\nelse if(op==='result'){const outcome=JSON.parse(fs.readFileSync(${JSON.stringify(outcomePath)},'utf8'));process.stdout.write(fs.readFileSync(outcome.hostReceiptPath,'utf8'));}\nelse process.exit(2);\n`);
        fs.chmodSync(skillObserver,0o755);process.env.SPEC_DELIVERY_SKILL_OBSERVER=skillObserver;
        const skillRequest=path.join(x.root,'handoff-skill-request.json');
        fs.writeFileSync(skillRequest,JSON.stringify({capability:'handoff'}));
        const started=await main(['skill-start',x.statePath,x.j.id,skillRequest]) as {invocationId:string;sourceArchivePath:string};
        state=JSON.parse(fs.readFileSync(x.statePath,'utf8')) as core.State;
        const invocation=state.v3!.skillInvocations.find(i=>i.id===started.invocationId)!;
        const call={invocation,source:JSON.parse(fs.readFileSync(started.sourceArchivePath,'utf8')),
          alreadyStarted:false} as skills.PreparedSkillCall;
        const handoffText=`# Original actor handoff\n\nSource: ${x.j.session!.evidencePath}\nCurrent candidate: ${x.t.head}/${x.t.base}\n\nsuggested skills: code-review\n`;
        const handoffOutcome=x.output(call,'pass',false,handoffText);
        fs.writeFileSync(outcomePath,JSON.stringify(handoffOutcome));
        assert.equal((await main(['skill-finish',x.statePath,started.invocationId,outcomePath]) as {status:string}).status,'pass');
        state=JSON.parse(fs.readFileSync(x.statePath,'utf8')) as core.State;
        const archived=state.v3!.skillInvocations.find(i=>i.id===started.invocationId)!.result!;
        const skillShaBefore=sha(fs.readFileSync(x.fixture.handoff));
        assert.equal(sha(fs.readFileSync(archived.rawOutputPath)),sha(handoffText));
        const verificationPath=path.join(x.root,'l1-handoff-verification.json');
        fs.writeFileSync(verificationPath,JSON.stringify({jobId:current.id,candidateVersion:current.candidateVersion,
          head:current.head,base:current.base,sourceJobId:x.j.id,sourceHead:x.j.head,sourceBase:x.j.base,
          originalPath:archived.rawOutputPath,originalSha256:archived.rawOutputSha256,
          sourceLinks:[x.j.session!.evidencePath]}));
        const forwardPath=path.join(x.root,'forward.json');
        fs.writeFileSync(forwardPath,JSON.stringify({invocationId:started.invocationId,decisionNativeId:'l1-handoff',
          verificationPath,expectedCandidateVersion:current.candidateVersion}));
        const staleForward=path.join(x.root,'stale-forward.json');
        fs.writeFileSync(staleForward,JSON.stringify({invocationId:started.invocationId,decisionNativeId:'l1-handoff',
          verificationPath,expectedCandidateVersion:'stale-candidate'}));
        await assert.rejects(main(['context-handoff',x.statePath,current.id,staleForward]),/过期候选/);
        const forwarded=await main(['context-handoff',x.statePath,current.id,forwardPath]) as {handoffRef:core.HandoffReference};
        assert.equal(forwarded.handoffRef.kind,'original');
        assert.equal(forwarded.handoffRef.path,archived.rawOutputPath);
        assert.equal(sha(fs.readFileSync(x.fixture.handoff)),skillShaBefore);
        const archivedBytes=fs.readFileSync(archived.rawOutputPath);
        fs.appendFileSync(archived.rawOutputPath,'tampered');
        const blockedSkillRequest=path.join(x.root,'blocked-skill-request.json');
        fs.writeFileSync(blockedSkillRequest,JSON.stringify({capability:'prReview'}));
        await assert.rejects(main(['skill-start',x.statePath,current.id,blockedSkillRequest]),/交接原文或 L1 核验记录已改变/);
        fs.writeFileSync(archived.rawOutputPath,archivedBytes);
        state=JSON.parse(fs.readFileSync(x.statePath,'utf8')) as core.State;
      }
      core.submit(state,current.id,x.result());
      assert.equal(state.jobs.find(j=>j.id===current.id)?.status,'done');
      assert.equal(state.tickets[0].phase,'review');
      assert.deepEqual(state.jobs.find(j=>j.id===current.id)?.result?.findings,[]);
    } finally {
      if(previousObserver===undefined)delete process.env.SPEC_DELIVERY_HOST_OBSERVER;else process.env.SPEC_DELIVERY_HOST_OBSERVER=previousObserver;
      if(previousSkillObserver===undefined)delete process.env.SPEC_DELIVERY_SKILL_OBSERVER;else process.env.SPEC_DELIVERY_SKILL_OBSERVER=previousSkillObserver;
      x.cleanup();
    }
  }
});

test('原 actor 不可恢复时 L1 重建标记未知项；过期候选拒绝交接', async () => {
  const x=contextFixture('new'),previousObserver=process.env.SPEC_DELIVERY_HOST_OBSERVER;
  try {
    process.env.SPEC_DELIVERY_HOST_OBSERVER=x.observer;
    await main(['bind',x.statePath,x.successor.id,x.bindingPath]);
    const before=JSON.parse(fs.readFileSync(x.statePath,'utf8')) as core.State;
    const current=before.jobs.find(j=>j.id===x.successor.id)!;
    const reconstructedPath=path.join(x.root,'reconstructed.json');
    fs.writeFileSync(reconstructedPath,JSON.stringify({kind:'l1_reconstructed',jobId:current.id,
      sourceJobId:x.j.id,candidateVersion:current.candidateVersion,head:current.head,base:current.base,
      reason:'original actor no longer available',sourceLinks:[x.j.session!.evidencePath],
      unknowns:['unrecorded conversation details'],suggestedSkills:['code-review']}));
    const requestPath=path.join(x.root,'reconstruction-request.json');
    fs.writeFileSync(requestPath,JSON.stringify({decisionNativeId:'l1-handoff',
      expectedCandidateVersion:current.candidateVersion,reconstructedPath}));
    const stale=structuredClone(before);stale.tickets[0].head='other-head';fs.writeFileSync(x.statePath,JSON.stringify(stale));
    await assert.rejects(main(['context-reconstruct',x.statePath,current.id,requestPath]),/候选已过期/);
    fs.writeFileSync(x.statePath,JSON.stringify(before));
    const result=await main(['context-reconstruct',x.statePath,current.id,requestPath]) as {handoffRef:core.HandoffReference};
    assert.equal(result.handoffRef.kind,'reconstructed');
    assert.deepEqual(result.handoffRef.unknowns,['unrecorded conversation details']);
    assert.ok(fs.existsSync(result.handoffRef.unavailableEvidencePath!));
    assert.equal(result.handoffRef.invocationId,undefined);
    const state=JSON.parse(fs.readFileSync(x.statePath,'utf8')) as core.State;
    core.submit(state,current.id,x.result());
    assert.equal(state.jobs.find(j=>j.id===current.id)?.status,'done');
  } finally {if(previousObserver===undefined)delete process.env.SPEC_DELIVERY_HOST_OBSERVER;
    else process.env.SPEC_DELIVERY_HOST_OBSERVER=previousObserver;x.cleanup();}
});

test('独立动作和 fresh 不复用作者或 regular 结论，fresh packet 只给原始来源', () => {
  const x=contextFixture('new');
  try {
    x.s.jobs=x.s.jobs.filter(j=>j.id!==x.successor.id);
    const reserved=core.reserve(x.s);
    assert.equal(reserved.find(j=>j.action==='review-lens'&&j.part==='0')?.contextIntent?.predecessorJobId,x.j.id);
    x.s.jobs=x.s.jobs.filter(j=>!reserved.includes(j));
    x.s.jobs.push({...structuredClone(x.j),id:'author-prior',action:'implement',part:'',
      contextIntent:{kind:'independent',fresh:false,lineage:'101:author'}});
    for(const action of ['implement','publish','integrate'] as core.Action[])
      assert.equal(core.contextIntentFor(x.s,x.t.key,action,'',false).predecessorJobId,'author-prior');
    for(const action of ['plan-check','accept','replan','adjudicate','spec-audit'] as core.Action[])
      assert.equal(core.contextIntentFor(x.s,x.t.key,action,'',false).kind,'independent');
    assert.equal(core.contextIntentFor(x.s,x.t.key,'review-lens','0',false).kind,'continue');
    assert.equal(core.contextIntentFor(x.s,x.t.key,'review-lens','0',true).kind,'independent');
    x.t.evidence.regular={head:x.t.head,base:x.t.base,path:x.j.session!.evidencePath};
    x.t.reviewHandoff=x.j.session!.evidencePath;x.t.reason='author argued this finding away';
    const fresh={...x.successor,id:'fresh-job',fresh:true,contextIntent:{kind:'independent' as const,fresh:true},
      action:'review-lens' as const,contextKey:'fresh-context'};
    const p=packet(x.s,fresh,x.statePath);
    assert.deepEqual(p.prior,[]);assert.equal(p.handoffPath,'');assert.equal(p.historyIndexPath,'');
    assert.equal(p.blockingReason,'');assert.equal(p.finding,null);assert.equal(p.dispute,null);
    assert.equal(p.rawSources?.candidate.head,x.t.head);
    assert.equal(fs.existsSync(path.join(path.dirname(x.statePath),'jobs',sha(fresh.id).slice(0,20),'prior-index.json')),false);
  } finally {x.cleanup();}
});

test('续接证明来自宿主原生观测；caller 的 context 字段与错误祖先不能冒充', async () => {
  const x=contextFixture('resumed'),previousObserver=process.env.SPEC_DELIVERY_HOST_OBSERVER;
  try {
    process.env.SPEC_DELIVERY_HOST_OBSERVER=x.observer;
    const sessions=JSON.parse(fs.readFileSync(x.sessionsPath,'utf8'));
    delete sessions[x.nativeId].context;fs.writeFileSync(x.sessionsPath,JSON.stringify(sessions));
    fs.writeFileSync(x.bindingPath,JSON.stringify({nativeId:x.nativeId,
      context:{contextId:'context-original',mode:'resumed',resumedFromContextId:'context-original',proofId:'forged'}}));
    await assert.rejects(main(['bind',x.statePath,x.successor.id,x.bindingPath]),/宿主未证明实际上下文/);
    sessions[x.nativeId].context={contextId:'context-original',mode:'resumed',
      resumedFromContextId:'wrong-ancestor',proofId:'host-proof'};
    fs.writeFileSync(x.sessionsPath,JSON.stringify(sessions));
    await assert.rejects(main(['bind',x.statePath,x.successor.id,x.bindingPath]),/宿主续接证明与前序上下文不符/);
    sessions[x.nativeId].context.resumedFromContextId='context-original';
    fs.writeFileSync(x.sessionsPath,JSON.stringify(sessions));
    await main(['bind',x.statePath,x.successor.id,x.bindingPath]);
    const state=JSON.parse(fs.readFileSync(x.statePath,'utf8')) as core.State;
    assert.equal(state.jobs.find(j=>j.id===x.successor.id)?.contextObservation?.proofId,'host-proof');
  } finally {if(previousObserver===undefined)delete process.env.SPEC_DELIVERY_HOST_OBSERVER;
    else process.env.SPEC_DELIVERY_HOST_OBSERVER=previousObserver;x.cleanup();}
});
