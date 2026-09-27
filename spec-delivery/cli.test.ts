import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as e from './core.ts';
import {defaultSkillBindings} from './skills.ts';
import { packet, stageResult } from '../spec-delivery.workflow.ts';
const entry=fileURLToPath(new URL('../spec-delivery.workflow.ts',import.meta.url));
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function setup() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-cli-'));git(root,'init','-b','main');git(root,'config','user.email','test@example.invalid');git(root,'config','user.name','Workflow Test');
  fs.writeFileSync(path.join(root,'source'),'base');git(root,'add','source');git(root,'commit','-m','base');const head=git(root,'rev-parse','HEAD');
  fs.mkdirSync(path.join(root,'.agents','worktrees'),{recursive:true});const wt=path.join(root,'.agents','worktrees','task');git(root,'worktree','add','-b','task',wt,head);
  for (const name of ['implement','diagnosing-bugs','code-review','code-review-from-claude','handoff']) {
    const directory=path.join(root,'.agents','skills',name);fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'SKILL.md'),`---\nname: ${name}\n---\n\nExecute ${name} in the CLI fixture.\n`);
  }
  fs.appendFileSync(path.join(root,'.git','info','exclude'),'\n/.agents/\n/bin/\n/evidence.md\n/plan.json\n');
  const run=path.join(root,'.agents','workflow-runs','test');fs.mkdirSync(run,{recursive:true});const statePath=path.join(run,'state.json');
  const v3=e.initialProtocolV3();v3.skillBindings=defaultSkillBindings(path.join(root,'.agents','skills'));
  const s:e.State={schema:1,protocol:3,v3,id:'cli-fixture',revision:0,inputs:{spec:100,targetBranch:'main',models:{L1:'large',L2:'middle',L3:'small'}},spec:100,repo:{root,slug:'example/test',host:'github.com',defaultBranch:'main'},status:'running',policy:{agents:8,issues:3,tests:1,noProgress:3,rounds:4},tickets:[],jobs:[],specCriteria:['done'],planEvidence:'',auditEpoch:1,events:[],facts:{base:head,issueStates:{100:'OPEN',101:'OPEN'},prs:{},at:''}};
  const t=e.buildTicket({number:101,kind:'software',dependencies:[],criteria:['done'],visual:false},head);t.phase='plan';t.head=head;t.branch='task';t.worktree=wt;s.tickets.push(t);
  const j=e.reserve(s)[0];fs.writeFileSync(statePath,JSON.stringify(s));
  fs.mkdirSync(path.join(root,'bin'));const log=path.join(run,'gh.log');
  const sessions=path.join(run,'native-sessions.json');
  const observe=(nativeId:string,jobId:string,model:string,provider='fixture')=>{
    const all=fs.existsSync(sessions)?JSON.parse(fs.readFileSync(sessions,'utf8')):{};
    all[nativeId]={source:'native_host',observationId:`observed-${nativeId}`,jobId,nativeId,provider,model,
      context:{contextId:nativeId,mode:'new',proofId:`context-${nativeId}`},observedAt:'2026-09-27T00:00:00.000Z'};
    fs.writeFileSync(sessions,JSON.stringify(all));
  };
  const observer=path.join(root,'bin','observer');
  fs.writeFileSync(observer,`#!/usr/bin/env node\nconst fs=require('fs');const all=JSON.parse(fs.readFileSync(${JSON.stringify(sessions)},'utf8'));const [op,id,job]=process.argv.slice(2);const session=all[id];if(op!=='observe'||!session||session.jobId!==job)process.exit(2);console.log(JSON.stringify(session));\n`);
  fs.chmodSync(observer,0o755);
  const migrationHost=path.join(run,'migration-host.json');fs.writeFileSync(migrationHost,JSON.stringify({actors:{}}));
  const migrationObserver=path.join(root,'bin','migration-observer');
  fs.writeFileSync(migrationObserver,`#!/usr/bin/env node
const fs=require('fs'),q=JSON.parse(fs.readFileSync(0,'utf8'));
const live=JSON.parse(fs.readFileSync(${JSON.stringify(migrationHost)},'utf8'));
const actors=q.jobs.filter(j=>j.nativeId&&!j.nativeId.startsWith('command:')).map(j=>({jobId:j.id,
  nativeId:j.nativeId,state:live.actors[j.id]||'unknown',observationId:'native-query-'+j.id}));
console.log(JSON.stringify({source:'native_host',schemaVersion:1,challenge:q.challenge,runId:q.runId,
  inventorySha256:q.inventorySha256,ledgerSha256:q.ledgerSha256,observedAt:new Date().toISOString(),
  actors,dispatches:[],instances:[],processes:[],
  processTree:{state:'stopped',unknownChildren:0,observationId:'process-inventory'},
  externalActions:{state:'settled',unknown:0,observationId:'external-inventory'}}));
`);fs.chmodSync(migrationObserver,0o755);
  fs.writeFileSync(path.join(root,'bin','gh'),`#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'call\\n');console.log(JSON.stringify({data:{repository:{target:{target:{oid:'${head}'}},i100:{number:100,state:'OPEN'},i101:{number:101,state:'OPEN'}}}}));\n`);fs.chmodSync(path.join(root,'bin','gh'),0o755);
  fs.writeFileSync(path.join(root,'evidence.md'),'actual evidence');fs.writeFileSync(path.join(root,'plan.json'),'{}');
  const env={...process.env,HOME:root,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH,
    SPEC_DELIVERY_HOST_OBSERVER:observer,SPEC_DELIVERY_MIGRATION_OBSERVER:migrationObserver};
  const call=(...args:string[])=>spawnSync(process.execPath,[entry,...args],{cwd:root,env,encoding:'utf8'});
  return {root,run,head,s,t,j,statePath,log,call,observe,migrationHost};
}
function deliveryRemote(x:ReturnType<typeof setup>, initial:{state:'OPEN'|'MERGED';checks?:unknown[]}) {
  const remote=path.join(x.run,'delivery-remote.json');
  fs.writeFileSync(remote,JSON.stringify({state:initial.state,checks:initial.checks||[],
    issueState:'OPEN',baseRef:'main',prs:[],comments:[],creates:0,posts:0,merges:0,
    loseCreate:false,dropCreate:false,loseComment:false,loseMerge:false}));
  fs.writeFileSync(path.join(x.root,'bin','gh'),`#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2),file=${JSON.stringify(remote)};
const d=JSON.parse(fs.readFileSync(file,'utf8')),save=()=>fs.writeFileSync(file,JSON.stringify(d));
const endpoint=a.at(-1),head=${JSON.stringify(x.head)},pr=()=>({number:201,html_url:'https://github.com/example/test/pull/201',
  head:{sha:head,ref:'task'},base:{sha:head,ref:d.baseRef},state:d.state==='MERGED'?'closed':'open',
  merged:d.state==='MERGED',merge_commit_sha:d.state==='MERGED'?head:null,draft:false,mergeable:true});
if(a.includes('graphql'))console.log(JSON.stringify({data:{repository:{target:{target:{oid:head}},i100:{number:100,state:'OPEN'},
  i101:{number:101,state:d.issueState},p201:{number:201,url:'https://github.com/example/test/pull/201',state:d.state,
  headRefOid:head,baseRefOid:head,baseRefName:d.baseRef,headRefName:'task',isDraft:false,mergeable:'MERGEABLE',
  mergeCommit:d.state==='MERGED'?{oid:head}:null}}}}));
else if(a[0]==='pr'&&a[1]==='merge'){d.merges++;d.state='MERGED';save();if(d.loseMerge)process.exit(1);console.log('merged');}
else if(a.includes('--method')&&a.includes('POST')&&endpoint.endsWith('/pulls')){
  d.creates++;if(d.dropCreate){save();process.exit(1);}
  d.prs=[{number:201,body:JSON.parse(fs.readFileSync(0,'utf8')).body}];save();
  if(d.loseCreate)process.exit(1);console.log(JSON.stringify({number:201}));}
else if(a.includes('--method')&&a.includes('POST')&&endpoint.endsWith('/comments')){
  d.posts++;d.comments.push({html_url:'https://github.com/example/test/pull/201#issuecomment-1',
    body:JSON.parse(fs.readFileSync(0,'utf8')).body});save();if(d.loseComment)process.exit(1);
  console.log(JSON.stringify(d.comments.at(-1)));}
else if(endpoint.includes('/git/ref/heads/main'))console.log(JSON.stringify({ref:'refs/heads/main',object:{type:'commit',sha:head}}));
else if(endpoint.includes('/pulls?'))console.log(JSON.stringify([d.prs.map(p=>({...pr(),...p}))]));
else if(endpoint.endsWith('/pulls/201'))console.log(JSON.stringify(pr()));
else if(endpoint.endsWith('/issues/101'))console.log(JSON.stringify({number:101,html_url:'https://github.com/example/test/issues/101',
  title:'Task',body:'Criteria',state:d.issueState.toLowerCase(),assignees:[]}));
else if(endpoint.includes('/issues/101/dependencies/'))console.log('[[]]');
else if(endpoint.includes('/issues/101/comments?'))console.log('[[]]');
else if(endpoint.includes('/issues/201/comments?'))console.log(JSON.stringify([d.comments]));
else if(endpoint.includes('/check-suites?'))console.log(JSON.stringify([{total_count:0,check_suites:[]}]));
else if(endpoint.includes('/check-runs?'))console.log(JSON.stringify([{total_count:0,check_runs:[]}]));
else if(endpoint.includes('/actions/runs?'))console.log(JSON.stringify([{total_count:0,workflow_runs:[]}]));
else if(endpoint.includes('/actions/workflows?'))console.log(JSON.stringify([{total_count:0,workflows:[]}]));
else if(endpoint.includes('/protection/required_status_checks'))console.log(JSON.stringify({contexts:[],checks:[]}));
else if(endpoint.includes('/status?'))console.log(JSON.stringify([{statuses:[]}]));
else if(endpoint.includes('/git/commits/'))console.log(JSON.stringify({tree:{sha:head}}));
else throw Error('unexpected gh request '+a.join(' '));
`);
  fs.chmodSync(path.join(x.root,'bin','gh'),0o755);
  return {remote,read:()=>JSON.parse(fs.readFileSync(remote,'utf8')),
    update:(patch:Record<string,unknown>)=>fs.writeFileSync(remote,JSON.stringify({...JSON.parse(fs.readFileSync(remote,'utf8')),...patch}))};
}
test('旧批次仅可收取历史租约；统一运行拒绝批次绑定',()=>{
  const x=setup();try {
    const binding=path.join(x.run,'binding.json');fs.writeFileSync(binding,JSON.stringify({runId:'actual-native-run',model:'large',jobs:[{jobId:x.j.id,actorName:'planner'}]}));
    const denied=x.call('bind-batch',x.statePath,binding);assert.notEqual(denied.status,0);
    assert.match(denied.stderr,/禁止旧批次模板绑定/);
    x.s.protocol=2;delete x.s.v3;fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    stageResult(x.statePath,x.j.id,{complete:true,status:'planned',evidencePath:'evidence.md',data:{planPath:'plan.json',checksPath:'plan.json'}});
    x.observe('actual-native-run/planner',x.j.id,'large');
    const result=x.call('bind-batch',x.statePath,binding);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).submitted.length,1);
    assert.equal(fs.readFileSync(x.log,'utf8').trim().split('\n').length,1);
    const again=x.call('bind-batch',x.statePath,binding);assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(again.stdout).submitted.length,0);
    assert.equal(JSON.parse(fs.readFileSync(x.statePath,'utf8')).tickets[0].phase,'plan_check');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('next 始终返回尚未派发任务，重复读取不会漏掉租约或重复预留',()=>{
  const x=setup();try {
    const a=x.call('next',x.statePath),b=x.call('next',x.statePath);assert.equal(a.status,0,a.stderr);assert.equal(b.status,0,b.stderr);
    assert.equal(JSON.parse(a.stdout).jobs[0].id,x.j.id);assert.equal(JSON.parse(b.stdout).jobs[0].id,x.j.id);
    assert.equal(JSON.parse(fs.readFileSync(x.statePath,'utf8')).jobs.length,1);
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('原命令进程终止后复用已落盘结果，不重跑验证命令',()=>{
  const x=setup();try {
    x.t.phase='verify';x.s.validationOwner=x.t.key;x.s.jobs=[];const j=e.reserve(x.s)[0];e.bind(x.s,j.id,{nativeId:'command:2147483647:1',model:j.model});
    const dir=path.join(x.run,'commands');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,createHash('sha256').update(j.id).digest('hex').slice(0,20)+'.json'),JSON.stringify({result:{model:j.model,complete:true,status:'pass',head:j.head,base:j.base,evidencePath:path.join(x.root,'evidence.md')}}));
    fs.writeFileSync(x.statePath,JSON.stringify(x.s));const r=x.call('execute',x.statePath,j.id);assert.equal(r.status,0,r.stderr);
    const saved=JSON.parse(fs.readFileSync(x.statePath,'utf8'));assert.equal(saved.tickets[0].phase,'publish');
    const p=packet(saved,{...j,action:'publish',fresh:false},x.statePath);assert.ok(p.prior.length);assert.ok(p.prior.every(item=>fs.existsSync(item.resultPath)));
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('临时测试配额保留失败证据并释放，模型切换保留已经完成的任务',()=>{
  const x=setup();try {
    const request=path.join(x.run,'experiment.json');fs.writeFileSync(request,JSON.stringify({argv:[process.execPath,'-e','process.exit(2)'],timeoutSeconds:5,reason:'red test'}));
    const run=x.call('test',x.statePath,x.j.id,request);assert.equal(run.status,0,run.stderr);const receipt=JSON.parse(run.stdout);assert.equal(receipt.exitCode,2);assert.ok(fs.existsSync(receipt.evidencePath));
    const s=JSON.parse(fs.readFileSync(x.statePath,'utf8'));assert.equal(s.jobs[0].tests,0);assert.equal(s.jobs[0].testExecution,undefined);
    s.jobs[0].status='done';fs.writeFileSync(x.statePath,JSON.stringify(s));const config=path.join(x.run,'model.json');
    x.observe('new-l1-reconfigure','$spec:execution-plan','new');
    fs.writeFileSync(config,JSON.stringify({models:{L1:'new',L2:'middle',L3:'small'},capabilities:{framework:'fixture',mainModel:'other-host',modelRouting:'per_run',models:['new','middle','small']},evidencePath:path.join(x.root,'evidence.md'),decisionNativeId:'new-l1-reconfigure'}));
    const switched=x.call('reconfigure',x.statePath,config);assert.equal(switched.status,0,switched.stderr);const saved=JSON.parse(fs.readFileSync(x.statePath,'utf8'));assert.equal(saved.inputs.models.L1,'new');assert.equal(saved.jobs[0].model,'large');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('旧运行必须对账迁移，保留旧结果并重新排队未完成审查；退役后不能复活',()=>{
  const x=setup();try {
    delete x.s.protocol;delete x.s.v3;x.j.status='done';x.j.result={model:x.j.model,complete:true,status:'planned',evidencePath:path.join(x.root,'evidence.md')};
    x.t.phase='fresh';x.t.evidence.regular={head:x.head,base:x.head,path:'old-review'};fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    assert.notEqual(x.call('next',x.statePath).status,0);
    const context=x.call('migration-context',x.statePath);assert.equal(context.status,0,context.stderr);
    const inventory=JSON.parse(context.stdout);
    const proof=path.join(x.run,'proof.json');fs.writeFileSync(proof,JSON.stringify({schemaVersion:1,
      expectedRevision:inventory.revision,inventorySha256:inventory.inventorySha256,ledgerSha256:inventory.ledgerSha256,
      evidencePath:path.join(x.root,'evidence.md'),observedAt:new Date().toISOString(),
      statusIntent:'preserve',processTreeStopped:true,externalActionsSettled:true}));
    const upgrade=x.call('upgrade',x.statePath,proof);assert.equal(upgrade.status,0,upgrade.stderr);
    const saved=JSON.parse(fs.readFileSync(x.statePath,'utf8'));assert.equal(saved.protocol,3);assert.equal(saved.v3.executionPath,'unified-v03');assert.equal(saved.tickets[0].phase,'replan');assert.deepEqual(saved.tickets[0].evidence,{});assert.equal(saved.jobs[0].result.status,'planned');
    const retire=path.join(x.run,'retire.json');fs.writeFileSync(retire,JSON.stringify({
      reason:'explicitly retire migrated fixture',evidencePath:path.join(x.root,'evidence.md')}));
    assert.equal(x.call('retire',x.statePath,retire).status,0);
    for(const operation of ['next','resume','resolve'])assert.notEqual(x.call(operation,x.statePath,proof).status,0);
    assert.equal(x.call('inspect',x.statePath).status,0);
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('认领从目标 SHA 建 worktree；评论响应不确定后恢复不会重复发布',()=>{
  const x=setup();try {
    const bare=path.join(x.run,'origin.git');git(x.root,'init','--bare',bare);git(x.root,'remote','add','origin',bare);
    fs.writeFileSync(path.join(x.root,'source'),'remote newer');git(x.root,'add','source');git(x.root,'commit','-m','new target');const target=git(x.root,'rev-parse','HEAD');
    git(x.root,'push','origin','main');git(x.root,'reset','--hard',x.head);
    const actualGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
    const shim=path.join(x.root,'bin','git');fs.writeFileSync(shim,`#!/usr/bin/env node\nconst cp=require('child_process');const a=process.argv.slice(2);if(a[0]==='remote'&&a[1]==='get-url')console.log('https://github.com/example/test.git');else{const r=cp.spawnSync(${JSON.stringify(actualGit)},a,{stdio:'inherit'});process.exit(r.status??1);}\n`);fs.chmodSync(shim,0o755);
    x.t.phase='claim';x.t.head='';x.t.base=target;x.t.worktree='';x.t.branch='';x.s.jobs=[];x.s.facts.base=target;const j=e.reserve(x.s)[0];fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    const comments=path.join(x.run,'comments.json');fs.writeFileSync(comments,'[]');
    fs.writeFileSync(path.join(x.root,'bin','gh'),`#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);const file=${JSON.stringify(comments)};const comments=JSON.parse(fs.readFileSync(file));const endpoint=a.at(-1);
if(a.includes('graphql'))console.log(JSON.stringify({data:{repository:{target:{target:{oid:'${target}'}},i100:{number:100,state:'OPEN'},i101:{number:101,state:'OPEN'}}}}));
else if(a[0]==='issue'&&a[1]==='comment'){comments.push({html_url:'https://github.com/example/test/issues/101#issuecomment-1',body:fs.readFileSync(a[a.indexOf('--body-file')+1],'utf8')});fs.writeFileSync(file,JSON.stringify(comments));console.error('uncertain response after write');process.exit(1);}
else if(endpoint.includes('/comments?'))console.log(JSON.stringify([comments]));
else if(endpoint.includes('/dependencies/'))console.log('[[]]');
else console.log(JSON.stringify({number:101,html_url:'https://github.com/example/test/issues/101',title:'Task',body:'Do task',state:'open',assignees:[]}));
`);
    const first=x.call('execute',x.statePath,j.id);assert.notEqual(first.status,0);
    const unsafe=x.call('execute',x.statePath,j.id);assert.notEqual(unsafe.status,0,'没有结果时不能只凭父 PID 消失自动重入');
    const bound=JSON.parse(fs.readFileSync(x.statePath,'utf8')).jobs[0];const proof=path.join(x.run,'stopped.json');fs.writeFileSync(proof,JSON.stringify([{jobId:j.id,nativeId:bound.nativeId,state:'stopped',processTreeStopped:true,commandDisposition:'recover',evidencePath:path.join(x.root,'evidence.md')}]));
    assert.equal(x.call('reconcile',x.statePath,proof).status,0);
    const second=x.call('execute',x.statePath,j.id);assert.equal(second.status,0,second.stderr);
    const saved=JSON.parse(fs.readFileSync(x.statePath,'utf8'));assert.equal(git(saved.tickets[0].worktree,'rev-parse','HEAD'),target);assert.equal(git(x.root,'rev-parse','HEAD'),x.head);
    assert.equal(JSON.parse(fs.readFileSync(comments,'utf8')).length,1);assert.equal(saved.tickets[0].phase,'plan');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('关闭 spec 写入成功但响应丢失后，恢复先读取状态且不重复关闭',()=>{
  const x=setup();try {
    x.s.tickets=[];x.s.jobs=[];x.s.specAudit={model:'large',complete:true,status:'complete',base:x.head,evidencePath:path.join(x.root,'evidence.md')};
    const j=e.reserve(x.s)[0];assert.equal(j.action,'spec-close');fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    const remote=path.join(x.run,'issue.json');fs.writeFileSync(remote,JSON.stringify({state:'open',closes:0}));
    fs.writeFileSync(path.join(x.root,'bin','gh'),`#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);const file=${JSON.stringify(remote)};const issue=JSON.parse(fs.readFileSync(file));
if(a.includes('graphql'))console.log(JSON.stringify({data:{repository:{target:{target:{oid:'${x.head}'}},i100:{number:100,state:issue.state.toUpperCase()}}}}));
else if(a[0]==='issue'&&a[1]==='close'){issue.state='closed';issue.closes++;fs.writeFileSync(file,JSON.stringify(issue));process.exit(1);}
else if(a.at(-1).includes('/comments?')||a.at(-1).includes('/dependencies/'))console.log('[[]]');
else console.log(JSON.stringify({number:100,html_url:'https://github.com/example/test/issues/100',title:'Spec',body:'Spec',state:issue.state,assignees:[]}));
`);
    assert.notEqual(x.call('execute',x.statePath,j.id).status,0);
    const bound=JSON.parse(fs.readFileSync(x.statePath,'utf8')).jobs[0];const proof=path.join(x.run,'stopped.json');fs.writeFileSync(proof,JSON.stringify([{jobId:j.id,nativeId:bound.nativeId,state:'stopped',processTreeStopped:true,commandDisposition:'recover',evidencePath:path.join(x.root,'evidence.md')}]));
    assert.equal(x.call('reconcile',x.statePath,proof).status,0);
    const again=x.call('execute',x.statePath,j.id);assert.equal(again.status,0,again.stderr);
    assert.equal(JSON.parse(fs.readFileSync(remote,'utf8')).closes,1);assert.equal(JSON.parse(fs.readFileSync(x.statePath,'utf8')).status,'complete');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('旧协议的已完成 agent 可以先登记原结果再升级，无需伪造停止',()=>{
  const x=setup();try {
    delete x.s.protocol;delete x.s.v3;e.bind(x.s,x.j.id,{nativeId:'old-run/planner',model:x.j.model});fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    fs.writeFileSync(x.migrationHost,JSON.stringify({actors:{[x.j.id]:'completed'}}));
    const result=path.join(x.run,'legacy-result.json');fs.writeFileSync(result,JSON.stringify({model:x.j.model,complete:true,status:'planned',evidencePath:path.join(x.root,'evidence.md'),head:x.j.head,base:x.j.base,data:{planPath:path.join(x.root,'plan.json'),checksPath:path.join(x.root,'plan.json')}}));
    const submitted=x.call('submit',x.statePath,x.j.id,result);assert.equal(submitted.status,0,submitted.stderr);
    const inventory=JSON.parse(x.call('migration-context',x.statePath).stdout);
    const proof=path.join(x.run,'proof.json');fs.writeFileSync(proof,JSON.stringify({schemaVersion:1,
      expectedRevision:inventory.revision,inventorySha256:inventory.inventorySha256,ledgerSha256:inventory.ledgerSha256,
      evidencePath:path.join(x.root,'evidence.md'),observedAt:new Date().toISOString(),
      statusIntent:'preserve',processTreeStopped:true,externalActionsSettled:true}));
    const upgraded=x.call('upgrade',x.statePath,proof);assert.equal(upgraded.status,0,upgraded.stderr);
    const saved=JSON.parse(fs.readFileSync(x.statePath,'utf8'));assert.equal(saved.jobs[0].status,'done');assert.equal(saved.tickets[0].phase,'plan_check');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('最终 spec 核验可在冻结目标 SHA 的隔离目录运行测试，保持主目录不变',()=>{
  const x=setup();try {
    fs.writeFileSync(path.join(x.root,'source'),'new target');git(x.root,'add','source');git(x.root,'commit','-m','target advanced');const target=git(x.root,'rev-parse','HEAD');git(x.root,'reset','--hard',x.head);
    x.s.tickets=[];x.s.jobs=[];x.s.facts.base=target;const j=e.reserve(x.s)[0];fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    const request=path.join(x.run,'audit-test.json');fs.writeFileSync(request,JSON.stringify({argv:[process.execPath,'-e',"require('assert').equal(require('fs').readFileSync('source','utf8'),'new target')"],timeoutSeconds:5,reason:'cross-ticket acceptance'}));
    const result=x.call('test',x.statePath,j.id,request);assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.exitCode,0);assert.equal(receipt.head,target);assert.equal(git(x.root,'rev-parse','HEAD'),x.head);
    assert.equal(git(x.root,'worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).length,2);
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('确认命令进程树已停止后可取消并退役，无须重新执行外部动作',()=>{
  const x=setup();try {
    x.t.phase='verify';x.s.jobs=[];const j=e.reserve(x.s)[0];e.bind(x.s,j.id,{nativeId:'command:2147483647:1',model:j.model});fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    const status=path.join(x.run,'stopped.json');fs.writeFileSync(status,JSON.stringify([{jobId:j.id,nativeId:j.nativeId,state:'stopped',processTreeStopped:true,commandDisposition:'cancel',evidencePath:path.join(x.root,'evidence.md')}]));
    const cancel=x.call('reconcile',x.statePath,status);assert.equal(cancel.status,0,cancel.stderr);
    const proof=path.join(x.run,'retire.json');fs.writeFileSync(proof,JSON.stringify({reason:'stop this run',evidencePath:path.join(x.root,'evidence.md')}));
    const result=x.call('retire',x.statePath,proof);assert.equal(result.status,0,result.stderr);assert.ok(fs.existsSync(x.t.worktree));
    assert.equal(JSON.parse(fs.readFileSync(x.statePath,'utf8')).jobs[0].status,'cancelled');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('公开 CLI 创建 PR 与完成评论遇响应丢失后按稳定操作标记对账',()=>{
  const x=setup();try {
    // This focused operation-intent fixture predates bound author reviews; the
    // full v3 replay above proves the same lost-response path with live review.
    const remote=deliveryRemote(x,{state:'OPEN'});remote.update({loseCreate:true,loseComment:true});
    x.s.jobs=[];x.t.phase='publish';x.s.validationOwner=x.t.key;
    x.t.evidence.self={head:x.head,base:x.head,path:path.join(x.root,'evidence.md')};
    x.t.evidence.tests={head:x.head,base:x.head,path:path.join(x.root,'evidence.md'),
      testedHead:x.head,testedTree:git(x.root,'rev-parse','HEAD^{tree}'),targetBase:x.head};
    const j=e.reserve(x.s)[0];j.nativeId='native-publisher';j.status='running';
    delete x.s.v3!.skillBindings;fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    const body=path.join(x.run,'body.md'),completion=path.join(x.run,'completion.md'),request=path.join(x.run,'publish-request.json');
    fs.writeFileSync(body,'Implements issue criteria.');fs.writeFileSync(completion,'Author checks complete.');
    fs.writeFileSync(request,JSON.stringify({title:'Deliver task',bodyPath:body,completionPath:completion}));
    const first=x.call('publish-pr',x.statePath,j.id,request);assert.equal(first.status,0,first.stderr);
    const second=x.call('publish-pr',x.statePath,j.id,request);assert.equal(second.status,0,second.stderr);
    assert.equal(remote.read().creates,1);assert.equal(remote.read().posts,1);
    assert.equal(JSON.parse(first.stdout).data.operationId,JSON.parse(second.stdout).data.operationId);
    assert.match(remote.read().prs[0].body,/spec-delivery:cli-fixture:101:pr:/);
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('公开 CLI 的无 CI 豁免要求当前 PR 空检查及远端空工作流清单',()=>{
  const x=setup();try {
    deliveryRemote(x,{state:'OPEN'});
    x.s.jobs=[];x.t.phase='accept';x.t.pr=201;x.s.validationOwner=x.t.key;
    const j=e.reserve(x.s)[0];fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    const request=path.join(x.run,'ci-request.json');fs.writeFileSync(request,JSON.stringify({reason:'no_ci'}));
    const result=x.call('ci-attest',x.statePath,j.id,request);assert.equal(result.status,0,result.stderr);
    const body=JSON.parse(result.stdout);assert.equal(body.ciWaiver.verification,'remote');
    assert.equal(body.ciConfigured,false);assert.ok(fs.existsSync(body.ciWaiver.evidence));
    const ledger=JSON.parse(fs.readFileSync(x.statePath,'utf8'));
    assert.equal(ledger.ciAttestations[0].path,body.ciWaiver.evidence);
    assert.equal(ledger.ciAttestations[0].sha256,
      createHash('sha256').update(fs.readFileSync(body.ciWaiver.evidence)).digest('hex'));
    const invalid=path.join(x.run,'billing.json');fs.writeFileSync(invalid,JSON.stringify({reason:'billing',notStartedIds:[]}));
    assert.notEqual(x.call('ci-attest',x.statePath,j.id,invalid).status,0);
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('合并响应不确定时复用固定意图，远端已合并则不再写入',()=>{
  const x=setup();try {
    const remote=deliveryRemote(x,{state:'OPEN'});
    x.t.phase='merge';x.t.pr=201;x.s.validationOwner=x.t.key;
    const j=x.j;j.action='merge';j.nativeId='native-merger';j.status='running';fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    const request=path.join(x.run,'merge-request.json');fs.writeFileSync(request,JSON.stringify({strategy:'merge'}));
    assert.notEqual(x.call('merge-pr',x.statePath,j.id,request).status,0,'缺少审查和验收不能发起合并');
    const attempt=path.join(x.run,'actions',createHash('sha256').update(j.id).digest('hex').slice(0,20)+'.merge.attempt.json');
    fs.writeFileSync(attempt,JSON.stringify({operationId:'persisted-before-lost-response'}));
    const pending=x.call('merge-pr',x.statePath,j.id,request);assert.equal(pending.status,0,pending.stderr);
    assert.equal(JSON.parse(pending.stdout).status,'waiting_merge');assert.equal(remote.read().merges,0);
    remote.update({state:'MERGED'});
    const result=x.call('merge-pr',x.statePath,j.id,request);assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).status,'merged');assert.equal(remote.read().merges,0);
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('PR 创建请求是否生效未知且远端未出现时，不重发同一写请求',()=>{
  const x=setup();try {
    const remote=deliveryRemote(x,{state:'OPEN'});remote.update({dropCreate:true});
    x.s.jobs=[];x.t.phase='publish';x.s.validationOwner=x.t.key;
    x.t.evidence.self={head:x.head,base:x.head,path:path.join(x.root,'evidence.md')};
    x.t.evidence.tests={head:x.head,base:x.head,path:path.join(x.root,'evidence.md')};
    const j=e.reserve(x.s)[0];j.nativeId='native-publisher';j.status='running';
    delete x.s.v3!.skillBindings;fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    const body=path.join(x.run,'body.md'),completion=path.join(x.run,'completion.md'),request=path.join(x.run,'request.json');
    fs.writeFileSync(body,'body');fs.writeFileSync(completion,'completion');
    fs.writeFileSync(request,JSON.stringify({title:'PR',bodyPath:body,completionPath:completion}));
    assert.notEqual(x.call('publish-pr',x.statePath,j.id,request).status,0);
    const retry=x.call('publish-pr',x.statePath,j.id,request);assert.notEqual(retry.status,0);
    assert.match(retry.stderr,/不能盲目重发/);assert.equal(remote.read().creates,1);
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('公开 CLI 清理前再次读取 MERGED+CLOSED，并保留脏 worktree',()=>{
  const x=setup();try {
    const remote=deliveryRemote(x,{state:'MERGED'});remote.update({issueState:'CLOSED'});
    x.s.jobs=[];x.t.phase='cleanup';x.t.pr=201;x.s.validationOwner=undefined;
    const j=e.reserve(x.s)[0];assert.equal(j.action,'cleanup');
    fs.writeFileSync(path.join(x.t.worktree,'uncommitted.txt'),'keep this work');
    fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    const result=x.call('execute',x.statePath,j.id);assert.notEqual(result.status,0);
    assert.match(result.stderr,/未保存|worktree/);
    assert.ok(fs.existsSync(path.join(x.t.worktree,'uncommitted.txt')));
    assert.equal(remote.read().state,'MERGED');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
