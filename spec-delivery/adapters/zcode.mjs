#!/usr/bin/env node
/** ZCode dynamic-workflow facade. A trusted bridge must call the native tools. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const self=fileURLToPath(import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const ensure=(condition,message)=>{if(!condition)throw Error(message);};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const now=()=>new Date().toISOString();
function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.renameSync(temp,file);
}
function config(file){
  const c=read(path.resolve(file));
  ensure(c?.schema===1&&typeof c.hostId==='string'&&c.hostId&&path.isAbsolute(c.runtimeRoot),
    '配置需 schema:1、hostId 与绝对 runtimeRoot');
  if(c.bridgePath)ensure(path.isAbsolute(c.bridgePath)&&fs.statSync(c.bridgePath).isFile(),
    '可信 ZCode 原生桥接器不可读取');
  if(c.workflowEntry)ensure(path.isAbsolute(c.workflowEntry)&&fs.statSync(c.workflowEntry).isFile(),
    'workflowEntry 不可读取');
  c.startWaitMs=Math.min(Math.max(Number(c.startWaitMs)||2000,100),30000);
  return c;
}
function bridge(c,operation,value){
  ensure(c.bridgePath,'当前环境没有 CreateWorkflow/GetWorkflowRun 原生工具桥接器');
  const input=path.join(c.runtimeRoot,'bridge-inputs',`${sha(JSON.stringify([operation,value])).slice(0,20)}-${process.pid}.json`);
  atomic(input,value);
  const output=spawnSync(c.bridgePath,[operation,input],{encoding:'utf8',maxBuffer:16*1024*1024,
    timeout:30000,stdio:['ignore','pipe','pipe']});
  ensure(output.status===0,`ZCode 原生桥接 ${operation} 未确认：${output.error?.message||output.status}`);
  try{return JSON.parse(output.stdout);}catch{throw Error(`ZCode 原生桥接 ${operation} 未返回 JSON`);}
}
function request(c,file){
  const bytes=fs.readFileSync(file),r=JSON.parse(bytes.toString('utf8'));
  ensure(r?.targetHost===c.hostId&&typeof r.token==='string'&&r.token&&
    typeof r.jobId==='string'&&r.jobId&&typeof r.requestedModel==='string'&&r.requestedModel&&
    path.isAbsolute(r.packetPath),'派发请求与 ZCode 宿主不符');
  const packet=read(r.packetPath);
  ensure(packet.jobId===r.jobId&&packet.model===r.requestedModel&&packet.dispatchToken===r.token&&
    (packet.executor==='agent'||packet.action==='repair-receipt')&&path.isAbsolute(packet.outputDirectory),
    '派发 packet 与请求不符');
  return {r,packet,digest:sha(bytes)};
}
const tokenKey=token=>sha(token).slice(0,32);
const homeFor=(c,token)=>path.join(c.runtimeRoot,'tokens',tokenKey(token));
function intent(c,r,digest){
  const home=homeFor(c,r.token),file=path.join(home,'intent.json');
  if(!fs.existsSync(home))return {home,exists:false};
  if(!fs.existsSync(file))return {home,exists:true,unsettled:true};
  const value=read(file);
  ensure(value.token===r.token&&value.jobId===r.jobId&&value.targetHost===r.targetHost&&
    value.requestDigest===digest&&value.requestedModel===r.requestedModel,
    'token 已关联另一派发请求');
  return {home,exists:true,value};
}
/** One native run and one actor per job; no child workflow is created inside this script. */
export function scriptForJob({token,jobId,packetPath,rolesPath,outputDirectory,actorName,workflowEntry,statePath}){
  ensure([token,jobId,packetPath,rolesPath,outputDirectory,actorName].every(x=>typeof x==='string'&&x),
    '生成 ZCode 脚本缺少 job/token/packet/actor');
  const instructions=`Read the job packet at ${packetPath} and the role contract at ${rolesPath}. `+
    `Execute only this job; follow its action, source references, fixed skill bindings, candidate and test budget. `+
    `The public workflow CLI is node ${workflowEntry||'<workflowEntry>'}, state ${statePath||'<statePath>'}. `+
    `Wait for the host to bind this actor's native run before skill-start or another workflow mutation. `+
    `Use skill-start/skill-finish and skill-delegate/skill-continue for bound skills and child requests. `+
    `For a new context following a prior actor, require the original handoff and L1 context-handoff verification; `+
    `do not claim resumed context. Fresh tasks read raw sources only. `+
    `Use the workflow test command for tests and formal recovery commands for uncertain outcomes. `+
    `Do not launch a nested workflow or edit state.json. Write exactly one raw Result JSON file inside ${outputDirectory}; `+
    `return its basename and a short summary. The Result must not self-assert model or native identity.`;
  return `// Generated ZCode dynamic workflow: one model, one actor, one durable dispatch token.\n`+
    `interface ActorAnswer {\n  /** Basename of the raw Result JSON file in this packet's output directory. */ resultFile: string;\n`+
    `  /** Short human summary of the finished job. */ summary: string;\n}\n`+
    `phase("执行当前角色任务并回传结果");\n`+
    `const actor = agent(${JSON.stringify(actorName)}, "Follow the packet and bound skill sources. Do not start another workflow or hidden agent.");\n`+
    `const answer = await actor.ask<ActorAnswer>(${JSON.stringify(instructions)});\n`+
    `report({kind:"spec-delivery-result",token:${JSON.stringify(token)},jobId:${JSON.stringify(jobId)},`+
    `actorName:${JSON.stringify(actorName)},resultFile:answer.resultFile,summary:answer.summary.slice(0,1000)});\n`+
    `return {conclusion:answer.summary.slice(0,1000),findings:[],verified:[],notCovered:[]};\n`;
}
export function prepareJob(c,r,packet,directory){
  const actorName=`actor-${tokenKey(r.token).slice(0,16)}`;
  const statePath=path.join(path.dirname(path.dirname(r.packetPath)),'state.json');
  const scriptPath=path.join(directory,'job.dwf.ts');
  const script=scriptForJob({token:r.token,jobId:r.jobId,packetPath:r.packetPath,
    rolesPath:packet.rolesPath,outputDirectory:packet.outputDirectory,actorName,
    workflowEntry:c.workflowEntry,statePath});
  fs.mkdirSync(directory,{recursive:true});
  if(fs.existsSync(scriptPath))ensure(fs.readFileSync(scriptPath,'utf8')===script,'ZCode 脚本来源已改变');
  else fs.writeFileSync(scriptPath,script,{flag:'wx',mode:0o600});
  return {token:r.token,jobId:r.jobId,requestedModel:r.requestedModel,targetHost:r.targetHost,
    packetPath:r.packetPath,scriptPath,scriptSha256:sha(script),actorName,
    createWorkflow:{name:`Spec task ${tokenKey(r.token)}`,path:scriptPath,subagent_model:r.requestedModel}};
}
function nativeQuery(c,r){
  if(!c.bridgePath)return {state:'unknown',reason:'native ZCode workflow tools unavailable'};
  const result=bridge(c,'query',{token:r.token,jobId:r.jobId,targetHost:r.targetHost});
  ensure(result?.token===r.token&&result.jobId===r.jobId&&
    ['not_found','running','completed','cancelled','unknown'].includes(result.state),
    '可信桥接未返回当前 token/job 的原生状态');
  return result;
}
function reply(c,r,digest){
  const base={token:r.token,jobId:r.jobId,targetHost:r.targetHost,continuationSupported:false};
  const stored=intent(c,r,digest),native=nativeQuery(c,r);
  if(stored.unsettled)return {...base,state:'unknown',reason:'token home exists without intent'};
  if(native.state==='not_found'){
    const attempted=fs.existsSync(path.join(stored.home,'launch-attempted.json'));
    return attempted?{...base,state:'unknown',reason:'native launch attempted; missing run requires reconciliation'}:
      {...base,state:'not_found',authoritative:native.authoritative===true};
  }
  if(native.state==='unknown'){
    const nativeId=typeof native.runId==='string'&&native.runId&&!native.runId.includes('/')&&
      typeof native.actorName==='string'&&native.actorName&&!native.actorName.includes('/')
      ? `${native.runId}/${native.actorName}`:undefined;
    return {...base,state:'unknown',nativeId,usage:native.usage||undefined,
      startedAt:native.startedAt||undefined,reason:native.reason||'native run uncertain'};
  }
  ensure(typeof native.runId==='string'&&native.runId&&!native.runId.includes('/')&&
    typeof native.actorName==='string'&&native.actorName&&!native.actorName.includes('/'),
    '原生 run/actor 身份未同时观测');
  const nativeId=`${native.runId}/${native.actorName}`;
  if(stored.exists){
    const identityPath=path.join(stored.home,'native-id.json');
    if(fs.existsSync(identityPath))ensure(read(identityPath).nativeId===nativeId,
      '同一 token 的原生 run/actor 身份改变');
    else atomic(identityPath,{nativeId,at:now()});
  }
  const fields={...base,nativeId,usage:native.usage||null,
    startedAt:native.startedAt||undefined,completedAt:native.completedAt||undefined,
    cancelledAt:native.cancelledAt||undefined};
  if(native.state==='completed'){
    const report=native.report;
    ensure(report?.kind==='spec-delivery-result'&&report.token===r.token&&
      report.jobId===r.jobId&&report.actorName===native.actorName&&
      typeof report.resultFile==='string'&&report.resultFile,
      '原生完成事件缺少匹配 token/job/actor 的报告');
    return {...fields,state:'completed',resultFile:report.resultFile};
  }
  return {...fields,state:native.state};
}
function start(c,configPath,file){
  const {r,packet,digest}=request(c,file),existing=intent(c,r,digest);
  if(existing.unsettled||fs.existsSync(path.join(existing.home,'launch-attempted.json')))
    return reply(c,r,digest);
  if(!c.bridgePath)return {token:r.token,jobId:r.jobId,targetHost:r.targetHost,state:'unknown',
    reason:'native ZCode workflow tools unavailable'};
  ensure(c.workflowEntry,'真实 ZCode 派发需要固定的 workflowEntry');
  const capability=bridge(c,'capabilities',{hostId:c.hostId});
  ensure(capability?.CreateWorkflow===true&&capability.GetWorkflowRun===true&&
    capability.ListWorkflowRuns===true&&capability.tokenLookup===true&&
    capability.nativeActorIdentity===true&&capability.observedProviderModel===true,
    '原生桥接缺少创建、稳定 token 查询或真实 actor/模型观测能力');
  const before=nativeQuery(c,r);
  if(before.state!=='not_found'||before.authoritative!==true)return reply(c,r,digest);
  const home=existing.home;fs.mkdirSync(path.dirname(home),{recursive:true});
  if(!existing.exists){
    try{fs.mkdirSync(home,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;return reply(c,r,digest);}
    atomic(path.join(home,'intent.json'),{token:r.token,jobId:r.jobId,targetHost:r.targetHost,
      requestedModel:r.requestedModel,requestDigest:digest,packetPath:r.packetPath,createdAt:now()});
  }
  const prepared=prepareJob(c,r,packet,home);
  // This marker precedes the irreversible native call. A lost response never triggers blind recreate.
  atomic(path.join(home,'launch-attempted.json'),{at:now(),scriptSha256:prepared.scriptSha256});
  try{
    const created=bridge(c,'create',{...prepared,configPath:path.resolve(configPath)});
    if(created?.token===r.token&&created?.runId)
      atomic(path.join(home,'create-reply.json'),{token:r.token,runId:created.runId,at:now()});
  }catch{/* query by token is the only recovery path after uncertain native create */}
  const until=Date.now()+c.startWaitMs;
  for(;;){
    const result=reply(c,r,digest);
    if(result.state!=='unknown'||Date.now()>=until)return result;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  }
}
function host(c,configPath,operation,file){
  const {r,digest}=request(c,file);
  if(operation==='start')return start(c,configPath,file);
  if(operation==='query'||operation==='collect')return reply(c,r,digest);
  ensure(operation==='cancel','未知宿主操作');
  const current=reply(c,r,digest);
  if(current.state!=='running')return current;
  const outcome=bridge(c,'stop',{token:r.token,jobId:r.jobId,nativeId:current.nativeId});
  ensure(outcome?.token===r.token&&outcome.jobId===r.jobId,'停止请求未由原生宿主确认');
  return reply(c,r,digest);
}
function observe(c,operation,nativeId,jobId){
  ensure(operation==='observe'&&typeof nativeId==='string'&&nativeId.includes('/'),'原生身份不完整');
  const raw=bridge(c,'observe',{nativeId,jobId});
  ensure(raw?.source==='native_host'&&raw.jobId===jobId&&raw.nativeId===nativeId&&
    typeof raw.observationId==='string'&&raw.observationId&&raw.provider&&raw.model&&
    Number.isFinite(Date.parse(raw.observedAt))&&raw.context?.contextId&&raw.context.proofId&&
    ['new','resumed'].includes(raw.context.mode),'原生运行/模型/上下文观测不完整');
  return raw;
}
function skill(c,operation,id,jobId){
  ensure(['capabilities','result'].includes(operation),'未知技能观测操作');
  const state=read(path.join(process.cwd(),'state.json'));
  const job=state.jobs?.find(j=>j.id===jobId);
  ensure(job?.session&&job.nativeId,'技能操作缺少已绑定原生 actor');
  if(operation==='capabilities'){
    const binding=state.v3?.skillBindings?.find(b=>b.capability===id);
    ensure(binding,'技能能力未固定');
    const raw=bridge(c,'skill-capabilities',{capability:id,jobId,nativeId:job.nativeId,
      sourcePath:binding.sourcePath,bindingFingerprint:binding.fingerprint});
    ensure(raw?.source==='native_host'&&raw.jobId===jobId&&raw.capability===id&&raw.capabilities,
      '原生技能能力观测不完整');
    return raw;
  }
  const invocation=state.v3?.skillInvocations?.find(i=>i.id===id&&i.jobId===jobId);
  ensure(invocation,'技能调用不存在');
  const raw=bridge(c,'skill-result',{invocationId:id,jobId,nativeId:job.nativeId,
    observationId:job.session.observationId,mode:invocation.mode,
    bindingFingerprint:invocation.bindingFingerprint,sourceArchivePath:invocation.sourceArchivePath});
  ensure(raw?.source==='native_host'&&raw.invocationId===id&&raw.jobId===jobId&&
    raw.nativeId===job.nativeId&&raw.observationId===job.session.observationId&&
    raw.mode===invocation.mode&&raw.bindingFingerprint===invocation.bindingFingerprint&&raw.terminal===true,
    '原生技能结果未证明版本、模式、actor 和终态');
  if(invocation.mode==='source_execution'){
    const bundle=read(invocation.sourceArchivePath);
    ensure(bundle.fingerprint===invocation.bindingFingerprint&&Array.isArray(bundle.files)&&
      bundle.files.every(file=>sha(Buffer.from(file.dataBase64,'base64'))===file.sha256)&&
      JSON.stringify(raw.loadedFiles)===JSON.stringify(bundle.files.map(file=>({
        relativePath:file.relativePath,sha256:file.sha256}))),
      '源码执行未证明逐文件加载原始技能版本');
  }
  return raw;
}
function availability(c,operation,nativeId,jobId){
  ensure(operation==='availability','未知可用性操作');
  return bridge(c,'availability',{nativeId,jobId});
}
function probe(c){
  if(!c.bridgePath)return {adapter:'zcode-v3',hostId:c.hostId,nativeToolsAvailable:false,
    launcherIsNativeTool:false,capabilities:{CreateWorkflow:false,GetWorkflowRun:false,
      ListWorkflowRuns:false,tokenLookup:false,nativeActorIdentity:false,
      observedProviderModel:false,nativeCompileVerified:false,realRoundVerified:false},
    reason:'当前进程没有可调用的 ZCode 原生 workflow 工具桥接器'};
  const raw=bridge(c,'capabilities',{hostId:c.hostId});
  return {adapter:'zcode-v3',hostId:c.hostId,nativeToolsAvailable:!!raw.CreateWorkflow&&
    !!raw.GetWorkflowRun&&!!raw.ListWorkflowRuns,launcherIsNativeTool:false,
    capabilities:raw,nativeCompileVerified:false,realRoundVerified:false};
}
function quote(value){return `'${String(value).replaceAll("'","'\\''")}'`;}
function install(configPath,directory){
  ensure(path.isAbsolute(directory),'安装目录需要绝对路径');fs.mkdirSync(directory,{recursive:true});
  const names={host:'zcode-host',observe:'zcode-observer',skill:'zcode-skill-observer'};
  for(const [mode,name] of Object.entries(names))fs.writeFileSync(path.join(directory,name),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(self)} ${mode} ${quote(path.resolve(configPath))} "$@"\n`,{mode:0o700});
  return Object.fromEntries(Object.entries(names).map(([kind,name])=>[kind,path.join(directory,name)]));
}
async function main(argv){
  const [mode,configPath,...rest]=argv;ensure(mode&&configPath,'用法: zcode.mjs <mode> <config.json> ...');
  const c=config(configPath);
  if(mode==='probe')return probe(c);
  if(mode==='install')return install(configPath,rest[0]);
  if(mode==='host')return host(c,configPath,rest[0],rest[1]);
  if(mode==='observe')return rest[0]==='availability'
    ? availability(c,rest[0],rest[1],rest[2]):observe(c,rest[0],rest[1],rest[2]);
  if(mode==='skill')return skill(c,rest[0],rest[1],rest[2]);
  throw Error('未知 ZCode 适配器命令');
}
if(process.argv[1]&&path.resolve(process.argv[1])===self){
  try{process.stdout.write(JSON.stringify(await main(process.argv.slice(2)))+'\n');}
  catch(error){process.stderr.write(`zcode adapter: ${error.message}\n`);process.exitCode=1;}
}
