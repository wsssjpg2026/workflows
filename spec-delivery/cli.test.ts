import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as e from './core.ts';
import { stageResult } from '../spec-delivery.workflow.ts';
const entry=fileURLToPath(new URL('../spec-delivery.workflow.ts',import.meta.url));
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function setup() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-cli-'));git(root,'init','-b','main');git(root,'config','user.email','test@example.invalid');git(root,'config','user.name','Workflow Test');
  fs.writeFileSync(path.join(root,'source'),'base');git(root,'add','source');git(root,'commit','-m','base');const head=git(root,'rev-parse','HEAD');
  fs.mkdirSync(path.join(root,'.agents','worktrees'),{recursive:true});const wt=path.join(root,'.agents','worktrees','task');git(root,'worktree','add','-b','task',wt,head);
  fs.appendFileSync(path.join(root,'.git','info','exclude'),'\n/.agents/\n/bin/\n/evidence.md\n/plan.json\n');
  const run=path.join(root,'.agents','workflow-runs','test');fs.mkdirSync(run,{recursive:true});const statePath=path.join(run,'state.json');
  const s:e.State={schema:1,protocol:2,id:'cli-fixture',revision:0,inputs:{spec:100,targetBranch:'main',models:{L1:'large',L2:'middle',L3:'small'}},spec:100,repo:{root,slug:'example/test',host:'github.com',defaultBranch:'main'},status:'running',policy:{agents:8,issues:3,tests:1,noProgress:3,rounds:4},tickets:[],jobs:[],specCriteria:['done'],planEvidence:'',auditEpoch:1,events:[],facts:{base:head,issueStates:{100:'OPEN',101:'OPEN'},prs:{},at:''}};
  const t=e.buildTicket({number:101,kind:'software',dependencies:[],criteria:['done'],visual:false},head);t.phase='plan';t.head=head;t.branch='task';t.worktree=wt;s.tickets.push(t);
  const j=e.reserve(s)[0];fs.writeFileSync(statePath,JSON.stringify(s));
  fs.mkdirSync(path.join(root,'bin'));const log=path.join(run,'gh.log');
  fs.writeFileSync(path.join(root,'bin','gh'),`#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'call\\n');console.log(JSON.stringify({data:{repository:{target:{target:{oid:'${head}'}},i100:{number:100,state:'OPEN'},i101:{number:101,state:'OPEN'}}}}));\n`);fs.chmodSync(path.join(root,'bin','gh'),0o755);
  fs.writeFileSync(path.join(root,'evidence.md'),'actual evidence');fs.writeFileSync(path.join(root,'plan.json'),'{}');
  const env={...process.env,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH};
  const call=(...args:string[])=>spawnSync(process.execPath,[entry,...args],{cwd:root,env,encoding:'utf8'});
  return {root,run,head,s,t,j,statePath,log,call};
}
test('真实 CLI 批次绑定收取已有结果，只查询一次易变事实并可重复调用',()=>{
  const x=setup();try {
    stageResult(x.statePath,x.j.id,{complete:true,status:'planned',evidencePath:'evidence.md',data:{planPath:'plan.json',checksPath:'plan.json'}});
    const binding=path.join(x.run,'binding.json');fs.writeFileSync(binding,JSON.stringify({runId:'actual-native-run',model:'large',jobs:[{jobId:x.j.id,actorName:'planner'}]}));
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
    assert.equal(JSON.parse(fs.readFileSync(x.statePath,'utf8')).tickets[0].phase,'publish');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('临时测试配额保留失败证据并释放，模型切换保留已经完成的任务',()=>{
  const x=setup();try {
    const request=path.join(x.run,'experiment.json');fs.writeFileSync(request,JSON.stringify({argv:[process.execPath,'-e','process.exit(2)'],timeoutSeconds:5,reason:'red test'}));
    const run=x.call('test',x.statePath,x.j.id,request);assert.equal(run.status,0,run.stderr);const receipt=JSON.parse(run.stdout);assert.equal(receipt.exitCode,2);assert.ok(fs.existsSync(receipt.evidencePath));
    const s=JSON.parse(fs.readFileSync(x.statePath,'utf8'));assert.equal(s.jobs[0].tests,0);assert.equal(s.jobs[0].testExecution,undefined);
    s.jobs[0].status='done';fs.writeFileSync(x.statePath,JSON.stringify(s));const config=path.join(x.run,'model.json');fs.writeFileSync(config,JSON.stringify({models:{L1:'new',L2:'middle',L3:'small'},capabilities:{framework:'fixture',mainModel:'new',modelRouting:'per_run',models:['new','middle','small']},evidencePath:path.join(x.root,'evidence.md')}));
    const switched=x.call('reconfigure',x.statePath,config);assert.equal(switched.status,0,switched.stderr);const saved=JSON.parse(fs.readFileSync(x.statePath,'utf8'));assert.equal(saved.inputs.models.L1,'new');assert.equal(saved.jobs[0].model,'large');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('旧运行必须对账迁移，保留旧结果并重新排队未完成审查；退役后不能复活',()=>{
  const x=setup();try {
    delete x.s.protocol;x.j.status='done';x.j.result={model:x.j.model,complete:true,status:'planned',evidencePath:path.join(x.root,'evidence.md')};
    x.t.phase='fresh';x.t.evidence.regular={head:x.head,base:x.head,path:'old-review'};fs.writeFileSync(x.statePath,JSON.stringify(x.s));
    assert.notEqual(x.call('next',x.statePath).status,0);
    const proof=path.join(x.run,'proof.json');fs.writeFileSync(proof,JSON.stringify({evidencePath:path.join(x.root,'evidence.md'),reason:'run replaced'}));
    const upgrade=x.call('upgrade',x.statePath,proof);assert.equal(upgrade.status,0,upgrade.stderr);
    const saved=JSON.parse(fs.readFileSync(x.statePath,'utf8'));assert.equal(saved.protocol,2);assert.equal(saved.tickets[0].phase,'queued');assert.deepEqual(saved.tickets[0].evidence,{});assert.equal(saved.jobs[0].result.status,'planned');
    assert.equal(x.call('retire',x.statePath,proof).status,0);
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
    const again=x.call('execute',x.statePath,j.id);assert.equal(again.status,0,again.stderr);
    assert.equal(JSON.parse(fs.readFileSync(remote,'utf8')).closes,1);assert.equal(JSON.parse(fs.readFileSync(x.statePath,'utf8')).status,'complete');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
