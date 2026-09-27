import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as core from './core.ts';
import * as skills from './skills.ts';
import { packet } from '../spec-delivery.workflow.ts';

const sha = (bytes:Buffer|string) => createHash('sha256').update(bytes).digest('hex');
const defaultReview = new URL('./review-skills/code-review-from-claude/SKILL.md', import.meta.url).pathname;
const host = { sourceExecution:{allowed:true,acceptsOriginalFiles:true} };

function fixture(useDefault = false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pr-review-'));
  const skillRoot=path.join(root,'skills');
  for(const name of ['implement','diagnosing-bugs','code-review','code-review-from-claude','handoff']) {
    const dir=path.join(skillRoot,name);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'SKILL.md'),`---\nname: ${name}\n---\n\nFixture professional method.\n`);
  }
  const alternate=path.join(skillRoot,'code-review-from-claude','SKILL.md');
  fs.writeFileSync(alternate,'---\nname: alternate-pr-review\n---\n\nUse a single holistic check and verdict words, without scores.\n');
  const v3=core.initialProtocolV3();v3.skillBindings=skills.defaultSkillBindings(skillRoot);
  if(useDefault)v3.skillBindings=v3.skillBindings.map(b=>b.capability==='prReview'?skills.resolveSkill('prReview',defaultReview):b);
  const s:core.State={schema:1,protocol:3,v3,id:'pr-test',revision:0,
    inputs:{spec:24,targetBranch:'main',models:{L1:'large',L2:'middle',L3:'small'}},spec:24,
    repo:{root,slug:'example/repo',host:'github.com',defaultBranch:'main'},status:'running',
    policy:{agents:16,issues:1,tests:1,noProgress:3,rounds:5},capabilities:{framework:'fixture',modelRouting:'per_agent',models:['large','middle','small']},
    specCriteria:[],planEvidence:'',tickets:[],jobs:[],facts:{base:'b'.repeat(40),issueStates:{},
      prs:{'47':{number:47,head:'a'.repeat(40),base:'b'.repeat(40),baseRef:'main',state:'OPEN',draft:false,mergeable:'MERGEABLE',checks:[{id:'ci',status:'pass'}]}},at:''},
    auditEpoch:1,events:[]};
  const t=core.buildTicket({number:35,kind:'software',dependencies:[],criteria:['done'],visual:false},s.facts.base);
  t.phase='review';t.head='a'.repeat(40);t.base=s.facts.base;t.pr=47;t.worktree=root;
  t.evidence.self={head:t.head,base:t.base,path:'self'};t.evidence.tests={head:t.head,base:t.base,path:'tests'};
  s.tickets=[t];s.validationOwner=t.key;
  const statePath=path.join(root,'run','state.json');fs.mkdirSync(path.dirname(statePath),{recursive:true});
  const bind=(j:core.Job)=>{
    const nativeId=`native-${sha(j.id).slice(0,16)}`;
    const previous=s.jobs.find(x=>x.id===j.contextIntent?.predecessorJobId);
    const priorContext=previous?.contextObservation?.contextId;
    const evidencePath=path.join(root,`${nativeId}.json`);
    const observation=JSON.stringify({source:'native_host',jobId:j.id,nativeId,model:j.model});
    fs.writeFileSync(evidencePath,observation);
    const session:core.NativeSession={source:'native_host',observationId:`observation-${nativeId}`,jobId:j.id,
      nativeId,provider:'fixture',model:j.model,observedAt:new Date().toISOString(),evidencePath,evidenceDigest:sha(observation),
      context:priorContext ? {contextId:priorContext,mode:'resumed',resumedFromContextId:priorContext,proofId:`proof-${nativeId}`}
        : {contextId:nativeId,mode:'new',proofId:`proof-${nativeId}`}};
    core.bind(s,j.id,{nativeId,session});return session;
  };
  const reviewJob=()=>{const j=core.reserve(s).find(j=>j.action==='pr-review');assert.ok(j);bind(j);return j;};
  const start=(j:core.Job)=>skills.prepareSkillCall(s,j,'prReview',host,statePath);
  const finish=(call:skills.PreparedSkillCall,status:core.SkillStatus,blocking:boolean,report='Review complete. No issues found.')=>{
    const dir=path.join(root,sha(call.invocation.id).slice(0,16));fs.mkdirSync(dir,{recursive:true});
    const rawOutputPath=path.join(dir,'report.md');fs.writeFileSync(rawOutputPath,report);
    const hostReceiptPath=path.join(dir,'host.json');
    fs.writeFileSync(hostReceiptPath,JSON.stringify({source:'native_host',invocationId:call.invocation.id,
      jobId:call.invocation.jobId,nativeId:call.invocation.session.nativeId,
      observationId:call.invocation.session.observationId,mode:call.invocation.mode,
      bindingFingerprint:call.invocation.bindingFingerprint,terminal:true,
      loadedFiles:call.source.files.map(file=>({relativePath:file.relativePath,sha256:file.sha256}))}));
    return skills.finishSkillCall(s,call.invocation.id,{status,blocking,rawOutputPath,evidencePaths:[rawOutputPath],hostReceiptPath});
  };
  const completeDefaultChildren=(call:skills.PreparedSkillCall)=>{
    const source=call.source.files.find(file=>file.relativePath==='automation-contract.json');assert.ok(source);
    const contract=JSON.parse(Buffer.from(source.dataBase64,'base64').toString()) as {requiredChildren:{key:string;tier:core.Tier}[]};
    skills.delegateSkillChildren(s,call.invocation.id,contract.requiredChildren.map(x=>({key:x.key,tier:x.tier,
      instruction:`Perform ${x.key} independently`,required:true,independent:true})));
    const children=core.reserve(s).filter(j=>j.action==='skill-child');
    assert.equal(children.length,contract.requiredChildren.length);
    for(const child of children) {
      bind(child);
      core.submit(s,child.id,{model:child.model,complete:true,status:'completed',head:child.head,base:child.base,
        evidencePath:path.join(root,`${child.part}.md`)});
    }
  };
  const submitReview=(j:core.Job,call:skills.PreparedSkillCall,result:core.SkillResult)=>{
    skills.verifySkillResultFiles(s,j,[call.invocation.id]);
    core.submit(s,j.id,{model:j.model,complete:true,status:'reviewed',head:j.head,base:j.base,
      evidencePath:result.rawOutputPath,data:{skillInvocationIds:[call.invocation.id]}});
  };
  const post=()=>{
    const j=core.reserve(s).find(j=>j.action==='review-report');assert.ok(j);assert.equal(j.executor,'command');
    core.bind(s,j.id,{nativeId:`command:${j.id}`,model:j.model});
    const review=s.jobs.findLast(x=>x.action==='pr-review'&&x.epoch===j.epoch)!;
    const invocation=s.v3!.skillInvocations.find(x=>x.jobId===review.id)!;
    core.submit(s,j.id,{model:j.model,complete:true,status:'posted',head:j.head,base:j.base,
      evidencePath:invocation.result!.rawOutputPath,
      data:{commentUrl:`https://example.invalid/${j.id}`,reviewInvocationId:invocation.id}});
    return invocation;
  };
  return {root,skillRoot,alternate,s,t,statePath,reviewJob,start,finish,completeDefaultChildren,submitReview,post,
    cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('默认技能包固定五个审查视角与准备任务，完整原始报告贯穿 regular/fresh',()=>{
  const x=fixture(true);
  try {
    const regular=x.reviewJob();const first=x.start(regular);
    assert.ok(first.source.files.some(f=>f.relativePath==='LICENSE'));
    assert.throws(()=>x.finish(first,'pass',false),/技能包要求的子任务/);
    x.completeDefaultChildren(first);
    const regularResult=x.finish(first,'pass',false,'Regular report: no issues.');
    x.submitReview(regular,first,regularResult);
    const regularInvocation=x.post();
    assert.equal(x.t.phase,'fresh');assert.equal(x.t.evidence.regular?.path,regularInvocation.result?.rawOutputPath);
    const fresh=x.reviewJob();assert.equal(fresh.contextIntent?.kind,'independent');
    const p=packet(x.s,fresh,x.statePath);
    assert.deepEqual(p.prior,[]);assert.equal(p.handoffRef,null);assert.equal(p.blockingReason,'');
    assert.equal(p.rawSources?.candidate.head,x.t.head);assert.equal(p.skillCall?.capabilities[0],'prReview');
    const second=x.start(fresh);x.completeDefaultChildren(second);
    x.submitReview(fresh,second,x.finish(second,'pass',false,'Fresh report: no issues.'));
    x.post();
    assert.equal(x.t.phase,'accept');
    assert.equal(x.t.evidence.regular?.skillFingerprint,x.t.evidence.fresh?.skillFingerprint);
    assert.notEqual(x.t.evidence.regular?.skillInvocationId,x.t.evidence.fresh?.skillInvocationId);
    assert.ok(x.t.evidence.fresh?.rawReportSha256);
  } finally {x.cleanup();}
});

test('替代技能可无固定视角或数值评分；阻断、跳过和版本变化按外围门禁处理',()=>{
  for(const status of ['skipped','incomplete'] as const) {
    const skipped=fixture();
    try {
      const j=skipped.reviewJob(),call=skipped.start(j),result=skipped.finish(call,status,false,'Review not completed');
      assert.throws(()=>skipped.submitReview(j,call,result),/跳过、未完成/);
      core.submit(skipped.s,j.id,{model:j.model,complete:false,status,head:j.head,base:j.base,
        evidencePath:result.rawOutputPath,data:{skillInvocationIds:[call.invocation.id]}});
      assert.notEqual(skipped.t.phase,'fresh');
    } finally {skipped.cleanup();}
  }
  const blocked=fixture();
  try {
    const j=blocked.reviewJob(),call=blocked.start(j);
    blocked.submitReview(j,call,blocked.finish(call,'changes_required',true,'Needs correction; no numeric score.'));
    blocked.post();assert.equal(blocked.t.phase,'implement');assert.equal(blocked.t.evidence.regular,undefined);
  } finally {blocked.cleanup();}
  const x=fixture();
  try {
    const first=x.reviewJob(),firstCall=x.start(first);
    x.submitReview(first,firstCall,x.finish(firstCall,'pass',false,'Holistic verdict: clear.'));
    x.post();assert.equal(x.t.phase,'fresh');
    const migration=path.join(x.root,'migration.md');fs.writeFileSync(migration,'Use revised review method');
    fs.writeFileSync(x.alternate,'---\nname: alternate-pr-review\n---\n\nUse two thematic checks, verdict words only.\n');
    assert.deepEqual(skills.migrateSkillBindings(x.s,{},migration),['prReview']);
    assert.equal(x.t.phase,'review');assert.equal(x.t.evidence.regular,undefined);
    const second=x.reviewJob(),secondCall=x.start(second);
    x.submitReview(second,secondCall,x.finish(secondCall,'pass',false,'Clear without a numeric score.'));
    x.post();const fresh=x.reviewJob(),freshCall=x.start(fresh);
    x.submitReview(fresh,freshCall,x.finish(freshCall,'pass',false,'Independent fresh clear.'));
    x.post();assert.equal(x.t.phase,'accept');
    x.t.head='c'.repeat(40);
    x.s.facts.prs['47'].head=x.t.head;
    for(const key of ['self','tests','accept'] as const)x.t.evidence[key]={head:x.t.head,base:x.t.base,path:key};
    assert.equal(core.mergeGate(x.s,x.t),false,'changed candidate invalidates both reviews');
  } finally {x.cleanup();}
});
