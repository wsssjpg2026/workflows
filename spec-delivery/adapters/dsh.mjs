#!/usr/bin/env node
/** DeepSeek Harness bridge for the v3 host, session, and bound-skill protocols. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self=fileURLToPath(import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{throw new Error(message);};
const assert=(condition,message)=>{if(!condition)fail(message);};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const now=()=>new Date().toISOString();
function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.renameSync(temp,file);
}
function config(file){
  const c=read(path.resolve(file));
  assert(c?.schema===1&&typeof c.hostId==='string'&&c.hostId&&path.isAbsolute(c.runtimeRoot),
    '配置需 schema:1、hostId 和绝对 runtimeRoot');
  assert(Array.isArray(c.routes)&&c.routes.length&&c.routes.every(r=>r&&typeof r.requestedModel==='string'&&
    r.requestedModel&&typeof r.provider==='string'&&r.provider&&typeof r.model==='string'&&r.model&&
    path.isAbsolute(r.settingsFile)&&fs.statSync(r.settingsFile).isFile()),'路由需 requestedModel/provider/model/settingsFile');
  assert(new Set(c.routes.map(r=>r.requestedModel)).size===c.routes.length,'请求模型路由重复');
  assert(path.isAbsolute(c.dshBin)&&fs.statSync(c.dshBin).isFile()&&
    path.isAbsolute(c.zstdBin)&&fs.statSync(c.zstdBin).isFile(),'dsh/zstd 必须为可执行绝对路径');
  if(c.credentialsFile)assert(path.isAbsolute(c.credentialsFile)&&fs.statSync(c.credentialsFile).isFile(),
    '凭据来源不可读');
  if(c.workflowEntry)assert(path.isAbsolute(c.workflowEntry)&&fs.statSync(c.workflowEntry).isFile(),
    'workflowEntry 不可读取');
  c.profile ||= 'headless';
  c.startWaitMs=Math.min(Math.max(Number(c.startWaitMs)||10000,100),60000);
  c.taskTimeoutMs=Math.min(Math.max(Number(c.taskTimeoutMs)||900000,1000),3600000);
  return c;
}
function command(bin,args,options={}){
  const result=spawnSync(bin,args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:30000,...options});
  return {code:result.status,stdout:result.stdout||'',stderr:result.stderr||'',error:result.error?.message};
}
function request(c,file){
  const raw=fs.readFileSync(file),r=JSON.parse(raw.toString('utf8'));
  assert(r?.targetHost===c.hostId&&typeof r.token==='string'&&r.token&&typeof r.jobId==='string'&&r.jobId&&
    typeof r.requestedModel==='string'&&path.isAbsolute(r.packetPath),'派发请求与宿主配置不符');
  const route=c.routes.find(x=>x.requestedModel===r.requestedModel);
  assert(route,'请求模型不在已配置路由中');
  const packet=read(r.packetPath);
  assert(packet.jobId===r.jobId&&packet.model===r.requestedModel&&packet.dispatchToken===r.token&&
    (packet.executor==='agent'||packet.action==='repair-receipt')&&path.isAbsolute(packet.outputDirectory),
    '派发 packet 与持久请求不符');
  return {r,route,packet,digest:sha(raw)};
}
const runId=token=>sha(token).slice(0,32);
const homeFor=(c,token)=>path.join(c.runtimeRoot,'runs',runId(token));
function manifest(c,r,digest){
  const home=homeFor(c,r.token);
  if(!fs.existsSync(home))return null;
  const file=path.join(home,'manifest.json');
  if(!fs.existsSync(file))return {home,unsettled:true};
  const m=read(file);
  assert(m.token===r.token&&m.jobId===r.jobId&&m.targetHost===r.targetHost&&
    m.requestDigest===digest&&m.requestedModel===r.requestedModel,'token 已关联另一派发请求');
  return {...m,home};
}
function sessionLogs(home){
  const root=path.join(home,'sessions');
  if(!fs.existsSync(root))return [];
  const found=[];
  for(const cwd of fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory())){
    const one=path.join(root,cwd.name);
    for(const session of fs.readdirSync(one,{withFileTypes:true}).filter(x=>x.isDirectory())){
      const dir=path.join(one,session.name);
      const log=path.join(dir,'session.v3.jsonl.zstd');
      if(fs.existsSync(log))found.push({id:session.name,log,dir});
    }
  }
  return found;
}
function observeLog(c,session){
  const output=command(c.zstdBin,['-dc',session.log]);
  const events=[];
  for(const line of output.stdout.split(/\r?\n/)){
    if(!line.trim())continue;
    try{events.push(JSON.parse(line));}catch{ /* an in-progress compressed frame may end mid-line */ }
  }
  const origin=events.find(e=>e.type==='session'&&e.id===session.id);
  const messages=events.filter(e=>e.type==='assistant/message'&&e.data?.message?.source?.kind==='model');
  const sources=[...new Set(messages.map(e=>`${e.data.message.source.provider}\0${e.data.message.source.model}`))];
  const source=sources.length===1?messages[0].data.message.source:null;
  const last=messages.at(-1)?.data?.message?.content;
  const finalText=Array.isArray(last)?last.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join(''):'';
  const usage=messages.filter(e=>e.data?.usage&&typeof e.data.usage==='object').map(e=>({
    seq:e.seq??null,time:e.time??null,usage:e.data.usage,
  }));
  return {origin,source,sourceCount:sources.length,finalText,usage,
    completeFrame:output.code===0,readError:output.error||null};
}
function uniqueSession(c,home){
  const logs=sessionLogs(home);
  if(logs.length!==1)return {session:null,observation:null,ambiguity:logs.length};
  const observation=observeLog(c,logs[0]);
  return {session:logs[0],observation,ambiguity:0};
}
function groupAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  if(fs.existsSync('/proc')){
    for(const name of fs.readdirSync('/proc')){
      if(!/^\d+$/.test(name))continue;
      try{
        const stat=fs.readFileSync(`/proc/${name}/stat`,'utf8');
        const tail=stat.slice(stat.lastIndexOf(')')+2).split(' ');
        if(Number(tail[2])===pid&&tail[0]!=='Z')return true;
      }catch{/* process exited while scanning */}
    }
    return false;
  }
  try{process.kill(-pid,0);return true;}catch{return false;}
}
function hostReply(c,r,digest,operation){
  const m=manifest(c,r,digest);
  const base={token:r.token,jobId:r.jobId,targetHost:r.targetHost,continuationSupported:false};
  if(!m)return {...base,state:'not_found',authoritative:true};
  if(m.unsettled)return {...base,state:'unknown',reason:'token intent exists without manifest'};
  const {session,observation,ambiguity}=uniqueSession(c,m.home);
  if(ambiguity||!session||!observation?.origin||!observation.source||observation.sourceCount!==1)
    return {...base,state:'unknown',reason:ambiguity?'multiple native sessions':'native model/session not yet observed'};
  const nativeId=`${runId(r.token)}/${session.id}`;
  const finishedPath=path.join(m.home,'finished.json'),cancelledPath=path.join(m.home,'cancelled.json');
  const finished=fs.existsSync(finishedPath)?read(finishedPath):null;
  const cancelled=fs.existsSync(cancelledPath)?read(cancelledPath):null;
  const usage={events:observation.usage,sessionLog:session.log};
  const fields={...base,nativeId,startedAt:new Date(observation.origin.createdAt).toISOString(),usage};
  if(cancelled)return {...fields,state:'cancelled',cancelledAt:cancelled.at};
  if(finished){
    const resultFile=finished.resultFile;
    if(!resultFile)return {...fields,state:'unknown',reason:'native task finished without a durable final message'};
    return {...fields,state:'completed',completedAt:finished.at,resultFile};
  }
  const launchPath=path.join(m.home,'launch.json');
  if(fs.existsSync(launchPath)&&!groupAlive(read(launchPath).pid))
    return {...fields,state:'unknown',reason:'native worker exited without durable completion marker'};
  if(operation==='collect')return {...fields,state:'running'};
  return {...fields,state:'running'};
}
function start(c,configPath,file){
  const {r,route,packet,digest}=request(c,file),base={token:r.token,jobId:r.jobId,targetHost:r.targetHost};
  const existing=manifest(c,r,digest);
  if(existing)return hostReply(c,r,digest,'start');
  const home=homeFor(c,r.token);
  fs.mkdirSync(path.dirname(home),{recursive:true});
  try{fs.mkdirSync(home,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;return hostReply(c,r,digest,'start');}
  atomic(path.join(home,'manifest.json'),{...base,requestedModel:r.requestedModel,requestDigest:digest,
    packetPath:r.packetPath,outputDirectory:packet.outputDirectory,startedAt:now(),routeIndex:c.routes.indexOf(route)});
  const child=spawn(process.execPath,[self,'worker',path.resolve(configPath),home],{
    detached:true,stdio:'ignore',env:{...process.env,DSH_ADAPTER_WORKER:'1'}});
  child.unref();
  atomic(path.join(home,'launch.json'),{pid:child.pid,at:now()});
  const until=Date.now()+c.startWaitMs;
  while(Date.now()<until){
    const result=hostReply(c,r,digest,'start');
    if(result.state==='running'||result.state==='completed'||result.state==='cancelled')return result;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  }
  return {...base,state:'unknown',reason:'native session/model not observable before startup deadline'};
}
function host(c,configPath,operation,file){
  const {r,digest}=request(c,file);
  if(operation==='start')return start(c,configPath,file);
  if(operation==='query'||operation==='collect')return hostReply(c,r,digest,operation);
  assert(operation==='cancel','未知宿主操作');
  const m=manifest(c,r,digest),current=hostReply(c,r,digest,'query');
  if(!m||m.unsettled)return current;
  if(['completed','cancelled'].includes(current.state))return current;
  const launchPath=path.join(m.home,'launch.json');
  if(!fs.existsSync(launchPath))return {...current,state:'unknown'};
  const pid=read(launchPath).pid;
  if(!fs.existsSync(path.join(m.home,'cancel-requested.json')))
    atomic(path.join(m.home,'cancel-requested.json'),{at:now(),pid});
  if(groupAlive(pid))try{process.kill(-pid,'SIGTERM');}catch{ /* next query retains uncertain state */ }
  const until=Date.now()+3000;
  while(groupAlive(pid)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  if(groupAlive(pid))return {...current,state:'unknown',reason:'process group stop is not confirmed'};
  if(!fs.existsSync(path.join(m.home,'cancelled.json')))
    atomic(path.join(m.home,'cancelled.json'),{at:now(),pid});
  return hostReply(c,r,digest,'cancel');
}
function actorPrompt(packet,c,configPath){
  if(typeof packet.adapterProbeTask==='string'){
    assert(c.allowProbeTask===true,'probe task 只允许隔离测试配置');
    return packet.adapterProbeTask;
  }
  assert(c.workflowEntry,'真实工作流任务需要配置 workflowEntry');
  const statePath=path.join(path.dirname(path.dirname(packet.__packetPath)),'state.json');
  return `You are executing one bounded spec-delivery job. Read the packet at ${JSON.stringify(packet.__packetPath)} and roles at ${JSON.stringify(packet.rolesPath)}. Follow its exact action, approved plan/checks and skill bindings. The public workflow CLI is node ${JSON.stringify(c.workflowEntry)}; its state is ${JSON.stringify(statePath)}. Before invoking a workflow command, poll the read-only inspect command until this job shows a bound native session; the host binds it immediately after observing your first model event. For a bound skill use skill-start, then load the returned original source with node ${JSON.stringify(self)} skill-open ${JSON.stringify(configPath)} ${JSON.stringify(statePath)} <invocationId>, do the skill's work including skill-delegate/skill-continue, write a raw report, run node ${JSON.stringify(self)} skill-complete ${JSON.stringify(configPath)} ${JSON.stringify(statePath)} <invocationId> <rawOutputPath>, then skill-finish. Run tests with the workflow test command. Do not edit workflow state directly or start hidden agents. Return only one Result JSON object with complete/status/evidencePath and action-specific fields. Do not supply model or native identity. If unable to finish, return complete:false with an evidence file.`;
}
async function worker(c,home,configPath){
  const m=read(path.join(home,'manifest.json')),route=c.routes[m.routeIndex],packet=read(m.packetPath);
  packet.__packetPath=m.packetPath;
  fs.copyFileSync(route.settingsFile,path.join(home,'settings.yaml'));
  if(c.credentialsFile)fs.symlinkSync(c.credentialsFile,path.join(home,'.credentials.yaml'));
  fs.writeFileSync(path.join(home,'patch.yml'),'[]\n',{flag:'wx',mode:0o600});
  fs.mkdirSync(path.join(home,'sessions'),{recursive:true});
  const cwd=packet.worktree||packet.repo?.root||path.dirname(path.dirname(m.packetPath));
  assert(path.isAbsolute(cwd)&&fs.statSync(cwd).isDirectory(),'任务 cwd 不可读取');
  const stdout=fs.openSync(path.join(home,'stdout.log'),'w',0o600),stderr=fs.openSync(path.join(home,'stderr.log'),'w',0o600);
  const prompt=actorPrompt(packet,c,configPath);
  const args=['--profile',c.profile,'--patch',path.join(home,'patch.yml'),prompt];
  const child=spawn(c.dshBin,args,{cwd,env:{...process.env,DSH_HOME:home,
    DSH_PERMISSION_MODE:c.permissionMode||'danger-full-access'},stdio:['ignore',stdout,stderr]});
  atomic(path.join(home,'native-process.json'),{pid:child.pid,at:now()});
  let timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;try{child.kill('SIGTERM');}catch{}},c.taskTimeoutMs);
  const exitCode=await new Promise(resolve=>{
    child.once('exit',(code,signal)=>resolve({code,signal}));
    child.once('error',error=>resolve({code:null,signal:null,error:error.message}));
  });
  clearTimeout(timeout);fs.closeSync(stdout);fs.closeSync(stderr);
  const {session,observation}=uniqueSession(c,home);
  let resultFile=null;
  if(session&&observation?.finalText){
    fs.mkdirSync(m.outputDirectory,{recursive:true});
    resultFile=`dsh-final-${runId(m.token).slice(0,12)}.txt`;
    fs.writeFileSync(path.join(m.outputDirectory,resultFile),observation.finalText,{flag:'wx',mode:0o600});
  }
  atomic(path.join(home,'finished.json'),{at:now(),exitCode:exitCode.code,signal:exitCode.signal,
    spawnError:exitCode.error||null,timedOut,resultFile});
}
function locateNative(c,nativeId,jobId){
  const match=/^([0-9a-f]{32})\/(session-[A-Za-z0-9-]+)$/.exec(nativeId);
  assert(match,'原生身份格式不符');
  const home=path.join(c.runtimeRoot,'runs',match[1]),m=read(path.join(home,'manifest.json'));
  assert(m.jobId===jobId&&runId(m.token)===match[1],'原生会话不属于该 job/token');
  const {session,observation,ambiguity}=uniqueSession(c,home);
  assert(!ambiguity&&session?.id===match[2]&&observation?.origin&&observation.source&&
    observation.sourceCount===1,'原生会话与 provider/model 日志未获一致观测');
  return {home,m,session,observation};
}
function observe(c,nativeId,jobId){
  const {m,session,observation}=locateNative(c,nativeId,jobId),origin=observation.origin;
  const sourceEvent=observation.source;
  const route=c.routes.find(r=>r.requestedModel===m.requestedModel);
  assert(route&&route.provider===sourceEvent.provider&&route.model===sourceEvent.model,
    '真实 provider/model 与请求路由不符');
  const proofId=sha(JSON.stringify({id:origin.id,createdAt:origin.createdAt,cwd:origin.cwd,log:session.log}));
  return {source:'native_host',observationId:sha(`${proofId}:${sourceEvent.provider}:${sourceEvent.model}`),
    jobId,nativeId,provider:sourceEvent.provider,model:sourceEvent.model,
    observedAt:new Date(origin.createdAt).toISOString(),
    context:{contextId:origin.id,mode:'new',proofId}};
}
function stateAtCwd(){return read(path.join(process.cwd(),'state.json'));}
function skillCapabilities(c,capability,jobId){
  const state=stateAtCwd();assert(state.jobs.some(j=>j.id===jobId),'技能能力查询的 job 不存在');
  assert(state.v3?.skillBindings?.some(b=>b.capability===capability),'技能能力未固定');
  return {source:'native_host',jobId,capability,capabilities:{nativeExplicit:{supported:false,registrations:[]},
    sourceExecution:{allowed:c.sourceExecution!==false,acceptsOriginalFiles:true}}};
}
function skillRecordPath(c,invocationId,nativeId,leaf){
  return path.join(c.runtimeRoot,'skills',sha(invocationId),'actors',sha(nativeId),leaf);
}
function invokingActor(c,statePath,invocationId){
  const state=read(statePath),invocation=state.v3?.skillInvocations?.find(i=>i.id===invocationId);
  assert(invocation,'技能调用不存在');
  const job=state.jobs.find(j=>j.id===invocation.jobId);
  assert(job?.nativeId&&job.session,'技能调用没有已绑定原生 actor');
  const dshHome=process.env.DSH_HOME;
  assert(dshHome&&path.resolve(dshHome)===path.resolve(locateNative(c,job.nativeId,job.id).home),
    'skill-open/complete 必须由原生 actor 的 DSH_HOME 执行');
  return {state,invocation,job};
}
function skillOpen(c,statePath,invocationId){
  const {invocation,job}=invokingActor(c,statePath,invocationId);
  assert(invocation.mode==='source_execution'&&!invocation.result,'宿主仅实现 source_execution 的在途调用');
  const bundle=read(invocation.sourceArchivePath);
  assert(bundle.fingerprint===invocation.bindingFingerprint&&Array.isArray(bundle.files),'技能来源包与调用不符');
  const root=skillRecordPath(c,invocationId,job.nativeId,'loaded');
  fs.mkdirSync(root,{recursive:true});
  const loadedFiles=[];
  for(const file of bundle.files){
    assert(typeof file.relativePath==='string'&&!file.relativePath.startsWith('/')&&
      !file.relativePath.split('/').includes('..'),'技能资源路径不安全');
    const bytes=Buffer.from(file.dataBase64,'base64');
    assert(sha(bytes)===file.sha256,'技能资源字节不匹配');
    const destination=path.join(root,file.relativePath);
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    if(!fs.existsSync(destination))fs.writeFileSync(destination,bytes,{flag:'wx',mode:0o600});
    else assert(fs.readFileSync(destination).equals(bytes),'技能资源已改变');
    loadedFiles.push({relativePath:file.relativePath,sha256:file.sha256});
  }
  const record={invocationId,jobId:job.id,nativeId:job.nativeId,sourcePath:invocation.sourceArchivePath,
    bindingFingerprint:invocation.bindingFingerprint,loadedFiles,at:now()};
  const receipt=skillRecordPath(c,invocationId,job.nativeId,'loaded.json');
  if(!fs.existsSync(receipt))atomic(receipt,record);
  else assert(JSON.stringify(read(receipt).loadedFiles)===JSON.stringify(loadedFiles),'已加载资源版本改变');
  return `${fs.readFileSync(path.join(root,'SKILL.md'),'utf8')}\n\nReferenced resources loaded at: ${root}\n`;
}
function skillComplete(c,statePath,invocationId,rawOutputPath){
  const {invocation,job}=invokingActor(c,statePath,invocationId);
  const loaded=read(skillRecordPath(c,invocationId,job.nativeId,'loaded.json'));
  assert(loaded.jobId===job.id&&loaded.nativeId===job.nativeId,'技能原文加载不属于当前 actor');
  const bytes=fs.readFileSync(rawOutputPath);
  assert(bytes.toString('utf8').trim(),'技能原始产物为空');
  const record={invocationId,jobId:job.id,nativeId:job.nativeId,rawOutputPath:path.resolve(rawOutputPath),
    rawSha256:sha(bytes),at:now()};
  const file=skillRecordPath(c,invocationId,job.nativeId,'completed.json');
  if(!fs.existsSync(file))atomic(file,record);
  else assert(read(file).rawSha256===record.rawSha256,'技能完成产物与前次不一致');
  return {recordPath:file,mode:invocation.mode};
}
function skillResult(c,invocationId,jobId){
  const state=stateAtCwd(),invocation=state.v3?.skillInvocations?.find(i=>i.id===invocationId);
  assert(invocation?.jobId===jobId&&invocation.mode==='source_execution','技能结果调用或模式不符');
  const job=state.jobs.find(j=>j.id===jobId);
  assert(job?.nativeId,'技能结果缺少已绑定 actor');
  const loaded=read(skillRecordPath(c,invocationId,job.nativeId,'loaded.json')),
    completed=read(skillRecordPath(c,invocationId,job.nativeId,'completed.json'));
  assert(job?.session&&loaded.jobId===jobId&&loaded.nativeId===job.nativeId&&
    completed.jobId===jobId&&completed.nativeId===job.nativeId&&
    sha(fs.readFileSync(completed.rawOutputPath))===completed.rawSha256,
    '技能未由原 actor 完整加载和完成');
  const bundle=read(invocation.sourceArchivePath);
  assert(JSON.stringify(loaded.loadedFiles)===JSON.stringify(bundle.files.map(f=>({relativePath:f.relativePath,sha256:f.sha256}))),
    '技能源码或依赖未逐字加载');
  return {source:'native_host',invocationId,jobId,nativeId:job.nativeId,
    observationId:job.session.observationId,mode:'source_execution',
    bindingFingerprint:invocation.bindingFingerprint,terminal:true,loadedFiles:loaded.loadedFiles};
}
function probe(c){
  const dsh=command(c.dshBin,['--version']),zstd=command(c.zstdBin,['--version']);
  return {adapter:'dsh-v3',hostId:c.hostId,installed:{dsh:dsh.code===0,zstd:zstd.code===0,
    credentialsPresent:!!c.credentialsFile},routes:c.routes.map(r=>({requestedModel:r.requestedModel,
    expectedProvider:r.provider,expectedModel:r.model,settingsPresent:true,nativeRouteVerified:false})),
    capabilities:{tokenQuery:'adapter-persistent',sessionObservation:'requires-native-probe',
      skillMode:c.sourceExecution===false?'unavailable':'source_execution',nativeExplicit:false,
      nativeResume:false,rawUsage:'requires-native-probe',stop:'process-group-request-plus-reconcile'},
    note:'This is a read-only installation probe. No provider route, native skill or recovery success is claimed.'};
}
function shellQuote(value){return `'${String(value).replaceAll("'","'\\''")}'`;}
function install(configPath,directory){
  fs.mkdirSync(directory,{recursive:true});
  const entries={host:'dsh-host',observe:'dsh-observer',skill:'dsh-skill-observer'};
  for(const [mode,name] of Object.entries(entries)){
    const file=path.join(directory,name);
    fs.writeFileSync(file,`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(self)} ${mode} ${shellQuote(path.resolve(configPath))} "$@"\n`,{mode:0o700});
  }
  return {host:path.join(directory,entries.host),observer:path.join(directory,entries.observe),
    skillObserver:path.join(directory,entries.skill)};
}
async function main(argv){
  const [mode,configPath,...rest]=argv;
  assert(mode&&configPath,'用法: dsh.mjs <probe|install|host|observe|skill|skill-open|skill-complete|worker> <config.json> ...');
  const c=config(configPath);
  if(mode==='probe')return probe(c);
  if(mode==='install')return install(configPath,rest[0]);
  if(mode==='host')return host(c,configPath,rest[0],rest[1]);
  if(mode==='observe'){assert(rest[0]==='observe','仅支持 observe');return observe(c,rest[1],rest[2]);}
  if(mode==='skill')return rest[0]==='capabilities'?skillCapabilities(c,rest[1],rest[2]):skillResult(c,rest[1],rest[2]);
  if(mode==='skill-open')return skillOpen(c,rest[0],rest[1]);
  if(mode==='skill-complete')return skillComplete(c,rest[0],rest[1],rest[2]);
  if(mode==='worker'){await worker(c,rest[0],path.resolve(configPath));return {finished:true};}
  fail('未知适配器命令');
}
try{
  const result=await main(process.argv.slice(2));
  if(typeof result==='string')process.stdout.write(result);
  else process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){
  // Never print the config, credential material, prompt, model output or raw logs on failure.
  process.stderr.write(`dsh adapter: ${error?.message||'operation failed'}\n`);
  process.exitCode=1;
}
