import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const adapter=fileURLToPath(new URL('./adapters/dsh.mjs',import.meta.url));
const mainObserver=fileURLToPath(new URL('./adapters/codex-main-observer.mjs',import.meta.url));
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const zstd=execFileSync('which',['zstd'],{encoding:'utf8'}).trim();
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-adapter-contract-'));
  const runtime=path.join(root,'runtime'),stateDir=path.join(root,'workflow'),statePath=path.join(stateDir,'state.json');
  fs.mkdirSync(stateDir,{recursive:true});
  const starts=path.join(root,'starts.log'),fake=path.join(root,'fake-dsh.mjs');
  fs.writeFileSync(fake,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
if(process.argv.includes('--version')){console.log('fake-dsh 1.0');process.exit(0);}
const home=process.env.DSH_HOME,id='session-'+path.basename(home).slice(0,16);
fs.appendFileSync(${JSON.stringify(starts)},id+'\\n');
const prompt=process.argv.at(-1),resultPath=JSON.parse(prompt.match(/^Result path: (.+)$/m)?.[1]||'null');
fs.writeFileSync(path.join(home,'prompt.txt'),prompt);
const dir=path.join(home,'sessions','--fixture--',id);fs.mkdirSync(dir,{recursive:true});
const now=Date.now();const event=[
  {type:'session',id,createdAt:now,cwd:process.cwd()},
  {type:'assistant/message',seq:1,time:now+1,data:{message:{role:'assistant',source:{kind:'model',provider:process.env.FAKE_PROVIDER,model:process.env.FAKE_MODEL},
    content:[{type:'text',text:process.env.FAKE_FINAL_JSON}]},usage:{inputTokens:11,outputTokens:7,totalTokens:18,cachedInputTokens:3}}},
  {type:'turn/end',seq:2,time:now+2},
];
if(process.env.FAKE_NO_TURN_END==='1')event.pop();
const plain=path.join(dir,'events.jsonl');fs.writeFileSync(plain,event.map(x=>JSON.stringify(x)).join('\\n')+'\\n');
const zip=spawnSync(${JSON.stringify(zstd)},['-q','-f',plain,'-o',path.join(dir,'session.v3.jsonl.zstd')]);
if(zip.status!==0)process.exit(3);
if(resultPath&&process.env.FAKE_WRITE_RESULT!=='0'){
  fs.mkdirSync(path.dirname(resultPath),{recursive:true});
  if(process.env.FAKE_RESULT_LINK)fs.symlinkSync(process.env.FAKE_RESULT_LINK,resultPath);
  else fs.writeFileSync(resultPath,process.env.FAKE_RESULT_BYTES??process.env.FAKE_FINAL_JSON);
}
await new Promise(resolve=>setTimeout(resolve,Number(process.env.FAKE_HOLD_MS||0)));
console.log(process.env.FAKE_FINAL_JSON);
process.exit(Number(process.env.FAKE_EXIT_CODE||0));
`);
  fs.chmodSync(fake,0o755);
  const settings=path.join(root,'settings.yaml');fs.writeFileSync(settings,'agent-default-model: fixture\n');
  const configPath=path.join(root,'config.json');
  const conf={schema:1,hostId:'fixture-dsh',runtimeRoot:runtime,dshBin:fake,zstdBin:zstd,
    routes:[{requestedModel:'fixture/model',provider:'fixture',model:'model',settingsFile:settings}],
    startWaitMs:3000,taskTimeoutMs:10000,sourceExecution:true,allowProbeTask:true};
  fs.writeFileSync(configPath,JSON.stringify(conf));
  const env={...process.env,FAKE_PROVIDER:'fixture',FAKE_MODEL:'model',
    FAKE_FINAL_JSON:JSON.stringify({complete:true,status:'completed',evidencePath:path.join(root,'evidence.md')})};
  fs.writeFileSync(path.join(root,'evidence.md'),'real fixture evidence\n');
  function call(mode:string,args:string[]=[],opts:{env?:Record<string,string>;cwd?:string}={}){
    return spawnSync(process.execPath,[adapter,mode,configPath,...args],{cwd:opts.cwd||root,
      env:{...env,...opts.env},encoding:'utf8',timeout:15000});
  }
  function ok(mode:string,args:string[]=[],opts:{env?:Record<string,string>;cwd?:string}={}){
    const result=call(mode,args,opts);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  }
  function dispatch(token:string){
    const packetPath=path.join(stateDir,`${token}.packet.json`),outputDirectory=path.join(stateDir,'output',token);
    const resultPath=path.join(outputDirectory,'result.json');
    fs.writeFileSync(packetPath,JSON.stringify({jobId:`job-${token}`,model:'fixture/model',executor:'agent',
      dispatchToken:token,repo:{root},worktree:root,outputDirectory,resultPath,
      adapterProbeTask:'Return exactly the configured probe Result JSON.'}));
    const requestPath=path.join(stateDir,`${token}.request.json`);
    fs.writeFileSync(requestPath,JSON.stringify({token,jobId:`job-${token}`,attempt:1,targetHost:'fixture-dsh',
      requestedModel:'fixture/model',packetPath}));
    return {requestPath,packetPath,outputDirectory,resultPath};
  }
  function bootstrap(token:string){
    const promptPath=path.join(root,`${token}.prompt.txt`),requestPath=path.join(root,`${token}.bootstrap.json`);
    const outputDirectory=path.join(root,`${token}.bootstrap-output`);
    fs.writeFileSync(promptPath,'Read the fixed sources and author the execution graph as JSON.\n');
    fs.writeFileSync(requestPath,JSON.stringify({schema:1,token,jobId:'$spec:execution-plan',
      targetHost:'fixture-dsh',requestedModel:'fixture/model',worktree:root,promptPath,outputDirectory}));
    return {requestPath,promptPath,outputDirectory};
  }
  return {root,runtime,statePath,stateDir,configPath,starts,env,call,ok,dispatch,bootstrap,
    cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function until<T>(fn:()=>T,ready:(value:T)=>boolean,timeout=5000):T{
  const end=Date.now()+timeout;
  for(;;){const value=fn();if(ready(value))return value;assert.ok(Date.now()<end,'bounded adapter poll timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);}
}

test('统一宿主契约：token 先查、启动后同身份查询、逐项收取和原始 usage',()=>{
  const x=fixture();
  try{
    const installed=x.ok('install',[path.join(x.root,'bin')]);
    assert.ok(fs.existsSync(installed.host)&&fs.existsSync(installed.observer)&&fs.existsSync(installed.skillObserver));
    const {requestPath,outputDirectory}=x.dispatch('one');
    assert.deepEqual(x.ok('host',['query',requestPath]).state,'not_found');
    const launched=x.ok('host',['start',requestPath]);
    assert.ok(['running','completed'].includes(launched.state));assert.ok(launched.nativeId);
    const observed=x.ok('observe',['observe',launched.nativeId,'job-one']);
    assert.equal(observed.provider,'fixture');assert.equal(observed.model,'model');
    assert.equal(observed.context.mode,'new');assert.ok(observed.context.proofId);
    const complete=until(()=>x.ok('host',['query',requestPath]),r=>r.state==='completed');
    assert.equal(complete.nativeId,launched.nativeId);
    assert.equal(complete.usage.events[0].usage.cachedInputTokens,3);
    const collected=x.ok('host',['collect',requestPath]);
    assert.equal(collected.nativeId,launched.nativeId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputDirectory,collected.resultFile),'utf8')).status,'completed');
    assert.equal(x.ok('host',['start',requestPath]).nativeId,launched.nativeId);
    assert.equal(fs.readFileSync(x.starts,'utf8').trim().split('\n').length,1,'同 token 仅有一个原生启动');
    const probe=x.ok('probe');
    assert.equal(probe.routes[0].nativeRouteVerified,false,'只读探测不能冒充真实路由验证');
    assert.equal(probe.capabilities.nativeResume,false);
  }finally{x.cleanup();}
});

test('指定结果文件只在真实终态后交付；最终消息保留为非权威原文',()=>{
  const x=fixture();
  try{
    const {requestPath,resultPath}=x.dispatch('file-terminal');
    const raw=JSON.stringify({complete:true,status:'completed',evidencePath:path.join(x.root,'evidence.md')});
    const finalText='Work finished. Result is in the designated file.';
    const started=x.ok('host',['start',requestPath],{env:{FAKE_FINAL_JSON:finalText,
      FAKE_RESULT_BYTES:raw,FAKE_HOLD_MS:'1500'}});
    assert.equal(started.state,'running');
    until(()=>fs.existsSync(resultPath),Boolean);
    assert.equal(x.ok('host',['query',requestPath]).state,'running',
      'an early result file cannot establish native completion');
    const complete=until(()=>x.ok('host',['collect',requestPath]),r=>r.state==='completed');
    assert.match(complete.resultFile,/^dsh-terminal-[0-9a-f]{32}\.raw$/);
    assert.equal(complete.resultSha256,sha(raw));
    assert.equal(fs.readFileSync(path.join(path.dirname(resultPath),complete.resultFile),'utf8'),raw);
    assert.equal(fs.readFileSync(resultPath,'utf8'),raw);
    const home=path.join(x.runtime,'runs',sha('file-terminal').slice(0,32));
    assert.equal(fs.readFileSync(path.join(home,'native-final.txt'),'utf8'),finalText);
    assert.ok(fs.readFileSync(path.join(home,'prompt.txt'),'utf8').includes(
      `Result path: ${JSON.stringify(resultPath)}`));
    const finished=JSON.parse(fs.readFileSync(path.join(home,'finished.json'),'utf8'));
    assert.equal(finished.resultSha256,sha(raw));
    assert.equal(finished.rawSha256,sha(finalText));
  }finally{x.cleanup();}
});

test('原生失败、缺失和预存结果文件均不能冒充完成',()=>{
  const x=fixture();
  try{
    const failed=x.dispatch('native-failed');
    x.ok('host',['start',failed.requestPath],{env:{FAKE_EXIT_CODE:'7'}});
    const failedHome=path.join(x.runtime,'runs',sha('native-failed').slice(0,32));
    until(()=>fs.existsSync(path.join(failedHome,'finished.json')),Boolean);
    assert.ok(fs.existsSync(failed.resultPath));
    assert.equal(x.ok('host',['collect',failed.requestPath]).state,'unknown');
    assert.equal(x.ok('host',['start',failed.requestPath]).state,'unknown');
    const missing=x.dispatch('missing-result');
    x.ok('host',['start',missing.requestPath],{env:{FAKE_WRITE_RESULT:'0'}});
    const missingHome=path.join(x.runtime,'runs',sha('missing-result').slice(0,32));
    until(()=>fs.existsSync(path.join(missingHome,'finished.json')),Boolean);
    assert.equal(x.ok('host',['collect',missing.requestPath]).state,'unknown');
    const unterminated=x.dispatch('no-turn-end');
    x.ok('host',['start',unterminated.requestPath],{env:{FAKE_NO_TURN_END:'1'}});
    const unterminatedHome=path.join(x.runtime,'runs',sha('no-turn-end').slice(0,32));
    until(()=>fs.existsSync(path.join(unterminatedHome,'finished.json')),Boolean);
    assert.ok(fs.existsSync(unterminated.resultPath));
    assert.equal(x.ok('host',['collect',unterminated.requestPath]).state,'unknown');
    const stale=x.dispatch('stale-result');
    fs.mkdirSync(stale.outputDirectory,{recursive:true});
    fs.writeFileSync(stale.resultPath,'{"complete":true}');
    assert.equal(x.ok('host',['start',stale.requestPath]).state,'unknown');
    assert.equal(x.ok('host',['collect',stale.requestPath]).state,'unknown');
    assert.equal(fs.readFileSync(x.starts,'utf8').trim().split('\n').length,3,
      'stale bytes must stop launch before another native actor');
  }finally{x.cleanup();}
});

test('格式错误的指定文件保留原字节；终态后篡改或软链接不再交付',()=>{
  const x=fixture();
  try{
    const malformed=x.dispatch('malformed-file');
    const raw='```json\n{"complete":true}\n```';
    x.ok('host',['start',malformed.requestPath],{env:{FAKE_RESULT_BYTES:raw}});
    const complete=until(()=>x.ok('host',['collect',malformed.requestPath]),r=>r.state==='completed');
    assert.match(complete.resultFile,/^dsh-terminal-[0-9a-f]{32}\.raw$/);
    assert.equal(complete.resultSha256,sha(raw));
    assert.equal(fs.readFileSync(malformed.resultPath,'utf8'),raw,
      'adapter must leave JSON/schema validation and raw archiving to the workflow');
    const snapshot=path.join(malformed.outputDirectory,complete.resultFile);
    assert.deepEqual(fs.readFileSync(snapshot),Buffer.from(raw));
    fs.appendFileSync(malformed.resultPath,'\nchanged');
    const changed=x.ok('host',['collect',malformed.requestPath]);
    assert.equal(changed.state,'completed','native result.json may change after the terminal snapshot');
    assert.deepEqual(fs.readFileSync(snapshot),Buffer.from(raw));
    fs.chmodSync(snapshot,0o600);fs.appendFileSync(snapshot,'\nchanged');
    const tampered=x.ok('host',['collect',malformed.requestPath]);
    assert.equal(tampered.state,'unknown');assert.match(tampered.reason,/snapshot.*changed/);
    const linked=x.dispatch('linked-file'),outside=path.join(x.root,'outside.json');
    fs.writeFileSync(outside,'{"complete":true}');
    x.ok('host',['start',linked.requestPath],{env:{FAKE_RESULT_LINK:outside}});
    const linkedHome=path.join(x.runtime,'runs',sha('linked-file').slice(0,32));
    until(()=>fs.existsSync(path.join(linkedHome,'finished.json')),Boolean);
    assert.equal(x.ok('host',['collect',linked.requestPath]).state,'unknown');
  }finally{x.cleanup();}
});

test('bootstrap 在 plan 前持久启动真实路由的 L1，并从原生最终消息生成可验身份的计划',()=>{
  const x=fixture();
  try{
    const {requestPath,promptPath}=x.bootstrap('fixed-plan-token');
    const authored={inputVersion:'input-v1',sourceVersion:'source-v1',
      capabilities:{framework:'fixture-dsh',mainModel:'coordinator',modelRouting:'per_agent',models:['fixture/model']},
      policy:{agents:2,issues:1,tests:1,noProgress:2,rounds:2},
      tickets:[{number:101,kind:'software',dependencies:[],criteria:['done'],visual:false}],specCriteria:['done']};
    const env={FAKE_FINAL_JSON:JSON.stringify(authored)};
    assert.equal(x.ok('bootstrap',['query',requestPath]).state,'not_found');
    const started=x.ok('bootstrap',['start',requestPath],{env});
    assert.ok(['running','completed'].includes(started.state));assert.ok(started.nativeId);
    const collected=until(()=>x.ok('bootstrap',['collect',requestPath]),r=>r.state==='completed');
    assert.equal(collected.nativeId,started.nativeId);
    assert.equal(collected.jobId,'$spec:execution-plan');
    assert.equal(collected.usage.events[0].usage.inputTokens,11);
    const plan=JSON.parse(fs.readFileSync(collected.planPath,'utf8'));
    assert.equal(plan.decisionNativeId,started.nativeId);
    assert.equal(plan.inputVersion,'input-v1');assert.equal(plan.sourceVersion,'source-v1');
    assert.deepEqual(JSON.parse(fs.readFileSync(plan.evidencePath,'utf8')),authored);
    assert.equal(sha(fs.readFileSync(collected.planPath)),collected.planSha256);
    assert.equal(sha(fs.readFileSync(plan.evidencePath)),collected.rawSha256);
    assert.equal(x.ok('observe',['observe',started.nativeId,'$spec:execution-plan']).model,'model');
    assert.equal(x.ok('bootstrap',['start',requestPath]).nativeId,started.nativeId);
    assert.equal(fs.readFileSync(x.starts,'utf8').trim().split('\n').length,1);
    fs.appendFileSync(promptPath,'changed\n');
    assert.equal(x.ok('bootstrap',['query',requestPath]).nativeId,started.nativeId,
      '外部提示词变化不影响已固定 token 的查询和原始快照');
    fs.unlinkSync(promptPath);
    assert.equal(x.ok('bootstrap',['collect',requestPath]).nativeId,started.nativeId,
      '提示词来源消失后仍可按持久 manifest 收取');
    const routeFile=JSON.parse(fs.readFileSync(x.configPath,'utf8')).routes[0].settingsFile;
    fs.writeFileSync(routeFile,'agent-default-model: changed-after-start\n');
    assert.equal(x.ok('bootstrap',['query',requestPath]).nativeId,started.nativeId,
      '外部路由文件变化不能改写已持久化的原生路线证明');
    fs.appendFileSync(collected.planPath,' ');
    const tampered=x.ok('bootstrap',['collect',requestPath]);
    assert.equal(tampered.state,'unknown');assert.match(tampered.reason,/artifact/);
  }finally{x.cleanup();}
});

test('bootstrap 模型错配和非 JSON 最终消息不能交付计划；availability 不伪称 unavailable',()=>{
  const x=fixture();
  try{
    const wrong=x.bootstrap('wrong-bootstrap');
    const started=x.ok('bootstrap',['start',wrong.requestPath],{env:{FAKE_PROVIDER:'other',FAKE_FINAL_JSON:'{}'}});
    assert.equal(started.state,'unknown');
    assert.equal(x.ok('bootstrap',['collect',wrong.requestPath]).state,'unknown');
    assert.equal(fs.existsSync(wrong.outputDirectory)&&fs.readdirSync(wrong.outputDirectory).length,0);
    const malformed=x.bootstrap('malformed-bootstrap');
    x.ok('bootstrap',['start',malformed.requestPath],{env:{FAKE_FINAL_JSON:'not a JSON plan'}});
    const settled=until(()=>x.ok('bootstrap',['collect',malformed.requestPath]),r=>r.state==='unknown'&&!!r.nativeId);
    assert.match(settled.reason,/durable final message/);
    const missing=x.call('observe',['availability',settled.nativeId,'$spec:execution-plan']);
    assert.notEqual(missing.status,0);assert.match(missing.stderr,/不能证明|不可恢复/);
  }finally{x.cleanup();}
});

test('Codex 主会话 observer 只从当前 rollout 元数据和 turn_context 提取身份摘要',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-main-observer-'));
  try{
    const id='01234567-89ab-cdef-0123-456789abcdef';
    const day=path.join(root,'sessions','2026','09','27');fs.mkdirSync(day,{recursive:true});
    const file=path.join(day,`rollout-test-${id}.jsonl`);
    const events=[{type:'session_meta',timestamp:'2026-09-27T00:00:00Z',payload:{id,session_id:id,model_provider:'openai'}},
      {type:'turn_context',timestamp:'2026-09-27T01:00:00Z',payload:{model:'gpt-6-sol'}}];
    fs.writeFileSync(file,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
    const env={...process.env,CODEX_HOME:root,CODEX_SESSION_ID:id,CODEX_THREAD_ID:id};
    const run=(nativeId:string,jobId='$main',alter={})=>spawnSync(process.execPath,[mainObserver,'observe',nativeId,jobId],
      {env:{...env,...alter},encoding:'utf8'});
    const result=run(id);assert.equal(result.status,0,result.stderr);
    const observed=JSON.parse(result.stdout);
    assert.equal(observed.nativeId,id);assert.equal(observed.provider,'openai');
    assert.equal(observed.model,'gpt-6-sol');assert.equal(observed.context.mode,'new');
    assert.ok(observed.context.proofId);assert.ok(!result.stdout.includes('rollout-test'));
    assert.notEqual(run('another-session').status,0);
    assert.notEqual(run(id,'job-1').status,0);
    assert.notEqual(run(id,'$main',{CODEX_THREAD_ID:'another-session'}).status,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('统一技能契约：源码实际加载并归档后才签发 source_execution 回执',()=>{
  const x=fixture();
  try{
    const {requestPath}=x.dispatch('skill');
    const started=x.ok('host',['start',requestPath]);
    const session=x.ok('observe',['observe',started.nativeId,'job-skill']);
    const invocationId='invoke-skill',sourceArchivePath=path.join(x.root,'source.json');
    const skill='---\nname: fixture-skill\n---\n\nPerform a fixture review.\n';
    const loadedFiles=[{relativePath:'SKILL.md',sha256:sha(skill)}];
    fs.writeFileSync(sourceArchivePath,JSON.stringify({fingerprint:'fixed-skill-fingerprint',
      files:[{...loadedFiles[0],dataBase64:Buffer.from(skill).toString('base64')}]}));
    fs.writeFileSync(x.statePath,JSON.stringify({jobs:[{id:'job-skill',nativeId:started.nativeId,session}],
      v3:{skillBindings:[{capability:'authorReview'}],skillInvocations:[{id:invocationId,jobId:'job-skill',
        capability:'authorReview',bindingFingerprint:'fixed-skill-fingerprint',mode:'source_execution',sourceArchivePath}]}}));
    const capability=x.ok('skill',['capabilities','authorReview','job-skill'],{cwd:x.stateDir});
    assert.equal(capability.capabilities.nativeExplicit.supported,false);
    assert.equal(capability.capabilities.sourceExecution.allowed,true);
    const before=x.call('skill',['result',invocationId,'job-skill'],{cwd:x.stateDir});
    assert.notEqual(before.status,0,'未加载源码不能签发完成回执');
    const dshHome=path.join(x.runtime,'runs',sha('skill').slice(0,32));
    const opened=x.call('skill-open',[x.statePath,invocationId],{env:{DSH_HOME:dshHome}});
    assert.equal(opened.status,0,opened.stderr);assert.match(opened.stdout,/Perform a fixture review/);
    const raw=path.join(x.root,'review.md');fs.writeFileSync(raw,'Independent review complete\n');
    x.ok('skill-complete',[x.statePath,invocationId,raw],{env:{DSH_HOME:dshHome}});
    const receipt=x.ok('skill',['result',invocationId,'job-skill'],{cwd:x.stateDir});
    assert.equal(receipt.mode,'source_execution');assert.equal(receipt.terminal,true);
    assert.deepEqual(receipt.loadedFiles,loadedFiles);
  }finally{x.cleanup();}
});

test('错误模型路由拒绝观测，启动失联后 token 可查询，取消保留实例',()=>{
  const x=fixture();
  try{
    const {requestPath}=x.dispatch('wrong');
    const started=x.ok('host',['start',requestPath],{env:{FAKE_PROVIDER:'other'}});
    assert.ok(started.nativeId);
    const denied=x.call('observe',['observe',started.nativeId,'job-wrong']);
    assert.notEqual(denied.status,0);assert.match(denied.stderr,/provider\/model/);
    assert.equal(x.ok('host',['query',requestPath]).nativeId,started.nativeId,
      '错误绑定后原生实例仍按 token 保留');
    const second=x.dispatch('cancel');
    const running=x.ok('host',['start',second.requestPath],{env:{FAKE_HOLD_MS:'10000'}});
    assert.equal(running.state,'running');
    const stopped=x.ok('host',['cancel',second.requestPath]);
    assert.equal(stopped.state,'cancelled');assert.equal(stopped.nativeId,running.nativeId);
    assert.equal(x.ok('host',['query',second.requestPath]).state,'cancelled');
  }finally{x.cleanup();}
});

test('回执修复任务沿用持久派发，不依赖普通 actor packet 的 cwd/executor 字段',()=>{
  const x=fixture();
  try{
    const {requestPath,packetPath}=x.dispatch('repair');
    const packet=JSON.parse(fs.readFileSync(packetPath,'utf8'));
    delete packet.executor;delete packet.worktree;delete packet.repo;
    packet.action='repair-receipt';
    fs.writeFileSync(packetPath,JSON.stringify(packet));
    const started=x.ok('host',['start',requestPath]);
    const finished=until(()=>x.ok('host',['query',requestPath]),r=>r.state==='completed');
    assert.equal(finished.nativeId,started.nativeId);
    assert.equal(x.ok('host',['collect',requestPath]).state,'completed');
  }finally{x.cleanup();}
});

test('调试探测提示词在普通宿主配置中关闭',()=>{
  const x=fixture();
  try{
    const conf=JSON.parse(fs.readFileSync(x.configPath,'utf8'));
    delete conf.allowProbeTask;conf.startWaitMs=200;fs.writeFileSync(x.configPath,JSON.stringify(conf));
    const {requestPath}=x.dispatch('disabled-probe');
    x.ok('host',['start',requestPath]);
    const queried=x.ok('host',['query',requestPath]);
    assert.equal(queried.state,'unknown');
    assert.equal(fs.existsSync(x.starts),false,'普通配置不得启动调试提示词的模型');
  }finally{x.cleanup();}
});

test('停止后的技能续接由新 actor 重载原文；旧 actor 的加载记录不冒充新完成回执',()=>{
  const x=fixture();
  try{
    const prior=x.dispatch('prior'),successor=x.dispatch('successor');
    const old=x.ok('host',['start',prior.requestPath]);
    const next=x.ok('host',['start',successor.requestPath]);
    const oldSession=x.ok('observe',['observe',old.nativeId,'job-prior']);
    const nextSession=x.ok('observe',['observe',next.nativeId,'job-successor']);
    const invocationId='resumable-skill',sourceArchivePath=path.join(x.root,'source.json');
    const skill='---\nname: resumable\n---\n\nContinue from preserved child results.\n';
    fs.writeFileSync(sourceArchivePath,JSON.stringify({fingerprint:'same-version',
      files:[{relativePath:'SKILL.md',sha256:sha(skill),dataBase64:Buffer.from(skill).toString('base64')}]}));
    const invocation={id:invocationId,jobId:'job-prior',capability:'implementation',
      bindingFingerprint:'same-version',mode:'source_execution',sourceArchivePath};
    const writeState=(jobId:string,nativeId:string,session:object)=>fs.writeFileSync(x.statePath,
      JSON.stringify({jobs:[{id:jobId,nativeId,session}],v3:{skillBindings:[{capability:'implementation'}],
        skillInvocations:[{...invocation,jobId}]}}));
    writeState('job-prior',old.nativeId,oldSession);
    const oldHome=path.join(x.runtime,'runs',sha('prior').slice(0,32));
    assert.equal(x.call('skill-open',[x.statePath,invocationId],{env:{DSH_HOME:oldHome}}).status,0);
    writeState('job-successor',next.nativeId,nextSession);
    assert.notEqual(x.call('skill',['result',invocationId,'job-successor'],{cwd:x.stateDir}).status,0);
    const newHome=path.join(x.runtime,'runs',sha('successor').slice(0,32));
    assert.equal(x.call('skill-open',[x.statePath,invocationId],{env:{DSH_HOME:newHome}}).status,0);
    const raw=path.join(x.root,'continued.md');fs.writeFileSync(raw,'Continued the same invocation\n');
    x.ok('skill-complete',[x.statePath,invocationId,raw],{env:{DSH_HOME:newHome}});
    const receipt=x.ok('skill',['result',invocationId,'job-successor'],{cwd:x.stateDir});
    assert.equal(receipt.nativeId,next.nativeId);
    assert.notEqual(receipt.nativeId,old.nativeId);
  }finally{x.cleanup();}
});
