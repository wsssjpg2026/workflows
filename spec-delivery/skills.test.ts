import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as core from './core.ts';
import * as skills from './skills.ts';
import { main } from '../spec-delivery.workflow.ts';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const original = {
  implement: '/home/administrator/.agents/skills/implement/SKILL.md',
  handoff: '/home/administrator/.agents/skills/handoff/SKILL.md',
};
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-skill-'));
  const statePath = path.join(root, 'run', 'state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const v3 = core.initialProtocolV3(); v3.skillBindings = skills.defaultSkillBindings();
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
  return { root, statePath, s, t, j, output, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('原始 implement/handoff 以真实 source/native 路径调用，字节保持相同并保留原文来源', async () => {
  const before = Object.fromEntries(Object.entries(original).map(([name, file]) => [name, sha(fs.readFileSync(file))]));
  const x = setup();
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
        assert.equal(Buffer.from(source.dataBase64, 'base64').equals(fs.readFileSync(original.handoff)), true);
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
    assert.doesNotThrow(() => core.submit(x.s, x.j.id, r));
    assert.equal(x.t.phase, 'queued');
    assert.deepEqual(Object.fromEntries(Object.entries(original).map(([name, file]) => [name, sha(fs.readFileSync(file))])), before);
  } finally { x.cleanup(); }
});

test('能力不足、原生版本不匹配、空白产物与四类结论均有明确门禁', () => {
  const x = setup();
  try {
    assert.throws(() => skills.prepareSkillCall(x.s, x.j, 'implementation', { nativeExplicit: {supported:true,
      registrations:[{entry:'Skill:implement',sourcePath:original.implement,fingerprint:'wrong'}]} }, x.statePath), /宿主没有已注册/);
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
  try {
    delete x.s.v3!.skillBindings; x.j.status = 'cancelled';
    const proof = path.join(x.root,'upgrade-proof.md'); fs.writeFileSync(proof,'Stopped old actors');
    const changed = skills.migrateSkillBindings(x.s, {}, proof);
    assert.equal(changed.length, 5);
    assert.equal(x.s.v3!.skillBindings?.length, 5);
    assert.equal(x.t.phase, 'replan');
  } finally { x.cleanup(); }
});
