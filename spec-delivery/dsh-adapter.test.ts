import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const adapter=fileURLToPath(new URL('./adapters/dsh.mjs',import.meta.url));
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
const dir=path.join(home,'sessions','--fixture--',id);fs.mkdirSync(dir,{recursive:true});
const now=Date.now();const event=[
  {type:'session',id,createdAt:now,cwd:process.cwd()},
  {type:'assistant/message',seq:1,time:now+1,data:{message:{role:'assistant',source:{kind:'model',provider:process.env.FAKE_PROVIDER,model:process.env.FAKE_MODEL},
    content:[{type:'text',text:process.env.FAKE_FINAL_JSON}]},usage:{inputTokens:11,outputTokens:7,totalTokens:18,cachedInputTokens:3}}},
];
const plain=path.join(dir,'events.jsonl');fs.writeFileSync(plain,event.map(x=>JSON.stringify(x)).join('\\n')+'\\n');
const zip=spawnSync(${JSON.stringify(zstd)},['-q','-f',plain,'-o',path.join(dir,'session.v3.jsonl.zstd')]);
if(zip.status!==0)process.exit(3);
await new Promise(resolve=>setTimeout(resolve,Number(process.env.FAKE_HOLD_MS||0)));
console.log(process.env.FAKE_FINAL_JSON);
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
    fs.writeFileSync(packetPath,JSON.stringify({jobId:`job-${token}`,model:'fixture/model',executor:'agent',
      dispatchToken:token,repo:{root},worktree:root,outputDirectory,
      adapterProbeTask:'Return exactly the configured probe Result JSON.'}));
    const requestPath=path.join(stateDir,`${token}.request.json`);
    fs.writeFileSync(requestPath,JSON.stringify({token,jobId:`job-${token}`,attempt:1,targetHost:'fixture-dsh',
      requestedModel:'fixture/model',packetPath}));
    return {requestPath,packetPath,outputDirectory};
  }
  return {root,runtime,statePath,stateDir,configPath,starts,env,call,ok,dispatch,
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
