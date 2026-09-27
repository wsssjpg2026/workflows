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
function syncDir(directory){
  const fd=fs.openSync(directory,'r');
  try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`;
  const fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);
  syncDir(path.dirname(file));
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
  if(c.legacyRuntimeRoot)assert(path.isAbsolute(c.legacyRuntimeRoot)&&
    fs.statSync(c.legacyRuntimeRoot).isDirectory(),'legacyRuntimeRoot 必须是已有绝对目录');
  if(c.migrationExternalObserver)assert(path.isAbsolute(c.migrationExternalObserver)&&
    fs.statSync(c.migrationExternalObserver).isFile(),
    'migrationExternalObserver 必须是已有绝对文件');
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
  const packetBytes=fs.readFileSync(r.packetPath),packet=JSON.parse(packetBytes.toString('utf8'));
  assert(packet.jobId===r.jobId&&packet.model===r.requestedModel&&packet.dispatchToken===r.token&&
    (packet.executor==='agent'||packet.action==='repair-receipt')&&path.isAbsolute(packet.outputDirectory)&&
    path.isAbsolute(packet.resultPath)&&packet.resultPath===path.join(packet.outputDirectory,'result.json'),
    '派发 packet 与持久请求不符');
  return {r,route,packet,packetDigest:sha(packetBytes),digest:sha(raw)};
}
const runId=token=>sha(token).slice(0,32);
const homeFor=(c,token)=>path.join(c.runtimeRoot,'runs',runId(token));
function manifest(c,r,digest,kind='host'){
  const home=homeFor(c,r.token);
  if(!fs.existsSync(home))return null;
  const file=path.join(home,'manifest.json');
  if(!fs.existsSync(file))return {home,unsettled:true};
  const m=read(file);
  assert((m.kind||'host')===kind&&m.token===r.token&&m.jobId===r.jobId&&m.targetHost===r.targetHost&&
    m.requestDigest===digest&&m.requestedModel===r.requestedModel,'token 已关联另一派发请求');
  if(kind==='host')assert(sha(fs.readFileSync(m.packetPath))===m.packetDigest,
    '已派发 packet 字节发生变化');
  return {...m,home};
}
function bootstrapRequest(c,file){
  const raw=fs.readFileSync(file),r=JSON.parse(raw.toString('utf8'));
  assert(r?.schema===1&&r.targetHost===c.hostId&&r.jobId==='$spec:execution-plan'&&
    typeof r.token==='string'&&r.token&&typeof r.requestedModel==='string'&&
    path.isAbsolute(r.worktree)&&
    path.isAbsolute(r.promptPath)&&
    path.isAbsolute(r.outputDirectory),'bootstrap 需要固定 job、host、模型和绝对路径');
  const route=c.routes.find(x=>x.requestedModel===r.requestedModel);
  assert(route,'bootstrap L1 模型不在已配置路由中');
  const prompt=fs.existsSync(r.promptPath)?fs.readFileSync(r.promptPath,'utf8'):null;
  return {r,route,prompt,digest:sha(raw)};
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
    completeFrame:output.code===0,turnEnded:events.some(e=>e.type==='turn/end'),
    toolCallCount:events.filter(e=>e.type==='tool/call').length,
    readError:output.error||null};
}
function uniqueSession(c,home){
  const logs=sessionLogs(home);
  if(logs.length!==1)return {session:null,observation:null,ambiguity:logs.length};
  const observation=observeLog(c,logs[0]);
  return {session:logs[0],observation,ambiguity:0};
}
function entryExists(file){
  try{fs.lstatSync(file);return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}
const terminalFile=m=>`dsh-terminal-${runId(m.token)}.raw`;
function outputBytes(m,name){
  if(typeof name!=='string'||path.basename(name)!==name)return null;
  const file=path.join(m.outputDirectory,name);
  try{
    const output=fs.realpathSync(m.outputDirectory),stat=fs.lstatSync(file);
    if(output!==m.outputDirectory||!stat.isFile()||stat.isSymbolicLink()||
      fs.realpathSync(file)!==file)return null;
    return fs.readFileSync(file);
  }catch{return null;}
}
function resultBytes(m){
  if(m.resultPath!==path.join(m.outputDirectory,'result.json'))return null;
  return outputBytes(m,'result.json');
}
function snapshotTerminalResult(m,bytes){
  const file=path.join(m.outputDirectory,terminalFile(m)),temporary=`${file}.${process.pid}.tmp`;
  try{
    const fd=fs.openSync(temporary,'wx',0o400);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.linkSync(temporary,file); // no replacement of an earlier terminal snapshot
    syncDir(m.outputDirectory);
  }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return terminalFile(m);
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
function hostReply(c,r,digest,operation,kind='host'){
  const m=manifest(c,r,digest,kind);
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
    if(finished.exitCode!==0||finished.signal||finished.spawnError||finished.timedOut||
      !observation.completeFrame||!observation.turnEnded)
      return {...fields,state:'unknown',reason:'native task did not reach a successful terminal event'};
    let evidenceMatches=false;
    try{evidenceMatches=sha(fs.readFileSync(session.log))===finished.sessionLogSha256&&
      sha(observation.finalText)===finished.rawSha256&&
      sha(fs.readFileSync(path.join(m.home,'native-final.txt')))===finished.rawSha256;}
    catch{/* missing native evidence remains unknown */}
    if(!evidenceMatches)
      return {...fields,state:'unknown',reason:'native final/session evidence changed'};
    const route=m.kind==='bootstrap'?{provider:m.routeProvider,model:m.routeModel}:
      c.routes[m.routeIndex];
    if(!route||observation.source.provider!==route.provider||observation.source.model!==route.model)
      return {...fields,state:'unknown',reason:'native route does not match the dispatched model'};
    const resultFile=finished.resultFile;
    if(!resultFile)return {...fields,state:'unknown',reason:'native task finished without a durable final message'};
    if((m.kind||'host')==='host'){
      const bytes=outputBytes(m,resultFile);
      if(resultFile!==terminalFile(m)||!bytes||sha(bytes)!==finished.resultSha256)
        return {...fields,state:'unknown',reason:'terminal result snapshot is missing or changed'};
    }
    return {...fields,state:'completed',completedAt:finished.at,resultFile,
      resultSha256:finished.resultSha256};
  }
  const launchPath=path.join(m.home,'launch.json');
  if(fs.existsSync(launchPath)&&!groupAlive(read(launchPath).pid))
    return {...fields,state:'unknown',reason:'native worker exited without durable completion marker'};
  if(operation==='collect')return {...fields,state:'running'};
  return {...fields,state:'running'};
}
function start(c,configPath,file){
  const {r,route,packet,packetDigest,digest}=request(c,file),base={token:r.token,jobId:r.jobId,targetHost:r.targetHost};
  const existing=manifest(c,r,digest);
  if(existing)return hostReply(c,r,digest,'start');
  const home=homeFor(c,r.token);
  fs.mkdirSync(path.dirname(home),{recursive:true});
  try{fs.mkdirSync(home,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;return hostReply(c,r,digest,'start');}
  syncDir(path.dirname(home));
  atomic(path.join(home,'manifest.json'),{...base,requestedModel:r.requestedModel,requestDigest:digest,
    packetPath:r.packetPath,packetDigest,outputDirectory:packet.outputDirectory,
    resultPath:packet.resultPath,startedAt:now(),routeIndex:c.routes.indexOf(route)});
  const child=spawn(process.execPath,[self,'worker',path.resolve(configPath),home],{
    detached:true,stdio:'ignore',env:{...process.env,DSH_ADAPTER_WORKER:'1'}});
  child.unref();
  atomic(path.join(home,'launch.json'),{pid:child.pid,at:now()});
  const until=Date.now()+c.startWaitMs;
  let lastResult;
  while(Date.now()<until){
    const result=hostReply(c,r,digest,'start');
    if(result.state==='running'||result.state==='completed'||result.state==='cancelled')return result;
    if(fs.existsSync(path.join(home,'finished.json'))||!groupAlive(child.pid))return result;
    lastResult=result;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  }
  return lastResult||{...base,state:'unknown',reason:'native session/model not observable before startup deadline'};
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
function bootstrapReply(c,r,digest,operation){
  const m=manifest(c,r,digest,'bootstrap');
  const base={token:r.token,jobId:r.jobId,targetHost:r.targetHost};
  if(!m)return {...base,state:'not_found',authoritative:true};
  if(m.unsettled)return {...base,state:'unknown',reason:'bootstrap token intent exists without manifest'};
  assert(sha(fs.readFileSync(path.join(m.home,'bootstrap-prompt.txt')))===m.promptDigest,
    'bootstrap 固定提示词已变化');
  assert(sha(fs.readFileSync(path.join(m.home,'route-settings.yaml')))===m.routeSettingsDigest,
    'bootstrap 固定路由配置已变化');
  const reply=hostReply(c,r,digest,operation,'bootstrap');
  if(!reply.nativeId)return reply;
  let native;
  try{observe(c,reply.nativeId,r.jobId);native=locateNative(c,reply.nativeId,r.jobId);}
  catch{return {...reply,state:'unknown',reason:'bootstrap native route identity is unverified'};}
  if(reply.state!=='completed')return reply;
  const finished=read(path.join(m.home,'finished.json'));
  const planPath=path.join(m.outputDirectory,reply.resultFile);
  const rawPath=path.join(m.outputDirectory,`dsh-plan-${runId(r.token).slice(0,12)}.raw.json`);
  if(path.basename(reply.resultFile)!==reply.resultFile||!fs.existsSync(planPath)||
    !fs.existsSync(rawPath)||sha(fs.readFileSync(planPath))!==finished.resultSha256||
    sha(fs.readFileSync(rawPath))!==finished.rawSha256||
    sha(native.observation.finalText)!==finished.rawSha256)
    return {...reply,state:'unknown',reason:'bootstrap plan artifact is missing or changed',resultFile:undefined};
  const plan=read(planPath);
  if(plan.decisionNativeId!==reply.nativeId||plan.evidencePath!==rawPath)
    return {...reply,state:'unknown',reason:'bootstrap plan identity or raw evidence changed',resultFile:undefined};
  return {...reply,planPath,planSha256:finished.resultSha256,rawSha256:finished.rawSha256};
}
function bootstrap(c,configPath,operation,file){
  assert(['query','start','collect'].includes(operation),'未知 bootstrap 操作');
  const {r,route,prompt,digest}=bootstrapRequest(c,file);
  if(operation!=='start')return bootstrapReply(c,r,digest,operation);
  const existing=manifest(c,r,digest,'bootstrap');
  if(existing)return bootstrapReply(c,r,digest,'start');
  assert(prompt?.trim(),'bootstrap L1 提示词不存在或为空');
  assert(fs.statSync(r.worktree).isDirectory(),'bootstrap 工作树不可读取');
  const promptDigest=sha(prompt);
  const home=homeFor(c,r.token),base={token:r.token,jobId:r.jobId,targetHost:r.targetHost};
  fs.mkdirSync(path.dirname(home),{recursive:true});
  try{fs.mkdirSync(home,{mode:0o700});}
  catch(error){if(error.code!=='EEXIST')throw error;return bootstrapReply(c,r,digest,'start');}
  syncDir(path.dirname(home));
  assert(!fs.existsSync(r.outputDirectory),'bootstrap 输出目录必须尚未存在');
  fs.mkdirSync(r.outputDirectory,{recursive:true,mode:0o700});
  syncDir(path.dirname(r.outputDirectory));
  atomic(path.join(home,'bootstrap-prompt.txt'),prompt);
  const routeSettings=fs.readFileSync(route.settingsFile);
  atomic(path.join(home,'route-settings.yaml'),routeSettings);
  atomic(path.join(home,'manifest.json'),{...base,kind:'bootstrap',requestedModel:r.requestedModel,
    requestDigest:digest,promptDigest,worktree:r.worktree,outputDirectory:r.outputDirectory,
    startedAt:now(),routeIndex:c.routes.indexOf(route),routeProvider:route.provider,routeModel:route.model,
    routeSettingsDigest:sha(routeSettings)});
  const child=spawn(process.execPath,[self,'worker',path.resolve(configPath),home],{
    detached:true,stdio:'ignore',env:{...process.env,DSH_ADAPTER_WORKER:'1'}});
  child.unref();
  atomic(path.join(home,'launch.json'),{pid:child.pid,at:now()});
  const until=Date.now()+c.startWaitMs;
  while(Date.now()<until){
    const result=bootstrapReply(c,r,digest,'start');
    if(['running','completed'].includes(result.state))return result;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  }
  return {...base,state:'unknown',reason:'bootstrap native session/model not observable before startup deadline'};
}
function actorPrompt(packet,c,configPath){
  const receipt=`Result path: ${JSON.stringify(packet.resultPath)}\nWrite exactly one UTF-8 Result JSON object to this designated path. Write a sibling temporary file and rename it into place after the complete object is ready. The file is the only authoritative result; your final message should cite its path and may summarize the work, but must not contain another Result JSON. Include complete, status, evidencePath and action-specific fields; omit model and native identity. If blocked, write truthful evidence and set complete:false. The host accepts this file only after your native task ends successfully.`;
  if(typeof packet.adapterProbeTask==='string'){
    assert(c.allowProbeTask===true,'probe task 只允许隔离测试配置');
    return `${packet.adapterProbeTask}\n\n${receipt}`;
  }
  assert(c.workflowEntry,'真实工作流任务需要配置 workflowEntry');
  const statePath=path.join(path.dirname(path.dirname(packet.__packetPath)),'state.json');
  return `You are executing one bounded spec-delivery job. Read the packet at ${JSON.stringify(packet.__packetPath)} and roles at ${JSON.stringify(packet.rolesPath)}. Follow its exact action, approved plan/checks and skill bindings. The public workflow CLI is node ${JSON.stringify(c.workflowEntry)}; its state is ${JSON.stringify(statePath)}. Before invoking a workflow command, poll the read-only inspect command until this job shows a bound native session; the host binds it immediately after observing your first model event. For a bound skill use skill-start, then load the returned original source with node ${JSON.stringify(self)} skill-open ${JSON.stringify(configPath)} ${JSON.stringify(statePath)} <invocationId>, do the skill's work including skill-delegate/skill-continue, write a raw report, run node ${JSON.stringify(self)} skill-complete ${JSON.stringify(configPath)} ${JSON.stringify(statePath)} <invocationId> <rawOutputPath>, then skill-finish. Run tests with the workflow test command. Do not edit workflow state directly or start hidden agents.\n\n${receipt}`;
}
async function worker(c,home,configPath){
  const m=read(path.join(home,'manifest.json')),route=c.routes[m.routeIndex];
  const bootstrap=m.kind==='bootstrap',packet=bootstrap?null:read(m.packetPath);
  if(packet)packet.__packetPath=m.packetPath;
  if(bootstrap){
    assert(route.provider===m.routeProvider&&route.model===m.routeModel&&
      sha(fs.readFileSync(path.join(home,'route-settings.yaml')))===m.routeSettingsDigest,
      'bootstrap route snapshot mismatch');
    fs.copyFileSync(path.join(home,'route-settings.yaml'),path.join(home,'settings.yaml'));
  }else fs.copyFileSync(route.settingsFile,path.join(home,'settings.yaml'));
  if(c.credentialsFile)fs.symlinkSync(c.credentialsFile,path.join(home,'.credentials.yaml'));
  fs.writeFileSync(path.join(home,'patch.yml'),'[]\n',{flag:'wx',mode:0o600});
  fs.mkdirSync(path.join(home,'sessions'),{recursive:true});
  const cwd=bootstrap?m.worktree:packet.worktree||packet.repo?.root||path.dirname(path.dirname(m.packetPath));
  assert(path.isAbsolute(cwd)&&fs.statSync(cwd).isDirectory(),'任务 cwd 不可读取');
  if(!bootstrap){
    assert(sha(fs.readFileSync(m.packetPath))===m.packetDigest&&packet.resultPath===m.resultPath,
      '已派发 packet 与宿主快照不符');
    fs.mkdirSync(m.outputDirectory,{recursive:true,mode:0o700});
    assert(fs.realpathSync(m.outputDirectory)===m.outputDirectory&&
      !entryExists(m.resultPath),'启动前已存在结果文件或输出目录不可信');
  }
  const stdout=fs.openSync(path.join(home,'stdout.log'),'w',0o600),stderr=fs.openSync(path.join(home,'stderr.log'),'w',0o600);
  const prompt=bootstrap
    ? `You are the separately routed L1 execution planner. Follow the instructions below and return exactly one JSON object containing the ExecutionPlan fields, including current inputVersion and sourceVersion. Do not supply decisionNativeId or evidencePath: the host attaches those from your native session and exact final response. Do not modify the workflow ledger.\n\n${fs.readFileSync(path.join(home,'bootstrap-prompt.txt'),'utf8')}`
    : actorPrompt(packet,c,configPath);
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
  let resultFile=null,resultSha256=null,rawSha256=null;
  if(session&&observation){
    atomic(path.join(home,'native-final.txt'),observation.finalText);
    rawSha256=sha(observation.finalText);
    fs.mkdirSync(m.outputDirectory,{recursive:true});
    const terminal=exitCode.code===0&&!exitCode.signal&&!exitCode.error&&!timedOut&&
      observation.completeFrame&&observation.turnEnded&&observation.origin?.id===session.id&&
      observation.source?.provider===route.provider&&observation.source?.model===route.model;
    if(bootstrap&&terminal&&observation.finalText){
      try{
        const authored=JSON.parse(observation.finalText);
        assert(authored&&typeof authored==='object'&&!Array.isArray(authored)&&
          !Object.hasOwn(authored,'decisionNativeId')&&!Object.hasOwn(authored,'evidencePath'),
          'bootstrap final must be an L1-authored plan without host proof fields');
        const prefix=`dsh-plan-${runId(m.token).slice(0,12)}`;
        const rawPath=path.join(m.outputDirectory,`${prefix}.raw.json`);
        atomic(rawPath,observation.finalText);
        resultFile=`${prefix}.json`;
        const plan={...authored,evidencePath:rawPath,decisionNativeId:`${runId(m.token)}/${session.id}`};
        const bytes=JSON.stringify(plan,null,2)+'\n';
        atomic(path.join(m.outputDirectory,resultFile),bytes);
        resultSha256=sha(bytes);
      }catch{/* retain the native instance and raw log; an invalid plan is not completed */}
    }else if(!bootstrap&&terminal){
      const bytes=resultBytes(m);
      if(bytes){
        try{resultFile=snapshotTerminalResult(m,bytes);resultSha256=sha(bytes);}
        catch{/* conflicting or unwritable snapshot leaves native completion uncertain */}
      }
    }
  }
  atomic(path.join(home,'finished.json'),{at:now(),exitCode:exitCode.code,signal:exitCode.signal,
    spawnError:exitCode.error||null,timedOut,resultFile,resultSha256,rawSha256,
    sessionLogSha256:session?sha(fs.readFileSync(session.log)):null});
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
  const route=m.kind==='bootstrap'?{provider:m.routeProvider,model:m.routeModel}:
    c.routes.find(r=>r.requestedModel===m.requestedModel);
  assert(route&&route.provider===sourceEvent.provider&&route.model===sourceEvent.model,
    '真实 provider/model 与请求路由不符');
  const proofId=sha(JSON.stringify({id:origin.id,createdAt:origin.createdAt,cwd:origin.cwd,log:session.log}));
  return {source:'native_host',observationId:sha(`${proofId}:${sourceEvent.provider}:${sourceEvent.model}`),
    jobId,nativeId,provider:sourceEvent.provider,model:sourceEvent.model,
    observedAt:new Date(origin.createdAt).toISOString(),
    context:{contextId:origin.id,mode:'new',proofId}};
}
function migrationHome(c,nativeId){
  const match=/^([A-Za-z0-9_-]+)\/(session-[A-Za-z0-9-]+)$/.exec(nativeId||'');
  if(!match)return null;
  const modern=/^[0-9a-f]{32}$/.test(match[1]);
  const base=modern?c.runtimeRoot:c.legacyRuntimeRoot;
  if(!base)return null;
  const root=path.resolve(base,'runs'),home=path.resolve(root,match[1]);
  if(!home.startsWith(root+path.sep)||!fs.existsSync(home)||!fs.statSync(home).isDirectory())return null;
  const realRoot=fs.realpathSync(root),realHome=fs.realpathSync(home);
  if(!realHome.startsWith(realRoot+path.sep))return null;
  return {home:realHome,sessionId:match[2],modern};
}
function migrationProcesses(homes){
  if(!fs.existsSync('/proc')||typeof process.getuid!=='function')
    return {live:[],unreadable:1,observationId:sha('proc-unavailable')};
  const wanted=new Set(homes),knownGroups=new Set(),live=[],unreadable=[];
  for(const home of wanted){
    try{const launch=read(path.join(home,'launch.json'));
      if(Number.isSafeInteger(launch.pid)&&launch.pid>0)knownGroups.add(launch.pid);
    }catch{/* Historical homes may not have a process-group record. */}
  }
  const related=pid=>{
    const root=`/proc/${pid}`;
    try{const stat=fs.readFileSync(path.join(root,'stat'),'utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      if(knownGroups.has(Number(fields[1]))||knownGroups.has(Number(fields[2])))return true;
    }catch{/* Continue with independent native path checks. */}
    try{const cwd=fs.readlinkSync(path.join(root,'cwd'));
      if([...wanted].some(home=>cwd===home||cwd.startsWith(home+path.sep)))return true;
    }catch{/* The process may have another cwd. */}
    try{const cmdline=fs.readFileSync(path.join(root,'cmdline'),'utf8');
      if([...wanted].some(home=>cmdline.includes(home)))return true;
    }catch{/* An unrelated unreadable process is not assigned to this run. */}
    return false;
  };
  for(const name of fs.readdirSync('/proc')){
    if(!/^\d+$/.test(name)||Number(name)===process.pid)continue;
    const root=`/proc/${name}`;
    try{
      const status=fs.readFileSync(path.join(root,'status'),'utf8');
      if(Number(status.match(/^Uid:\s+(\d+)/m)?.[1])!==process.getuid()||
        /^State:\s+Z/m.test(status))continue;
      const env=fs.readFileSync(path.join(root,'environ')).toString('utf8').split('\0');
      const home=env.find(x=>x.startsWith('DSH_HOME='))?.slice('DSH_HOME='.length);
      if(home&&wanted.has(path.resolve(home)))live.push({pid:Number(name),home:path.resolve(home)});
      else if(related(Number(name)))live.push({pid:Number(name),home:'related-native-process'});
    }catch(error){
      if(!fs.existsSync(root))continue;
      // Only assign an unreadable process to this run with native ancestry or path evidence.
      try{const status=fs.readFileSync(path.join(root,'status'),'utf8');
        if(Number(status.match(/^Uid:\s+(\d+)/m)?.[1])===process.getuid()&&
          related(Number(name)))unreadable.push(Number(name));
      }catch{if(related(Number(name)))unreadable.push(Number(name));}
    }
  }
  return {live,unreadable:unreadable.length,unreadablePids:unreadable,
    observationId:sha(JSON.stringify({homes:[...wanted].sort(),live,unreadable:unreadable.sort(),at:now()}))};
}
function migrationNative(c,nativeId,jobId,processes){
  const target=migrationHome(c,nativeId);
  if(!target)return {state:'unknown',observationId:sha(`missing:${jobId}:${nativeId}`)};
  const {home,sessionId,modern}=target;
  if(processes.live.some(x=>x.home===home))return {state:'running',
    observationId:sha(`live:${nativeId}:${processes.observationId}`)};
  const sessions=sessionLogs(home);
  if(sessions.length!==1||sessions[0].id!==sessionId)return {state:'unknown',
    observationId:sha(`ambiguous:${nativeId}:${sessions.map(x=>x.id).join(',')}`)};
  const native=observeLog(c,sessions[0]);
  if(!native.completeFrame||native.origin?.id!==sessionId||!native.source||native.sourceCount!==1)
    return {state:'unknown',observationId:sha(`incomplete:${nativeId}:${sha(fs.readFileSync(sessions[0].log))}`)};
  let state='unknown',marker='';
  if(modern){
    try{
      const m=read(path.join(home,'manifest.json'));
      if(m.jobId!==jobId||runId(m.token)!==path.basename(home))throw Error('manifest mismatch');
      const r={token:m.token,jobId:m.jobId,targetHost:m.targetHost,requestedModel:m.requestedModel};
      const reply=hostReply(c,r,m.requestDigest,'query',m.kind||'host');
      if(reply.nativeId!==nativeId)throw Error('native mismatch');
      state=reply.state;marker=JSON.stringify({reply,manifestSha:sha(fs.readFileSync(path.join(home,'manifest.json')))});
      if(['completed','cancelled'].includes(state)&&!native.turnEnded)state='unknown';
      const launch=path.join(home,'launch.json');
      if(fs.existsSync(launch)&&groupAlive(read(launch).pid))state='running';
    }catch{state='unknown';}
  }else{
    const finish=path.join(home,'finished-at'),exit=path.join(home,'exit-code');
    // Old runner did not retain a process group. A tool call could have left an
    // untracked child or external effect, so its old home cannot prove quiescence.
    if(native.turnEnded&&native.toolCallCount===0&&fs.existsSync(finish)&&fs.existsSync(exit)){
      const finishBytes=fs.readFileSync(finish),exitBytes=fs.readFileSync(exit);
      if(finishBytes.toString('utf8').trim()&&exitBytes.toString('utf8').trim()==='0')state='completed';
      marker=`${sha(finishBytes)}:${sha(exitBytes)}`;
    }
  }
  return {state,observationId:sha(`${nativeId}:${sha(fs.readFileSync(sessions[0].log))}:${marker}:${processes.observationId}`),
    nativeEvidence:{sessionLogSha256:sha(fs.readFileSync(sessions[0].log)),
      terminalMarkerSha256:sha(marker),toolCallCount:native.toolCallCount,turnEnded:native.turnEnded}};
}
function migrationExternal(c,request,statePath,pureNativeRead,nativeBasis){
  if(!c.migrationExternalObserver)return pureNativeRead
    ?{state:'settled',unknown:0,observationId:sha(`native-zero-tools:${nativeBasis}`),
      basis:'all-native-sessions-ended-with-zero-tool-calls-and-no-external-intents',
      nativeBasisSha256:nativeBasis}
    :{state:'unknown',unknown:1,observationId:sha('external-observer-not-configured')};
  const result=command(c.migrationExternalObserver,['settled',statePath],{
    input:JSON.stringify(request),cwd:path.dirname(statePath)});
  if(result.code!==0)return {state:'unknown',unknown:1,
    observationId:sha(`external-query-failed:${result.code}:${result.error||''}`)};
  let value;try{value=JSON.parse(result.stdout);}catch{return {state:'unknown',unknown:1,
    observationId:sha('external-query-invalid-json')}}
  if(value?.source!=='native_host'||value.challenge!==request.challenge||
    value.runId!==request.runId||value.inventorySha256!==request.inventorySha256||
    value.ledgerSha256!==request.ledgerSha256||
    !Number.isFinite(Date.parse(value.observedAt))||
    Math.abs(Date.now()-Date.parse(value.observedAt))>60_000)
    return {state:'unknown',unknown:1,observationId:sha('external-query-stale-or-mismatched')};
  return {state:value.state==='settled'&&value.unknown===0?'settled':'unknown',
    unknown:value.state==='settled'&&value.unknown===0?0:Math.max(1,Number(value.unknown)||1),
    observationId:sha(result.stdout),externalEvidenceSha256:sha(result.stdout),
    externalObservation:value};
}
function quiescence(c,statePath){
  const request=JSON.parse(fs.readFileSync(0,'utf8'));
  const bytes=fs.readFileSync(statePath),state=JSON.parse(bytes);
  assert(request.schemaVersion===1&&request.runId===state.id&&request.ledgerSha256===sha(bytes)&&
    typeof request.challenge==='string'&&request.challenge,'迁移查询与原账本不一致');
  const homes=state.jobs.filter(j=>j.executor==='agent'&&j.nativeId).map(j=>migrationHome(c,j.nativeId)?.home)
    .filter(Boolean);
  const processes=migrationProcesses(homes);
  const actors=state.jobs.filter(j=>j.executor==='agent'&&j.nativeId).map(j=>({jobId:j.id,nativeId:j.nativeId,
    ...migrationNative(c,j.nativeId,j.id,processes)}));
  const dispatches=(state.v3?.dispatchRecords||[]).map(d=>{
    let reply={state:'unknown'};
    try{if(d.targetHost===c.hostId){const m=read(d.requestPath);
      if(m.token===d.token&&m.jobId===d.jobId){const digest=sha(fs.readFileSync(d.requestPath));
        reply=hostReply(c,m,digest,'query');}}
    }catch{/* A missing intent or uncertain native query is never terminal. */}
    return {token:d.token,jobId:d.jobId,targetHost:d.targetHost,state:reply.state,
      nativeId:reply.nativeId,authoritative:reply.authoritative===true,
      observationId:sha(`token:${d.token}:${JSON.stringify(reply)}:${processes.observationId}`)};
  });
  const instances=[...(state.v3?.dispatchRecords||[]).flatMap(d=>d.instances),
    ...(state.v3?.detachedInstances||[])].filter(i=>i.nativeId).map(i=>{
    const native=migrationNative(c,i.nativeId,state.jobs.find(j=>j.nativeId===i.nativeId)?.id||'',processes);
    return {key:i.key,nativeId:i.nativeId,...native,observationId:sha(`${i.key}:${native.observationId}`)};
  });
  const processRows=state.jobs.flatMap(j=>{
    const rows=[];const command=Number(j.nativeId?.match(/^command:(\d+):/)?.[1]);
    if(command)rows.push({jobId:j.id,kind:'command',pid:command});
    if(j.testExecution?.pid)rows.push({jobId:j.id,kind:'test',pid:j.testExecution.pid});
    for(const h of j.testProcessHistory||[])rows.push({jobId:j.id,kind:'test',pid:h.pid});
    return rows;
  });
  for(const d of state.v3?.dispatchRecords||[])if(d.operationPid)
    processRows.push({jobId:d.jobId,kind:'dispatch',pid:d.operationPid});
  const observedRows=processRows.map(p=>({ ...p,state:groupAlive(p.pid)?'running':'unknown',
    descendantsStopped:false,observationId:sha(`untracked:${p.jobId}:${p.kind}:${p.pid}:${processes.observationId}`)}));
  const unfinished=actors.some(x=>!['completed','cancelled'].includes(x.state))||
    dispatches.some(x=>!['not_found','completed','cancelled'].includes(x.state))||
    instances.some(x=>!['completed','cancelled'].includes(x.state));
  const pureNativeRead=actors.length>0&&actors.every(x=>x.state==='completed'&&
    x.nativeEvidence?.toolCallCount===0&&x.nativeEvidence?.turnEnded===true)&&
    state.jobs.length===actors.length&&state.jobs.every(j=>j.executor==='agent'&&j.action==='review-lens'&&
      !j.testExecution&&!(j.testProcessHistory||[]).length)&&
    !processRows.length&&!(state.v3?.dispatchRecords||[]).length&&
    !(state.v3?.detachedInstances||[]).length&&
    state.tickets.every(t=>!t.pr&&!t.prNumber&&!t.prUrl)&&
    Object.keys(state.facts?.prs||{}).length===0&&
    Object.values(state.facts?.issueStates||{}).every(x=>x==='OPEN')&&
    !fs.existsSync(path.join(path.dirname(statePath),'actions'));
  const nativeBasis=sha(JSON.stringify({ledgerSha256:request.ledgerSha256,
    actorEvidence:actors.map(x=>({jobId:x.jobId,nativeId:x.nativeId,
      sessionLogSha256:x.nativeEvidence?.sessionLogSha256,toolCallCount:x.nativeEvidence?.toolCallCount})),
    actionsDirectoryAbsent:!fs.existsSync(path.join(path.dirname(statePath),'actions'))}));
  return {source:'native_host',schemaVersion:1,challenge:request.challenge,runId:request.runId,
    inventorySha256:request.inventorySha256,ledgerSha256:request.ledgerSha256,observedAt:now(),
    actors,dispatches,instances,processes:observedRows,
    processTree:{state:processes.live.length?'running':unfinished||processes.unreadable||observedRows.length?'unknown':'stopped',
      unknownChildren:processes.unreadable+observedRows.length,
      unreadablePids:processes.unreadablePids,
      observationId:sha(`tree:${processes.observationId}:${unfinished}:${observedRows.length}`)},
    externalActions:migrationExternal(c,request,statePath,pureNativeRead,nativeBasis)};
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
    capabilities:{tokenQuery:'adapter-persistent',bootstrapPlan:'adapter-persistent-native',
      actorAvailability:'unverified-stop',sessionObservation:'requires-native-probe',
      skillMode:c.sourceExecution===false?'unavailable':'source_execution',nativeExplicit:false,
      nativeResume:false,rawUsage:'requires-native-probe',stop:'process-group-request-plus-reconcile'},
    note:'This is a read-only installation probe. No provider route, native skill or recovery success is claimed.'};
}
function shellQuote(value){return `'${String(value).replaceAll("'","'\\''")}'`;}
function install(configPath,directory){
  fs.mkdirSync(directory,{recursive:true});
  const entries={host:'dsh-host',observe:'dsh-observer',skill:'dsh-skill-observer',
    quiescence:'dsh-migration-observer'};
  for(const [mode,name] of Object.entries(entries)){
    const file=path.join(directory,name);
    fs.writeFileSync(file,`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(self)} ${mode} ${shellQuote(path.resolve(configPath))} "$@"\n`,{mode:0o700});
  }
  return {host:path.join(directory,entries.host),observer:path.join(directory,entries.observe),
    skillObserver:path.join(directory,entries.skill),
    migrationObserver:path.join(directory,entries.quiescence)};
}
async function main(argv){
  const [mode,configPath,...rest]=argv;
  assert(mode&&configPath,'用法: dsh.mjs <probe|install|host|bootstrap|observe|skill|skill-open|skill-complete|worker> <config.json> ...');
  const c=config(configPath);
  if(mode==='probe')return probe(c);
  if(mode==='install')return install(configPath,rest[0]);
  if(mode==='host')return host(c,configPath,rest[0],rest[1]);
  if(mode==='bootstrap')return bootstrap(c,configPath,rest[0],rest[1]);
  if(mode==='observe'){
    if(rest[0]==='availability')fail('DSH headless 未提供可证明原 actor 不可恢复的原生接口；停止 context-reconstruct');
    assert(rest[0]==='observe','仅支持 observe');return observe(c,rest[1],rest[2]);
  }
  if(mode==='quiescence'){
    assert(rest[0]==='quiescence'&&path.isAbsolute(rest[1]),'迁移查询需要 quiescence 和绝对账本路径');
    return quiescence(c,rest[1]);
  }
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
