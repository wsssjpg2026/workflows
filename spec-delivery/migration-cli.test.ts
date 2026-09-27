import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as engine from './core.ts';

const entry=fileURLToPath(new URL('../spec-delivery.workflow.ts',import.meta.url));
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function fixture(protocol:undefined|2|3,status:engine.State['status']='paused') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-migration-'));
  const run=path.join(root,'.agents','workflow-runs','historical');fs.mkdirSync(run,{recursive:true});
  for(const name of ['implement','diagnosing-bugs','code-review','code-review-from-claude','handoff']) {
    const dir=path.join(root,'.agents','skills',name);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'SKILL.md'),`---\nname: ${name}\n---\n\nFixture skill.\n`);
  }
  const statePath=path.join(run,'state.json'),evidence=path.join(run,'operator-observation.md');
  fs.writeFileSync(evidence,'Operator queried host jobs and command descendants; all recorded work is terminal.\n');
  const ticket=engine.buildTicket({number:101,kind:'software',dependencies:[],criteria:['legacy criterion'],visual:false},'a'.repeat(40));
  ticket.phase='fresh';ticket.head='b'.repeat(40);ticket.base='a'.repeat(40);
  ticket.worktree=path.join(root,'.agents','worktrees','historical');
  ticket.evidence.regular={head:ticket.head,base:ticket.base,path:'legacy-regular.md'};
  const session:engine.NativeSession={source:'native_host',observationId:'old-observation',jobId:'old-review',
    nativeId:'old-host/actor',provider:'old-provider',model:'old-model',
    observedAt:'2026-09-27T00:00:00.000Z',evidencePath:'old-host-event.json',evidenceDigest:'old-digest'};
  const job:engine.Job={id:'old-review',ticket:'101',epoch:1,action:'review-lens',part:'0',tier:'L2',
    model:'old-model',executor:'agent',fresh:false,contextKey:'old-context',head:ticket.head,base:ticket.base,
    tests:0,status:'done',nativeId:session.nativeId,session,
    result:{model:'old-model',complete:true,status:'reviewed',evidencePath:'old-review.md',
      findings:[{id:'legacy-finding',description:'historical observation',evidence:'old-review.md',confidence:42}]}};
  const v3=protocol===3?engine.initialProtocolV3():undefined;
  if(v3)v3.executionPath='legacy-v02';
  const state:engine.State={schema:1,...(protocol===undefined?{}:{protocol}),...(v3?{v3}:{}),
    id:'historical-run',revision:7,inputs:{spec:100,targetBranch:'main',models:{L1:'large',L2:'middle',L3:'small'}},
    spec:100,repo:{root,slug:'example/test',host:'github.com',defaultBranch:'main'},status,
    policy:{agents:4,issues:2,tests:1,noProgress:2,rounds:3},capabilities:{framework:'fixture',modelRouting:'per_agent',models:['large','middle','small']},
    specCriteria:['legacy criterion'],planEvidence:'old-plan.md',tickets:[ticket],jobs:[job],
    facts:{base:'a'.repeat(40),issueStates:{100:'OPEN',101:'OPEN'},prs:{},at:''},auditEpoch:1,events:[]};
  fs.writeFileSync(statePath,JSON.stringify(state,null,2)+'\n');
  const gh=path.join(root,'bin','gh');fs.mkdirSync(path.dirname(gh),{recursive:true});
  fs.writeFileSync(gh,`#!/usr/bin/env node\nconst a=process.argv.slice(2);if(!a.includes('graphql'))process.exit(2);\nconsole.log(JSON.stringify({data:{repository:{target:{target:{oid:'${'a'.repeat(40)}'}},i100:{number:100,state:'OPEN'},i101:{number:101,state:'OPEN'}}}}));\n`);
  fs.chmodSync(gh,0o755);
  const observer=path.join(root,'bin','observer');
  fs.writeFileSync(observer,`#!/usr/bin/env node\nconst [op,id,job]=process.argv.slice(2);if(op!=='observe'||id!=='resume-l1'||job!=='$resume')process.exit(2);\nconsole.log(JSON.stringify({source:'native_host',observationId:'resume-observation',jobId:job,nativeId:id,provider:'fixture',model:'large',observedAt:new Date().toISOString(),context:{contextId:'resume-context',mode:'new',proofId:'resume-proof'}}));\n`);
  fs.chmodSync(observer,0o755);
  const hostStatusFile=path.join(run,'controlled-host-state.json');
  fs.writeFileSync(hostStatusFile,JSON.stringify({actors:{'old-review':'completed'},tokens:{},
    processTree:'stopped',externalActions:'settled'}));
  const migrationObserver=path.join(root,'bin','migration-observer');
  fs.writeFileSync(migrationObserver,`#!/usr/bin/env node
const fs=require('fs'), path=require('path');
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const state=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const live=JSON.parse(fs.readFileSync(${JSON.stringify(hostStatusFile)},'utf8'));
const record=(name)=>'controlled-host-query:'+name+':'+Date.now();
const actors=state.jobs.filter(j=>j.executor==='agent'&&j.nativeId).map(j=>({jobId:j.id,nativeId:j.nativeId,
  state:live.actors[j.id]||'unknown',observationId:record('actor:'+j.id)}));
const dispatches=(state.v3?.dispatchRecords||[]).map(d=>({token:d.token,jobId:d.jobId,targetHost:d.targetHost,
  state:live.tokens[d.token]||'unknown',nativeId:d.nativeId,
  authoritative:(live.tokens[d.token]||'unknown')==='not_found',observationId:record('token:'+d.token)}));
const instances=[...(state.v3?.dispatchRecords||[]).flatMap(d=>d.instances),...(state.v3?.detachedInstances||[])]
  .filter(i=>i.nativeId).map(i=>({key:i.key,nativeId:i.nativeId,state:live.instances?.[i.key]||'unknown',
    observationId:record('instance:'+i.key)}));
const processes=state.jobs.flatMap(j=>{const result=[];
  const pid=Number(j.nativeId.match(/^command:(\\d+):/)?.[1]);
  if(pid)result.push({jobId:j.id,kind:'command',pid,state:live.processes?.[pid]||'unknown',
    descendantsStopped:live.processes?.[pid]==='stopped',observationId:record('command:'+pid)});
  if(j.testExecution?.pid)result.push({jobId:j.id,kind:'test',pid:j.testExecution.pid,
    state:live.processes?.[j.testExecution.pid]||'unknown',
    descendantsStopped:live.processes?.[j.testExecution.pid]==='stopped',
    observationId:record('test:'+j.testExecution.pid)});
  for(const history of j.testProcessHistory||[])result.push({jobId:j.id,kind:'test',pid:history.pid,
    state:live.processes?.[history.pid]||'unknown',
    descendantsStopped:live.processes?.[history.pid]==='stopped',
    observationId:record('test-history:'+history.pid)});
  return result;});
for(const d of state.v3?.dispatchRecords||[])if(d.operationPid)processes.push({jobId:d.jobId,
  kind:'dispatch',pid:d.operationPid,state:live.processes?.[d.operationPid]||'unknown',
  descendantsStopped:live.processes?.[d.operationPid]==='stopped',
  observationId:record('dispatch:'+d.operationPid)});
console.log(JSON.stringify({source:'native_host',schemaVersion:1,challenge:request.challenge,runId:request.runId,
  inventorySha256:request.inventorySha256,ledgerSha256:request.ledgerSha256,observedAt:new Date().toISOString(),
  actors,dispatches,instances,processes,
  processTree:{state:live.processTree,unknownChildren:live.processTree==='stopped'?0:1,
    observationId:record('process-tree')},
  externalActions:{state:live.externalActions,unknown:live.externalActions==='settled'?0:1,
    observationId:record('external-actions')}}));
`);
  fs.chmodSync(migrationObserver,0o755);
  const env={...process.env,HOME:root,PATH:path.join(root,'bin')+path.delimiter+process.env.PATH,
    SPEC_DELIVERY_HOST_OBSERVER:observer,SPEC_DELIVERY_MIGRATION_OBSERVER:migrationObserver};
  const call=(...args:string[])=>spawnSync(process.execPath,[entry,...args],{cwd:root,env,encoding:'utf8'});
  const context=()=>{const r=call('migration-context',statePath);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const decision=()=>{const c=context();const file=path.join(run,'migration-decision.json');
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,expectedRevision:c.revision,
      inventorySha256:c.inventorySha256,ledgerSha256:c.ledgerSha256,evidencePath:evidence,
      observedAt:new Date().toISOString(),statusIntent:'preserve',
      processTreeStopped:true,externalActionsSettled:true,replacements:{}}));return file;};
  const writeState=(value:engine.State)=>fs.writeFileSync(statePath,JSON.stringify(value,null,2)+'\n');
  return {root,run,statePath,state,evidence,hostStatusFile,call,context,decision,writeState,
    read:()=>JSON.parse(fs.readFileSync(statePath,'utf8')) as engine.State,
    cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('旧协议 1/2 原字节备份、原模型证据和完成结果保留；部分审查重新规划',()=>{
  for(const protocol of [undefined,2] as const) {
    const x=fixture(protocol);try {
      const original=fs.readFileSync(x.statePath);
      for(const op of ['summary','inspect','metrics','migration-context'])
        assert.equal(x.call(op,x.statePath).status,0,op);
      assert.deepEqual(fs.readFileSync(x.statePath),original,'离线读取不得写账本');
      assert.notEqual(x.call('next',x.statePath).status,0);
      const migration=x.call('upgrade',x.statePath,x.decision());assert.equal(migration.status,0,migration.stderr);
      const output=JSON.parse(migration.stdout),saved=x.read();
      assert.deepEqual(fs.readFileSync(output.backupPath),original);
      assert.equal(output.backupSha256,sha(original));
      assert.equal(saved.migrations?.[0].backupSha256,sha(original));
      assert.equal(saved.migrations?.[0].hostObservationSha256,
        sha(fs.readFileSync(saved.migrations![0].hostObservationPath)));
      assert.equal(saved.v3?.executionPath,'unified-v03');
      assert.equal(saved.status,'paused');assert.equal(saved.tickets[0].phase,'replan');
      assert.deepEqual(saved.tickets[0].evidence,{});assert.equal(saved.tickets[0].authorReview,undefined);
      assert.deepEqual(saved.jobs[0],x.state.jobs[0]);
      assert.equal(saved.jobs[0].session?.provider,'old-provider');
      assert.equal(JSON.parse(x.call('summary',x.statePath).stdout).schemaVersion,1);
      assert.equal(JSON.parse(x.call('migration-context',x.statePath).stdout).status,'paused');
    }finally{x.cleanup();}
  }
});

test('过渡 v3 缺绑定只读；停稳后显式 migrate-skills 才有统一新执行路径',()=>{
  const x=fixture(3);try {
    const original=fs.readFileSync(x.statePath);
    const next=x.call('next',x.statePath);assert.notEqual(next.status,0);
    assert.match(next.stderr,/migrate-skills/);assert.deepEqual(fs.readFileSync(x.statePath),original);
    const request=x.decision(),migrated=x.call('migrate-skills',x.statePath,request);
    assert.equal(migrated.status,0,migrated.stderr);
    const saved=x.read();assert.equal(saved.v3?.executionPath,'unified-v03');
    assert.equal(saved.v3?.skillBindings?.length,5);assert.equal(saved.status,'paused');
    assert.equal(saved.tickets[0].phase,'replan');assert.deepEqual(saved.tickets[0].evidence,{});
    assert.deepEqual(fs.readFileSync(JSON.parse(migrated.stdout).backupPath),original);
    assert.deepEqual(saved.jobs[0],x.state.jobs[0]);
  }finally{x.cleanup();}
});

test('在途 actor、测试、子任务、不确定 token 与未绑定实例都阻止迁移，失败不备份',()=>{
  const cases:[string,(s:engine.State)=>void][]=[
    ['actor',s=>{s.jobs[0].status='running';}],
    ['test process',s=>{s.jobs[0].testExecution={pid:2147483647,granted:true,startedAt:new Date().toISOString()};}],
    ['cancelled process',s=>{s.jobs[0].status='cancelled';delete s.jobs[0].result;}],
    ['child',s=>{s.v3!.skillChildren=[{id:'child',parentInvocationId:'parent',key:'check',instruction:'check',tier:'L2',
      model:'middle',required:true,independent:true,fresh:true,candidateVersion:'v',inputVersion:'v',head:'h',base:'b',
      jobIds:[],pending:true,requestedAt:new Date().toISOString()}];}],
    ['uncertain token',s=>{s.v3!.dispatchRecords=[{jobId:'old-review',attempt:1,token:'token-1',targetHost:'fixture',
      requestedModel:'old-model',packetPath:'',requestPath:'',requestDigest:'',status:'uncertain',
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[],instances:[]}];}],
    ['in-flight operation',s=>{s.v3!.dispatchRecords=[{jobId:'old-review',attempt:1,token:'token-2',targetHost:'fixture',
      requestedModel:'old-model',packetPath:'',requestPath:'',requestDigest:'',status:'prepared',operationPid:2147483647,
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[],instances:[]}];}],
    ['unbound instance',s=>{s.v3!.detachedInstances=[{key:'native:unbound',nativeId:'unbound',targetHost:'fixture',
      state:'unknown',firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),events:[]}];}],
  ];
  for(const [name,mutate] of cases){const x=fixture(3);try {
    mutate(x.state);x.writeState(x.state);const request=x.decision(),before=fs.readFileSync(x.statePath);
    if(name==='cancelled process'){
      const host=JSON.parse(fs.readFileSync(x.hostStatusFile,'utf8'));
      host.actors['old-review']='running';fs.writeFileSync(x.hostStatusFile,JSON.stringify(host));
    }
    const result=x.call('migrate-skills',x.statePath,request);
    assert.notEqual(result.status,0,`${name}: ${result.stderr}`);
    assert.deepEqual(fs.readFileSync(x.statePath),before,name);
    assert.equal(fs.existsSync(path.join(x.run,'migrations')),false,name);
  }finally{x.cleanup();}}
});

test('过期 revision/账本指纹及缺少停稳依据均不产生备份',()=>{
  const x=fixture(2);try {
    const file=x.decision(),original=fs.readFileSync(x.statePath);
    const decision=JSON.parse(fs.readFileSync(file,'utf8'));
    decision.expectedRevision--;
    fs.writeFileSync(file,JSON.stringify(decision));assert.notEqual(x.call('upgrade',x.statePath,file).status,0);
    decision.expectedRevision++;decision.processTreeStopped=false;
    fs.writeFileSync(file,JSON.stringify(decision));assert.notEqual(x.call('upgrade',x.statePath,file).status,0);
    decision.processTreeStopped=true;decision.ledgerSha256='0'.repeat(64);
    fs.writeFileSync(file,JSON.stringify(decision));assert.notEqual(x.call('upgrade',x.statePath,file).status,0);
    assert.deepEqual(fs.readFileSync(x.statePath),original);
    assert.equal(fs.existsSync(path.join(x.run,'migrations')),false);
  }finally{x.cleanup();}
});

test('账本已完成但宿主仍运行的 actor/token 阻断迁移；缺可信 observer 同样拒绝',()=>{
  for(const mode of ['actor','token','test-descendant','missing-observer'] as const) {
    const x=fixture(3);try {
      const live=JSON.parse(fs.readFileSync(x.hostStatusFile,'utf8'));
      if(mode==='actor')live.actors['old-review']='running';
      if(mode==='token') {
        const eventPath=path.join(x.run,'terminal-host-event.json');fs.writeFileSync(eventPath,'{"state":"completed"}\n');
        const event={kind:'query' as const,evidencePath:eventPath,digest:sha(fs.readFileSync(eventPath)),
          at:new Date().toISOString()};
        x.state.v3!.dispatchRecords=[{jobId:'old-review',attempt:1,token:'old-token',targetHost:'fixture',
          requestedModel:'old-model',packetPath:'',requestPath:'',requestDigest:'',status:'completed',
          nativeId:'old-host/actor',createdAt:event.at,updatedAt:event.at,events:[event],
          instances:[{key:'native:old-host/actor',nativeId:'old-host/actor',state:'completed',
            firstSeenAt:event.at,lastSeenAt:event.at,events:[event]}]}];
        x.writeState(x.state);
        live.tokens['old-token']='running';live.instances={'native:old-host/actor':'completed'};
      }
      if(mode==='test-descendant') {
        x.state.jobs[0].testProcessHistory=[{pid:54321,kind:'reconciled',evidencePath:x.evidence,
          evidenceSha256:sha(fs.readFileSync(x.evidence)),at:new Date().toISOString()}];
        x.writeState(x.state);live.processes={54321:'running'};
      }
      fs.writeFileSync(x.hostStatusFile,JSON.stringify(live));
      if(mode==='missing-observer')fs.unlinkSync(path.join(x.root,'bin','migration-observer'));
      const decision=x.decision(),original=fs.readFileSync(x.statePath);
      const result=x.call('migrate-skills',x.statePath,decision);
      assert.notEqual(result.status,0,`${mode}: ${result.stderr}`);
      assert.deepEqual(fs.readFileSync(x.statePath),original,mode);
      assert.equal(fs.existsSync(path.join(x.run,'migrations')),false,mode);
    }finally{x.cleanup();}
  }
});

test('paused/waiting_human/complete/retired 保持状态；恢复需独立 L1 继续决定',()=>{
  for(const status of ['paused','waiting_human','complete','retired'] as const) {
    const x=fixture(2,status);try {
      if(status==='retired') {
        assert.notEqual(x.call('upgrade',x.statePath,x.decision()).status,0);
        assert.equal(x.read().status,'retired');continue;
      }
      const migrated=x.call('upgrade',x.statePath,x.decision());assert.equal(migrated.status,0,migrated.stderr);
      assert.equal(x.read().status,status);
      const unproved=x.call('resume',x.statePath);assert.notEqual(unproved.status,0);
      assert.equal(x.read().status,status);
      if(status==='complete')continue;
      const saved=x.read(),resumePath=path.join(x.run,'resume.json');
      fs.writeFileSync(resumePath,JSON.stringify({schemaVersion:1,expectedRevision:saved.revision,
        expectedStatus:status,kind:status==='paused'?'user_resume':'human_condition_resolved',
        inputVersion:engine.inputVersion(saved),decisionNativeId:'resume-l1',evidencePath:x.evidence,
        reason:'The user explicitly continued after reviewing the migrated run.'}));
      if(status==='waiting_human') {
        assert.notEqual(x.call('resume',x.statePath,resumePath).status,0);
        assert.equal(x.read().status,'waiting_human');
      }else {
        const resumed=x.call('resume',x.statePath,resumePath);assert.equal(resumed.status,0,resumed.stderr);
        assert.equal(x.read().status,'running');assert.equal(x.read().continuations?.length,1);
      }
    }finally{x.cleanup();}
  }
});
