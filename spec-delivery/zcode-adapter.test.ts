import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {scriptForJob} from './adapters/zcode.mjs';
import {renderZcode} from '../spec-delivery.workflow.ts';

const adapter=fileURLToPath(new URL('./adapters/zcode.mjs',import.meta.url));
function fixture(bridgeEnabled=true){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zcode-adapter-contract-'));
  const runtime=path.join(root,'runtime'),bridgeState=path.join(root,'native-runs.json');
  fs.writeFileSync(bridgeState,JSON.stringify({runs:{},creates:[],calls:[]}));
  const bridgePath=path.join(root,'fake-native-bridge.mjs');
  fs.writeFileSync(bridgePath,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
const statePath=${JSON.stringify(bridgeState)},op=process.argv[2],input=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));state.calls.push(op);
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
const output=value=>{save();console.log(JSON.stringify(value));};
if(op==='capabilities')output({CreateWorkflow:true,GetWorkflowRun:true,ListWorkflowRuns:true,
  tokenLookup:true,nativeActorIdentity:true,observedProviderModel:process.env.FAKE_NO_MODEL_OBSERVATION!=='1'});
else if(op==='query'){
  const found=state.runs[input.token];
  output(found?{token:input.token,jobId:input.jobId,...found}:
    {token:input.token,jobId:input.jobId,state:'not_found',authoritative:true});
}else if(op==='create'){
  if(state.runs[input.token]){save();process.exit(2);}
  state.creates.push({token:input.token,jobId:input.jobId,model:input.requestedModel,
    scriptPath:input.scriptPath,actorName:input.actorName});
  state.runs[input.token]={state:'running',runId:'run-'+state.creates.length,actorName:input.actorName,
    provider:input.requestedModel.split('/')[0],model:input.requestedModel.split('/').slice(1).join('/'),
    contextId:'context-'+state.creates.length,startedAt:new Date().toISOString(),usage:{providerRaw:{input:3}}};
  if(process.env.FAKE_LOST_CREATE==='1'){save();process.exit(3);}
  output({token:input.token,runId:state.runs[input.token].runId});
}else if(op==='observe'){
  const found=Object.values(state.runs).find(x=>x.runId+'/'+x.actorName===input.nativeId);
  if(!found){save();process.exit(4);}
  output({source:'native_host',observationId:'obs-'+found.runId,jobId:input.jobId,nativeId:input.nativeId,
    provider:found.provider,model:found.model,observedAt:found.startedAt,
    context:{contextId:found.contextId,mode:'new',proofId:'proof-'+found.runId}});
}else if(op==='stop'){
  const found=state.runs[input.token];if(found)found.state='cancelled';
  output({token:input.token,jobId:input.jobId});
}else if(op==='skill-capabilities'){
  output({source:'native_host',jobId:input.jobId,capability:input.capability,
    capabilities:{nativeExplicit:{supported:false,registrations:[]},
      sourceExecution:{allowed:true,acceptsOriginalFiles:true}}});
}else if(op==='skill-result'){
  output({source:'native_host',invocationId:input.invocationId,jobId:input.jobId,nativeId:input.nativeId,
    observationId:input.observationId,mode:input.mode,bindingFingerprint:input.bindingFingerprint,
    terminal:true,loadedFiles:[]});
}else if(op==='availability')output({source:'native_host',nativeId:input.nativeId,jobId:input.jobId,state:'unavailable'});
else{save();process.exit(5);}
`);
  fs.chmodSync(bridgePath,0o755);
  const configPath=path.join(root,'config.json'),config={schema:1,hostId:'fixture-zcode',runtimeRoot:runtime,
    ...(bridgeEnabled?{bridgePath}:{}),workflowEntry:path.resolve('spec-delivery.workflow.ts'),startWaitMs:500};
  fs.writeFileSync(configPath,JSON.stringify(config));
  const stateDir=path.join(root,'workflow');fs.mkdirSync(stateDir,{recursive:true});
  const statePath=path.join(stateDir,'state.json');
  function call(mode:string,args:string[]=[],env:Record<string,string>={}){
    return spawnSync(process.execPath,[adapter,mode,configPath,...args],{cwd:stateDir,encoding:'utf8',
      env:{...process.env,...env},timeout:10000});
  }
  function ok(mode:string,args:string[]=[],env:Record<string,string>={}){
    const result=call(mode,args,env);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  }
  function dispatch(key:string,model='provider/model'){
    const token=`token-${key}`,jobId=`job-${key}`;
    const packetPath=path.join(stateDir,`${key}.packet.json`),outputDirectory=path.join(stateDir,'jobs',key);
    fs.mkdirSync(outputDirectory,{recursive:true});
    const packet={jobId,model,executor:'agent',dispatchToken:token,rolesPath:path.join(root,'roles.md'),
      outputDirectory,contextIntent:{kind:'independent',fresh:true}};
    fs.writeFileSync(packetPath,JSON.stringify(packet));fs.writeFileSync(packet.rolesPath,'actor roles\n');
    const requestPath=path.join(stateDir,`${key}.request.json`);
    fs.writeFileSync(requestPath,JSON.stringify({token,jobId,attempt:1,targetHost:'fixture-zcode',
      requestedModel:model,packetPath}));
    return {token,jobId,model,packetPath,requestPath,outputDirectory};
  }
  const native=()=>JSON.parse(fs.readFileSync(bridgeState,'utf8'));
  const putNative=(value:object)=>fs.writeFileSync(bridgeState,JSON.stringify(value));
  return {root,runtime,statePath,stateDir,bridgeState,configPath,call,ok,dispatch,native,putNative,
    cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('原生工具不可用时能力探测明确缺口且派发保持 unknown',()=>{
  const x=fixture(false);
  try{
    const probe=x.ok('probe');assert.equal(probe.nativeToolsAvailable,false);
    assert.equal(probe.capabilities.CreateWorkflow,false);
    const d=x.dispatch('no-tools');
    assert.equal(x.ok('host',['query',d.requestPath]).state,'unknown');
    assert.equal(x.ok('host',['start',d.requestPath]).state,'unknown');
    assert.equal(fs.existsSync(path.join(x.runtime,'tokens')),false,'不能把 Electron launcher 当作原生 API');
  }finally{x.cleanup();}
});

test('缺少真实模型观测能力时拒绝创建；完成报告必须匹配 token、job 和 actor',()=>{
  const x=fixture();
  try{
    const noModel=x.dispatch('no-model');
    assert.notEqual(x.call('host',['start',noModel.requestPath],{FAKE_NO_MODEL_OBSERVATION:'1'}).status,0);
    assert.equal(x.native().creates.length,0);
    const d=x.dispatch('bad-report');x.ok('host',['start',d.requestPath]);
    const state=x.native();state.runs[d.token].state='completed';
    state.runs[d.token].report={kind:'spec-delivery-result',token:d.token,jobId:d.jobId,
      actorName:'another-actor',resultFile:'raw.json'};x.putNative(state);
    assert.notEqual(x.call('host',['collect',d.requestPath]).status,0);
  }finally{x.cleanup();}
});

test('统一宿主契约：启动响应丢失按 token 找回同一 run，跨模型独立启动且逐项收取',()=>{
  const x=fixture();
  try{
    const installed=x.ok('install',[path.join(x.root,'bin')]);
    assert.ok(fs.existsSync(installed.host)&&fs.existsSync(installed.observe)&&fs.existsSync(installed.skill));
    const a=x.dispatch('fast','provider/fast'),b=x.dispatch('slow','other/slow');
    const wrapped=spawnSync(installed.host,['query',a.requestPath],{cwd:x.stateDir,encoding:'utf8'});
    assert.equal(wrapped.status,0,wrapped.stderr);assert.equal(JSON.parse(wrapped.stdout).state,'not_found');
    assert.equal(x.ok('host',['query',a.requestPath]).state,'not_found');
    const first=x.ok('host',['start',a.requestPath],{FAKE_LOST_CREATE:'1'});
    assert.equal(first.state,'running');assert.ok(first.nativeId);
    const second=x.ok('host',['start',b.requestPath]);assert.equal(second.state,'running');
    assert.notEqual(first.nativeId,second.nativeId);
    const observed=x.ok('observe',['observe',first.nativeId,a.jobId]);
    assert.equal(observed.provider,'provider');assert.equal(observed.model,'fast');
    assert.equal(observed.context.mode,'new');
    let state=x.native();
    state.runs[a.token].state='completed';state.runs[a.token].completedAt=new Date().toISOString();
    state.runs[a.token].report={kind:'spec-delivery-result',token:a.token,jobId:a.jobId,
      actorName:state.runs[a.token].actorName,resultFile:'raw-result.json'};x.putNative(state);
    fs.writeFileSync(path.join(a.outputDirectory,'raw-result.json'),'{"complete":true,"status":"completed","evidencePath":"evidence.md"}');
    const collected=x.ok('host',['collect',a.requestPath]);
    assert.equal(collected.state,'completed');assert.equal(collected.nativeId,first.nativeId);
    assert.equal(collected.usage.providerRaw.input,3);
    assert.equal(x.ok('host',['query',b.requestPath]).state,'running','慢 actor 不挡快 actor 收取');
    assert.equal(x.ok('host',['start',a.requestPath]).nativeId,first.nativeId);
    state=x.native();assert.equal(state.creates.length,2,'每个 token 恰有一个原生 CreateWorkflow');
    assert.deepEqual(state.creates.map((v:{model:string})=>v.model),['provider/fast','other/slow']);
  }finally{x.cleanup();}
});

test('未知 native 状态不盲目重建；取消保留 run 身份；技能模式来自可信桥接',()=>{
  const x=fixture();
  try{
    const d=x.dispatch('uncertain');
    const start=x.ok('host',['start',d.requestPath]);
    let state=x.native();state.runs[d.token].state='unknown';x.putNative(state);
    const uncertain=x.ok('host',['query',d.requestPath]);
    assert.equal(uncertain.state,'unknown');assert.equal(uncertain.nativeId,start.nativeId,
      '不确定状态仍保留已观测原生实例身份');
    x.ok('host',['start',d.requestPath]);assert.equal(x.native().creates.length,1);
    state=x.native();state.runs[d.token].state='running';x.putNative(state);
    assert.equal(x.ok('host',['cancel',d.requestPath]).state,'cancelled');
    assert.equal(x.ok('host',['query',d.requestPath]).nativeId,start.nativeId);
    const session=x.ok('observe',['observe',start.nativeId,d.jobId]);
    const sourceArchivePath=path.join(x.root,'source.json');
    fs.writeFileSync(sourceArchivePath,'{"fingerprint":"fixed","files":[]}');
    fs.writeFileSync(x.statePath,JSON.stringify({jobs:[{id:d.jobId,nativeId:start.nativeId,session}],
      v3:{skillBindings:[{capability:'handoff',sourcePath:'/original/SKILL.md',fingerprint:'fixed'}],
        skillInvocations:[{id:'call-1',jobId:d.jobId,mode:'source_execution',
          bindingFingerprint:'fixed',sourceArchivePath}]}}));
    const capabilities=x.ok('skill',['capabilities','handoff',d.jobId]);
    assert.equal(capabilities.capabilities.nativeExplicit.supported,false);
    assert.equal(capabilities.capabilities.sourceExecution.allowed,true);
    const receipt=x.ok('skill',['result','call-1',d.jobId]);
    assert.equal(receipt.mode,'source_execution');assert.equal(receipt.bindingFingerprint,'fixed');
    fs.writeFileSync(sourceArchivePath,'{"fingerprint":"changed","files":[]}');
    assert.notEqual(x.call('skill',['result','call-1',d.jobId]).status,0,
      '来源版本变化不能沿用旧终态回执');
  }finally{x.cleanup();}
});

test('每 job 一个原生脚本；报告保留 token/result，生成脚本不批量等待或嵌套创建',async()=>{
  const token='durable-token',jobId='job-one',reports:unknown[]=[];
  const script=scriptForJob({token,jobId,packetPath:'/tmp/packet.json',rolesPath:'/tmp/roles.md',
    outputDirectory:'/tmp/output',actorName:'actor-1',workflowEntry:'/tmp/workflow.ts',statePath:'/tmp/state.json'});
  assert.doesNotMatch(script,/CreateWorkflow|bind-batch|Promise\.all|>=50|five.lens|dual.axis/);
  const compiled=stripTypeScriptTypes(`async function execute(){${script}}`)+'\nreturn execute();';
  const fn=new Function('agent','phase','report',compiled);
  const result=await fn((name:string)=>({ask:async()=>({resultFile:'result.json',summary:name+' done'})}),
    ()=>{},(item:unknown)=>reports.push(item));
  assert.equal(result.conclusion,'actor-1 done');
  assert.deepEqual(reports,[{kind:'spec-delivery-result',token,jobId,actorName:'actor-1',
    resultFile:'result.json',summary:'actor-1 done'}]);
});

test('zcode 入口按持久派发记录生成不同模型的独立 CreateWorkflow 描述',()=>{
  const x=fixture();
  try{
    const a=x.dispatch('a','provider/a'),b=x.dispatch('b','provider/b');
    const records=[a,b].map(d=>({token:d.token,jobId:d.jobId,attempt:1,targetHost:'fixture-zcode',
      requestedModel:d.model,packetPath:d.packetPath,requestPath:d.requestPath,
      requestDigest:createHash('sha256').update(fs.readFileSync(d.requestPath)).digest('hex'),
      status:'prepared'}));
    const state={protocol:3,v3:{dispatchRecords:records},tickets:[],
      jobs:[a,b].map(d=>({id:d.jobId,status:'leased',executor:'agent',model:d.model,ticket:d.jobId}))};
    const output=renderZcode(state as any,x.statePath) as {jobId:string;token:string;arguments:{path:string;subagent_model:string}}[];
    assert.equal(output.length,2);assert.notEqual(output[0].arguments.path,output[1].arguments.path);
    assert.deepEqual(output.map(o=>o.arguments.subagent_model),['provider/a','provider/b']);
    assert.deepEqual(output.map(o=>o.token),[a.token,b.token]);
    assert.ok(output.every(o=>fs.readFileSync(o.arguments.path,'utf8').includes(o.jobId)));
  }finally{x.cleanup();}
});
