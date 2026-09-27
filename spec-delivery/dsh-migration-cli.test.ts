import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as engine from './core.ts';

const entry=fileURLToPath(new URL('../spec-delivery.workflow.ts',import.meta.url));
const adapter=fileURLToPath(new URL('./adapters/dsh.mjs',import.meta.url));
const zstd=execFileSync('which',['zstd'],{encoding:'utf8'}).trim();
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

function fixture(logicalCancelled=false){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-legacy-migration-'));
  const run=path.join(root,'.agents','workflow-runs','legacy');fs.mkdirSync(run,{recursive:true});
  for(const name of ['implement','diagnosing-bugs','code-review','code-review-from-claude','handoff']){
    const dir=path.join(root,'.agents','skills',name);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'SKILL.md'),`---\nname: ${name}\n---\n\nIsolated migration fixture.\n`);
  }
  const nativeId='legacy-review-one/session-11111111-2222-3333-4444-555555555555';
  const home=path.join(root,'legacy-host','runs','legacy-review-one');
  const sessionDir=path.join(home,'sessions','--fixture--',nativeId.split('/')[1]);
  fs.mkdirSync(sessionDir,{recursive:true});
  const log=path.join(sessionDir,'session.v3.jsonl.zstd'),plain=path.join(root,'session.jsonl');
  const historicalStart=Date.now()-60*60*1000;
  fs.writeFileSync(plain,[{type:'session',id:nativeId.split('/')[1],createdAt:historicalStart,cwd:root},
    {type:'assistant/message',data:{message:{role:'assistant',source:{kind:'model',provider:'old-provider',model:'old-model'},
      content:[{type:'text',text:'Completed historical review.'}]},usage:{inputTokens:4,outputTokens:3}}},
    {type:'turn/end'}]
    .map(x=>JSON.stringify(x)).join('\n')+'\n');
  assert.equal(spawnSync(zstd,['-q','-f',plain,'-o',log]).status,0);
  fs.writeFileSync(path.join(home,'started-at'),new Date(historicalStart).toISOString()+'\n');
  fs.writeFileSync(path.join(home,'finished-at'),new Date(historicalStart+1000).toISOString()+'\n');
  fs.writeFileSync(path.join(home,'exit-code'),'0\n');
  const ticket=engine.buildTicket({number:101,kind:'software',dependencies:[],criteria:['legacy criterion'],visual:false},'a'.repeat(40));
  ticket.phase='fresh';ticket.head='b'.repeat(40);ticket.base='a'.repeat(40);
  ticket.worktree=path.join(root,'.agents','worktrees','legacy');
  ticket.evidence.regular={head:ticket.head,base:ticket.base,path:'old-regular.md'};
  const job:engine.Job={id:'old-review',ticket:'101',epoch:1,action:'review-lens',part:'0',tier:'L2',
    model:'old-provider/old-model',executor:'agent',fresh:false,contextKey:'old-context',
    head:ticket.head,base:ticket.base,tests:0,status:logicalCancelled?'cancelled':'done',nativeId,
    ...(logicalCancelled?{cancelledReason:'terminal stage was rejected by result validation'}:
      {result:{model:'old-provider/old-model',complete:true,status:'reviewed',evidencePath:'old-review.md',findings:[]}})};
  const state:engine.State={schema:1,protocol:2,id:'historical-dsh-run',revision:7,
    inputs:{spec:100,targetBranch:'main',models:{L1:'large',L2:'middle',L3:'small'}},
    spec:100,repo:{root,slug:'example/test',host:'github.com',defaultBranch:'main'},status:'paused',
    policy:{agents:4,issues:2,tests:1,noProgress:2,rounds:3},
    capabilities:{framework:'fixture-dsh',modelRouting:'per_agent',models:['large','middle','small']},
    specCriteria:['legacy criterion'],planEvidence:'old-plan.md',tickets:[ticket],jobs:[job],
    facts:{base:'a'.repeat(40),issueStates:{100:'OPEN',101:'OPEN'},prs:{},at:''},auditEpoch:1,events:[]};
  const statePath=path.join(run,'state.json');fs.writeFileSync(statePath,JSON.stringify(state,null,2)+'\n');
  const settings=path.join(root,'settings.yaml');fs.writeFileSync(settings,'agent-default-model: fixture\n');
  const externalState=path.join(root,'external-actions.json');fs.writeFileSync(externalState,'{"pending":0,"unknown":0}\n');
  const external=path.join(root,'external-observer.cjs');
  fs.writeFileSync(external,`#!/usr/bin/env node
const fs=require('fs'),r=JSON.parse(fs.readFileSync(0,'utf8'));
const current=JSON.parse(fs.readFileSync(${JSON.stringify(externalState)},'utf8'));
console.log(JSON.stringify({source:'native_host',challenge:r.challenge,runId:r.runId,
inventorySha256:r.inventorySha256,ledgerSha256:r.ledgerSha256,observedAt:new Date().toISOString(),
state:current.pending||current.unknown?'pending':'settled',unknown:current.pending+current.unknown,
sourceDigest:require('crypto').createHash('sha256').update(JSON.stringify(current)).digest('hex')}));
`);fs.chmodSync(external,0o700);
  const configPath=path.join(root,'dsh-config.json');
  fs.writeFileSync(configPath,JSON.stringify({schema:1,hostId:'fixture-dsh',runtimeRoot:path.join(root,'new-runtime'),
    legacyRuntimeRoot:path.join(root,'legacy-host'),
    dshBin:process.execPath,zstdBin:zstd,routes:[{requestedModel:'old-provider/old-model',
      provider:'old-provider',model:'old-model',settingsFile:settings}]}));
  const bin=path.join(root,'bin');
  const install=spawnSync(process.execPath,[adapter,'install',configPath,bin],{encoding:'utf8'});
  assert.equal(install.status,0,install.stderr);
  const migrationObserver=JSON.parse(install.stdout).migrationObserver;
  const env={...process.env,HOME:root,SPEC_DELIVERY_MIGRATION_OBSERVER:migrationObserver};
  const call=(...args:string[])=>spawnSync(process.execPath,[entry,...args],{cwd:root,env,encoding:'utf8',timeout:30000});
  const decision=()=>{const context=JSON.parse(call('migration-context',statePath).stdout);
    const evidence=path.join(run,'operator-evidence.md');fs.writeFileSync(evidence,'Native DSH and external observer queried.\n');
    const file=path.join(run,'decision.json');fs.writeFileSync(file,JSON.stringify({schemaVersion:1,
      expectedRevision:context.revision,inventorySha256:context.inventorySha256,
      ledgerSha256:context.ledgerSha256,evidencePath:evidence,observedAt:new Date().toISOString(),
      statusIntent:'preserve',processTreeStopped:true,externalActionsSettled:true}));return file;};
  return {root,home,statePath,externalState,external,configPath,migrationObserver,call,decision,
    cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('内置 DSH 查询模拟原生格式压缩日志与终态标记，公开 CLI 迁移隔离旧协议并保留原字节',()=>{
  for(const logicalCancelled of [false,true]){
    const x=fixture(logicalCancelled);try{
      const before=fs.readFileSync(x.statePath);
      for(const op of ['summary','inspect','metrics','migration-context'])
        assert.equal(x.call(op,x.statePath).status,0,op);
      assert.deepEqual(fs.readFileSync(x.statePath),before);
      const context=JSON.parse(x.call('migration-context',x.statePath).stdout);
      const probe=spawnSync(x.migrationObserver,['quiescence',x.statePath],{
        input:JSON.stringify({schemaVersion:1,challenge:'isolated-probe',runId:'historical-dsh-run',...context}),
        encoding:'utf8'});
      assert.equal(probe.status,0,probe.stderr);
      const observed=JSON.parse(probe.stdout);
      assert.equal(observed.actors[0].state,'completed',JSON.stringify(observed.actors));
      assert.equal(observed.processTree.state,'stopped',JSON.stringify(observed.processTree));
      const result=x.call('upgrade',x.statePath,x.decision());assert.equal(result.status,0,result.stderr);
      const output=JSON.parse(result.stdout),saved=JSON.parse(fs.readFileSync(x.statePath,'utf8'));
      assert.equal(output.backupSha256,sha(before));
      assert.deepEqual(fs.readFileSync(output.backupPath),before);
      assert.equal(saved.status,'paused');assert.equal(saved.jobs[0].status,logicalCancelled?'cancelled':'done');
      assert.equal(saved.jobs[0].nativeId,'legacy-review-one/session-11111111-2222-3333-4444-555555555555');
      assert.equal(saved.tickets[0].phase,'replan');assert.deepEqual(saved.tickets[0].evidence,{});
      const observation=JSON.parse(fs.readFileSync(saved.migrations[0].hostObservationPath,'utf8'));
      assert.equal(observation.actors[0].state,'completed');
      assert.equal(observation.processTree.state,'stopped');
      assert.equal(observation.externalActions.state,'settled');
      assert.equal(saved.migrations[0].hostObservationSha256,sha(fs.readFileSync(saved.migrations[0].hostObservationPath)));
    }finally{x.cleanup();}
  }
});

test('旧 DSH 缺原生终态、仍有宿主进程或外部动作未结清时迁移失败且不备份',()=>{
  for(const mode of ['missing-terminal','legacy-tool-call','host-running','host-running-unmarked',
    'external-pending','actions-intent','untracked-command'] as const){
    const x=fixture(true);let child:ReturnType<typeof spawn>|undefined;
    try{
      if(mode==='missing-terminal')fs.unlinkSync(path.join(x.home,'exit-code'));
      if(mode==='legacy-tool-call'){
        const log=path.join(x.home,'sessions','--fixture--',
          'session-11111111-2222-3333-4444-555555555555','session.v3.jsonl.zstd');
        const plain=spawnSync(zstd,['-dc',log],{encoding:'utf8'});
        assert.equal(plain.status,0);
        const changed=path.join(x.root,'with-tool.jsonl');
        fs.writeFileSync(changed,plain.stdout.replace('{"type":"turn/end"}',
          '{"type":"tool/call","data":{}}\n{"type":"turn/end"}'));
        assert.equal(spawnSync(zstd,['-q','-f',changed,'-o',log]).status,0);
      }
      if(mode==='external-pending'){
        fs.writeFileSync(x.externalState,'{"pending":1,"unknown":0}\n');
        const config=JSON.parse(fs.readFileSync(x.configPath,'utf8'));
        config.migrationExternalObserver=x.external;
        fs.writeFileSync(x.configPath,JSON.stringify(config));
      }
      if(mode==='actions-intent'){
        const actions=path.join(path.dirname(x.statePath),'actions');fs.mkdirSync(actions);
        fs.writeFileSync(path.join(actions,'publish.intent.json'),'{"operationId":"unsettled"}\n');
      }
      if(mode==='host-running'){
        child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{
          env:{...process.env,DSH_HOME:x.home},stdio:'ignore'});
        const until=Date.now()+5000;
        while(!fs.existsSync(`/proc/${child.pid}/environ`)&&Date.now()<until)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
      }
      if(mode==='host-running-unmarked'){
        child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{
          cwd:x.home,env:{...process.env,DSH_HOME:''},stdio:'ignore'});
        const until=Date.now()+5000;
        while(!fs.existsSync(`/proc/${child.pid}/environ`)&&Date.now()<until)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
      }
      if(mode==='untracked-command'){
        const s=JSON.parse(fs.readFileSync(x.statePath,'utf8'));
        s.jobs.push({...s.jobs[0],id:'old-command',executor:'command',action:'publish',
          nativeId:'command:2147483647:1',status:'done'});
        fs.writeFileSync(x.statePath,JSON.stringify(s,null,2)+'\n');
      }
      const before=fs.readFileSync(x.statePath),result=x.call('upgrade',x.statePath,x.decision());
      assert.notEqual(result.status,0,`${mode}: ${result.stderr}`);
      assert.deepEqual(fs.readFileSync(x.statePath),before,mode);
      assert.equal(fs.existsSync(path.join(path.dirname(x.statePath),'migrations')),false,mode);
    }finally{if(child)child.kill('SIGKILL');x.cleanup();}
  }
});
