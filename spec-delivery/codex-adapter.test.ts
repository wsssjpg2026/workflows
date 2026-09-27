import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const adapter=fileURLToPath(new URL('./adapters/codex.mjs',import.meta.url));
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-adapter-'));
  const bin=path.join(root,'codex'),codexHome=path.join(root,'codex-home');
  fs.writeFileSync(bin,`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const args=process.argv.slice(2),home=process.env.CODEX_HOME;
if(args[0]==='--version'){console.log(process.env.FAKE_VERSION||'codex-cli fixture 1.0');process.exit(0);}
if(args.includes('--help')){console.log('exec --json --model -m resume');process.exit(0);}
if(args[0]!=='exec')process.exit(3);
if(process.env.FAKE_NO_ID){console.error('native session not created');process.exit(0);}
const resume=args[1]==='resume',id=resume?args[2]:crypto.randomUUID();
const model=args[args.indexOf('-m')+1],actual=process.env.FAKE_OBSERVED_MODEL||model;
const dir=path.join(home,'sessions','2026','09','27');fs.mkdirSync(dir,{recursive:true});
let file=fs.readdirSync(dir).find(x=>x.endsWith('-'+id+'.jsonl'));
if(!file)file='rollout-2026-09-27T00-00-00-'+id+'.jsonl';
const target=path.join(dir,file),at=new Date().toISOString(),turn=crypto.randomUUID();
const row=(type,payload)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\\n';
if(!fs.existsSync(target))fs.appendFileSync(target,row('session_meta',{id,model_provider:'openai'}));
fs.appendFileSync(target,row('event_msg',{type:'task_started',turn_id:turn}));
fs.appendFileSync(target,row('turn_context',{turn_id:turn,model:actual}));
console.log(JSON.stringify({type:'thread.started',thread_id:id}));
console.log(JSON.stringify({type:'turn.started'}));
const prompt=args.at(-1),last=prompt.includes('Reply with exactly READY')?'READY':prompt;
if(prompt==='__HOLD__')setInterval(()=>{},1000);
else {
  fs.appendFileSync(target,row('event_msg',{type:'task_complete',turn_id:turn}));
  const output=args.includes('--output-last-message')?args[args.indexOf('--output-last-message')+1]:null;
  if(output)fs.writeFileSync(output,last);
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:last}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}}));
}
`);
  fs.chmodSync(bin,0o755);
  const config=path.join(root,'config.json');
  const value={schema:1,hostId:'codex-fixture',runtimeRoot:path.join(root,'runtime'),codexBin:bin,
    codexHome,routes:[{requestedModel:'L1-configured',cliModel:'model-a',provider:'openai',model:'model-a'},
      {requestedModel:'L2-configured',cliModel:'model-b',provider:'openai',model:'model-b'}],
    startWaitMs:2000,taskTimeoutMs:10000,probeTimeoutMs:5000,allowProbeTask:true};
  fs.writeFileSync(config,JSON.stringify(value));
  const call=(mode:string,...args:string[])=>spawnSync(process.execPath,[adapter,mode,config,...args],
    {cwd:root,encoding:'utf8',env:{...process.env,CODEX_HOME:codexHome},timeout:10000});
  const request=(jobId:string,model:string,task:string,resumeFrom?:string)=>{
    const token=`token-${jobId}`;
    const packetPath=path.join(root,`${jobId}-packet.json`),outputDirectory=path.join(root,jobId,'output');
    fs.mkdirSync(outputDirectory,{recursive:true});
    fs.writeFileSync(packetPath,JSON.stringify({jobId,model,dispatchToken:token,outputDirectory,
      worktree:root,adapterProbeTask:task,contextIntent:{kind:resumeFrom?'continue':'independent'}}));
    const file=path.join(root,`${jobId}-request.json`);
    fs.writeFileSync(file,JSON.stringify({token,jobId,targetHost:value.hostId,requestedModel:model,packetPath,
      ...(resumeFrom?{resumeFrom:{nativeId:resumeFrom,contextId:resumeFrom}}:{})}));
    return file;
  };
  const checked=(mode:string,...args:string[])=>{
    const result=call(mode,...args);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  return {root,bin,codexHome,config,value,call,checked,request,
    cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function awaitTerminal(x:ReturnType<typeof fixture>,request:string){
  for(let i=0;i<40;i++){
    const reply=x.checked('host','query',request);
    if(reply.state==='completed'||reply.state==='cancelled')return reply;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  }
  throw new Error('fixture actor did not reach a terminal state');
}

test('Codex 统一适配器：模型探测、持久 token、原生身份、逐项收取、resume 和 fresh',()=>{
  const x=fixture();
  try{
    const interfaceProbe=x.checked('probe');
    assert.equal(interfaceProbe.cliInterface,'available');
    assert.ok(interfaceProbe.routes.every((r:{nativeRouteVerified:boolean})=>!r.nativeRouteVerified));
    const firstRequest=x.request('job-l1','L1-configured','{"complete":true,"status":"planned","evidencePath":"/tmp/proof"}');
    assert.equal(x.checked('host','query',firstRequest).state,'not_found');
    const refused=x.call('host','start',firstRequest);
    assert.notEqual(refused.status,0);assert.match(refused.stderr,/probe-models/);
    const probed=x.checked('probe-models');assert.equal(probed.allVerified,true);
    const started=x.checked('host','start',firstRequest);
    assert.ok(['running','completed'].includes(started.state));
    const first=awaitTerminal(x,firstRequest);
    assert.match(first.nativeId,/^[0-9a-f-]{36}$/);
    assert.equal(first.resultFile?.startsWith('codex-final-'),true);
    const identity=x.checked('observe','observe',first.nativeId,'job-l1');
    assert.equal(identity.provider,'openai');assert.equal(identity.model,'model-a');
    assert.equal(identity.context.mode,'new');
    assert.equal(x.checked('host','start',firstRequest).nativeId,first.nativeId,'同 token 不重复执行');
    const continuedRequest=x.request('job-l1-next','L1-configured','{"complete":true,"status":"planned","evidencePath":"/tmp/next"}',first.nativeId);
    x.checked('host','start',continuedRequest);
    const continued=awaitTerminal(x,continuedRequest);
    assert.equal(continued.nativeId,first.nativeId);
    const resumed=x.checked('observe','observe',continued.nativeId,'job-l1-next');
    assert.equal(resumed.context.mode,'resumed');
    assert.equal(resumed.context.resumedFromContextId,identity.context.contextId);
    const freshRequest=x.request('job-fresh','L2-configured','{"complete":true,"status":"reviewed","evidencePath":"/tmp/fresh"}');
    x.checked('host','start',freshRequest);
    const fresh=awaitTerminal(x,freshRequest);
    assert.notEqual(fresh.nativeId,first.nativeId);
    assert.equal(x.checked('observe','observe',fresh.nativeId,'job-fresh').context.mode,'new');
  }finally{x.cleanup();}
});

test('错误原生模型、未知 token 与正式停止都不会冒充已绑定终态',()=>{
  const x=fixture();
  try{
    const bad={...x.value,routes:[{requestedModel:'wrong',cliModel:'model-a',provider:'openai',model:'another-model'}]};
    fs.writeFileSync(x.config,JSON.stringify(bad));
    const probe=x.checked('probe-models');assert.equal(probe.allVerified,false);
    assert.match(probe.checks[0].error,/provider\/model/);
    const request=x.request('job-wrong','wrong','{}');
    const blocked=x.call('host','start',request);assert.notEqual(blocked.status,0);
    fs.writeFileSync(x.config,JSON.stringify(x.value));x.checked('probe-models');
    const hold=x.request('job-hold','L1-configured','__HOLD__');
    const begun=x.checked('host','start',hold);assert.equal(begun.state,'running');
    assert.equal(x.checked('host','query',hold).state,'running');
    const stopped=x.checked('host','cancel',hold);assert.equal(stopped.state,'cancelled');
    assert.equal(x.checked('host','query',hold).state,'cancelled');
  }finally{x.cleanup();}
});

test('Codex 技能以 source_execution 逐字加载固定文件和依赖后才签宿主回执',()=>{
  const x=fixture();
  try{
    x.checked('probe-models');
    const request=x.request('job-skill','L1-configured','{"complete":true,"status":"planned","evidencePath":"/tmp/skill"}');
    x.checked('host','start',request);
    const done=awaitTerminal(x,request),session=x.checked('observe','observe',done.nativeId,'job-skill');
    const source=path.join(x.root,'source.json'),sourceText='---\nname: fixture-skill\n---\n\nPerform the fixture task.\n';
    const bytes=Buffer.from(sourceText);
    const digest=createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(source,JSON.stringify({fingerprint:'pinned-fixture',files:[
      {relativePath:'SKILL.md',sha256:digest,dataBase64:bytes.toString('base64')}]}));
    const invocationId='job-skill:skill:implementation:1';
    fs.writeFileSync(path.join(x.root,'state.json'),JSON.stringify({jobs:[{id:'job-skill',nativeId:done.nativeId,session}],
      v3:{skillBindings:[{capability:'implementation'}],skillInvocations:[{id:invocationId,jobId:'job-skill',
        mode:'source_execution',bindingFingerprint:'pinned-fixture',sourceArchivePath:source}]}}));
    const capability=x.checked('skill','capabilities','implementation','job-skill');
    assert.equal(capability.capabilities.nativeExplicit.supported,false);
    assert.equal(capability.capabilities.sourceExecution.allowed,true);
    const premature=x.call('skill','result',invocationId,'job-skill');assert.notEqual(premature.status,0);
    const home=path.join(x.value.runtimeRoot,'runs',createHash('sha256').update('token-job-skill').digest('hex').slice(0,32));
    const actor=(mode:string,...args:string[])=>spawnSync(process.execPath,[adapter,mode,x.config,...args],{
      cwd:x.root,encoding:'utf8',env:{...process.env,CODEX_HOME:x.codexHome,CODEX_ADAPTER_ACTOR_HOME:home}});
    const loaded=actor('skill-open',path.join(x.root,'state.json'),invocationId);
    assert.equal(loaded.status,0,loaded.stderr);assert.ok(loaded.stdout.includes('Perform the fixture task'));
    const raw=path.join(x.root,'skill-report.md');fs.writeFileSync(raw,'Task actually performed.\n');
    const completed=actor('skill-complete',path.join(x.root,'state.json'),invocationId,raw);
    assert.equal(completed.status,0,completed.stderr);
    const result=x.checked('skill','result',invocationId,'job-skill');
    assert.equal(result.mode,'source_execution');
    assert.equal(result.nativeId,done.nativeId);
    assert.deepEqual(result.loadedFiles,[{relativePath:'SKILL.md',sha256:digest}]);
  }finally{x.cleanup();}
});

test('CLI 版本漂移和丢失原生 ID 保持能力缺口及同 token 不重启',()=>{
  const x=fixture();
  try{
    x.checked('probe-models');
    const request=x.request('job-uncertain','L1-configured','{}');
    const changed=spawnSync(process.execPath,[adapter,'host',x.config,'start',request],{
      cwd:x.root,encoding:'utf8',env:{...process.env,CODEX_HOME:x.codexHome,FAKE_VERSION:'codex-cli fixture 2.0'}});
    assert.notEqual(changed.status,0);assert.match(changed.stderr,/probe-models/);
    const missing=spawnSync(process.execPath,[adapter,'host',x.config,'start',request],{
      cwd:x.root,encoding:'utf8',env:{...process.env,CODEX_HOME:x.codexHome,FAKE_NO_ID:'1'}});
    assert.equal(missing.status,0,missing.stderr);
    assert.equal(JSON.parse(missing.stdout).state,'unknown');
    const root=path.join(x.value.runtimeRoot,'runs');
    const files=fs.readdirSync(root);assert.equal(files.length,1);
    const again=x.checked('host','start',request);
    assert.equal(again.state,'unknown');
    assert.deepEqual(fs.readdirSync(root),files,'相同 token 未第二次启动');
  }finally{x.cleanup();}
});
