#!/usr/bin/env node
/** Codex CLI bridge for Spec Delivery v3. A CLI option is never a model observation. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const self=fileURLToPath(import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function atomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.renameSync(temp,file);
}
function config(file){
  const c=read(path.resolve(file));
  assert(c?.schema===1&&typeof c.hostId==='string'&&c.hostId&&path.isAbsolute(c.runtimeRoot)&&
    path.isAbsolute(c.codexBin)&&fs.statSync(c.codexBin).isFile()&&path.isAbsolute(c.codexHome),
    '配置需 schema:1、hostId、绝对 runtimeRoot/codexBin/codexHome');
  assert(Array.isArray(c.routes)&&c.routes.length&&c.routes.every(r=>r&&r.requestedModel&&r.cliModel&&
    r.provider&&r.model)&&new Set(c.routes.map(r=>r.requestedModel)).size===c.routes.length,
    '每个请求模型需要唯一的 cliModel、provider 和实际 model');
  if(c.workflowEntry)assert(path.isAbsolute(c.workflowEntry)&&fs.statSync(c.workflowEntry).isFile(),
    'workflowEntry 不可读取');
  c.startWaitMs=Math.min(Math.max(Number(c.startWaitMs)||8000,100),30000);
  c.probeTimeoutMs=Math.min(Math.max(Number(c.probeTimeoutMs)||45000,1000),90000);
  c.taskTimeoutMs=Math.min(Math.max(Number(c.taskTimeoutMs)||900000,1000),3600000);
  c.sandbox ||= 'workspace-write';
  assert(['read-only','workspace-write'].includes(c.sandbox),'适配器仅支持明确的 CLI 沙箱模式');
  return c;
}
const runId=token=>sha(token).slice(0,32);
const homeFor=(c,token)=>path.join(c.runtimeRoot,'runs',runId(token));
const proofPath=(c,route)=>path.join(c.runtimeRoot,'probes',sha(route.requestedModel).slice(0,32),'result.json');
function request(c,file){
  const bytes=fs.readFileSync(file),r=JSON.parse(bytes.toString('utf8'));
  assert(r?.targetHost===c.hostId&&r.token&&r.jobId&&r.requestedModel&&path.isAbsolute(r.packetPath),
    '派发请求与 Codex 宿主配置不符');
  const route=c.routes.find(x=>x.requestedModel===r.requestedModel);
  assert(route,'请求模型没有配置 Codex CLI 路由');
  const packet=read(r.packetPath);
  assert(packet.jobId===r.jobId&&packet.model===r.requestedModel&&packet.dispatchToken===r.token&&
    path.isAbsolute(packet.outputDirectory),'packet 与持久 token/job/model 不符');
  return {r,route,packet,digest:sha(bytes)};
}
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
function events(file){
  if(!fs.existsSync(file))return [];
  return fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).flatMap(line=>{
    try{return [JSON.parse(line)];}catch{return [];}
  });
}
function threadFrom(home){
  const ids=[...new Set(events(path.join(home,'events.jsonl'))
    .filter(x=>x.type==='thread.started'&&typeof x.thread_id==='string').map(x=>x.thread_id))];
  assert(ids.length<=1,'Codex CLI 返回多个原生 thread ID');
  return ids[0]||null;
}
function rollout(c,threadId){
  assert(/^[0-9a-f-]{36}$/.test(threadId),'Codex 原生 thread ID 格式不符');
  const root=path.join(c.codexHome,'sessions');
  if(!fs.existsSync(root))return null;
  const found=[],stack=[root];let visited=0;
  while(stack.length){
    const dir=stack.pop();
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(++visited>30000)throw new Error('Codex 会话目录过大，无法可靠定位原生记录');
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())stack.push(file);
      else if(entry.isFile()&&entry.name.endsWith(`-${threadId}.jsonl`))found.push(file);
    }
  }
  assert(found.length<=1,'原生 thread ID 对应多个 rollout 文件');
  return found[0]||null;
}
function nativeObservation(c,threadId,since,expectedRoute){
  const file=rollout(c,threadId);
  if(!file)return null;
  const rows=events(file),meta=rows.find(x=>x.type==='session_meta'&&
    (x.payload?.id===threadId||x.payload?.session_id===threadId));
  if(!meta?.payload?.model_provider)return null;
  const threshold=Date.parse(since);
  const started=rows.filter(x=>x.type==='event_msg'&&x.payload?.type==='task_started'&&
    Date.parse(x.timestamp)>=threshold);
  assert(started.length<=1,'同一 job 时间窗内出现多个 Codex turn，身份来源不唯一');
  const contexts=rows.filter(x=>x.type==='turn_context'&&started.some(y=>y.payload.turn_id===x.payload?.turn_id)&&
    Date.parse(x.timestamp)>=threshold&&typeof x.payload?.model==='string');
  assert(contexts.length<=1,'Codex turn 有多个模型上下文记录');
  const context=contexts[0];
  if(!context)return null;
  const provider=meta.payload.model_provider,model=context.payload.model;
  assert(provider===expectedRoute.provider&&model===expectedRoute.model,
    `Codex 原生 provider/model ${provider}/${model} 与请求路由不符`);
  const proofId=sha(JSON.stringify({threadId,rollout:file,meta:meta.timestamp,turnId:context.payload.turn_id,
    contextAt:context.timestamp,provider,model}));
  return {threadId,provider,model,proofId,observedAt:context.timestamp,sessionStartedAt:meta.timestamp,rolloutPath:file,
    turnId:context.payload.turn_id};
}
function groupAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  if(fs.existsSync('/proc')){
    for(const name of fs.readdirSync('/proc')){
      if(!/^\d+$/.test(name))continue;
      try{const stat=fs.readFileSync(`/proc/${name}/stat`,'utf8');
        const tail=stat.slice(stat.lastIndexOf(')')+2).split(' ');
        if(Number(tail[2])===pid&&tail[0]!=='Z')return true;
      }catch{/* exited while scanning */}
    }
    return false;
  }
  try{process.kill(-pid,0);return true;}catch{return false;}
}
function routeProof(c,route){
  const file=proofPath(c,route);
  if(!fs.existsSync(file))return null;
  const p=read(file);
  return p.success&&p.codexBin===c.codexBin&&p.codexHome===c.codexHome&&
    p.requestedModel===route.requestedModel&&p.cliModel===route.cliModel&&
    p.provider===route.provider&&p.model===route.model&&
    p.version===command(c.codexBin,['--version']).stdout.trim()?p:null;
}
function hostReply(c,r,route,digest){
  const m=manifest(c,r,digest),base={token:r.token,jobId:r.jobId,targetHost:r.targetHost,continuationSupported:false};
  if(!m)return {...base,state:'not_found',authoritative:true};
  if(m.unsettled)return {...base,state:'unknown',reason:'持久 token 已存在，但启动意图尚未写完整'};
  const nativeId=threadFrom(m.home);
  if(!nativeId)return {...base,state:'unknown',reason:'尚未取得 Codex 原生 thread ID'};
  let observed;
  try{observed=nativeObservation(c,nativeId,m.startedAt,route);}catch(error){
    return {...base,state:'unknown',nativeId,reason:error.message};
  }
  if(!observed)return {...base,state:'unknown',nativeId,reason:'尚未取得原生 provider/model/turn 记录'};
  if(m.resumeFrom&&m.resumeFrom!==nativeId)return {...base,state:'unknown',nativeId,reason:'续接返回了另一 thread'};
  if(!m.resumeFrom&&Date.parse(observed.sessionStartedAt)<Date.parse(m.startedAt))
    return {...base,state:'unknown',nativeId,reason:'fresh/new 任务复用了旧 Codex thread'};
  const fields={...base,nativeId,startedAt:m.startedAt};
  const cancelled=path.join(m.home,'cancelled.json');
  if(fs.existsSync(cancelled))return {...fields,state:'cancelled',cancelledAt:read(cancelled).at};
  const finished=path.join(m.home,'finished.json');
  if(fs.existsSync(finished)){
    const done=read(finished),complete=events(path.join(m.home,'events.jsonl')).some(x=>x.type==='turn.completed');
    if(done.exitCode===0&&complete&&done.resultFile)
      return {...fields,state:'completed',completedAt:done.at,resultFile:done.resultFile,usage:done.usage||undefined};
    return {...fields,state:'unknown',reason:'Codex 进程结束，但终态或原始回执不完整'};
  }
  const launch=path.join(m.home,'launch.json');
  if(!fs.existsSync(launch)||!groupAlive(read(launch).pid))
    return {...fields,state:'unknown',reason:'原生进程未确认仍运行，且无完成标记'};
  return {...fields,state:'running'};
}
function actorPrompt(packet,c,configPath,statePath){
  if(typeof packet.adapterProbeTask==='string'){
    assert(c.allowProbeTask===true,'隔离测试以外不允许覆盖真实 job 指令');
    return packet.adapterProbeTask;
  }
  assert(c.workflowEntry,'真实工作流任务需要 workflowEntry');
  return `Execute exactly one Spec Delivery job. Read the packet at ${JSON.stringify(packet.__packetPath)} and roles at ${JSON.stringify(packet.rolesPath)}. The public CLI is node ${JSON.stringify(c.workflowEntry)} and the state is ${JSON.stringify(statePath)}. Wait until inspect shows this job bound to your observed Codex thread before skill or result commands. For a bound skill, call skill-start, then node ${JSON.stringify(self)} skill-open ${JSON.stringify(configPath)} ${JSON.stringify(statePath)} <invocationId> to load every pinned source file. Follow the skill's actual method, registering required child tasks through skill-delegate/skill-continue. Save its original output; call node ${JSON.stringify(self)} skill-complete ${JSON.stringify(configPath)} ${JSON.stringify(statePath)} <invocationId> <rawOutputPath> before skill-finish. Use workflow test quotas for tests. Do not modify the state JSON or launch hidden agents. If a continuation is not proved by the host, stop substantive work until the formal context-handoff or context-reconstruct gate supplies the source. Return exactly one Result JSON object with complete, status, evidencePath and action-specific fields. Never supply a model or native identity as evidence. If blocked, write a truthful evidence file and return complete:false.`;
}
async function worker(c,configPath,home){
  const m=read(path.join(home,'manifest.json')),packet=read(m.packetPath);
  packet.__packetPath=m.packetPath;
  const statePath=path.join(path.dirname(path.dirname(m.packetPath)),'state.json');
  const cwd=packet.worktree||packet.repo?.root||path.dirname(statePath);
  assert(path.isAbsolute(cwd)&&fs.statSync(cwd).isDirectory(),'任务工作目录不可读取');
  const prompt=actorPrompt(packet,c,configPath,statePath);
  const route=c.routes.find(x=>x.requestedModel===m.requestedModel);
  assert(route,'模型路由已从配置中移除');
  const args=m.resumeFrom
    ? ['exec','resume',m.resumeFrom,'--json','-m',route.cliModel,'--ignore-user-config',
      '--skip-git-repo-check',prompt]
    : ['exec','--json','-m',route.cliModel,'--ignore-user-config','-s',c.sandbox,'-C',cwd,'--skip-git-repo-check',
      '--output-last-message',path.join(home,'last-message.txt'),prompt];
  fs.writeFileSync(path.join(home,'launch-argv.json'),JSON.stringify(args.map((a,i)=>i===args.length-1?'<job-prompt>':a))+'\n',
    {flag:'wx',mode:0o600});
  const stdout=fs.openSync(path.join(home,'events.jsonl'),'w',0o600),
    stderr=fs.openSync(path.join(home,'stderr.log'),'w',0o600);
  const child=spawn(c.codexBin,args,{cwd,env:{...process.env,CODEX_HOME:c.codexHome,
    CODEX_ADAPTER_ACTOR_HOME:home,CODEX_ADAPTER_CONFIG:path.resolve(configPath),
    SPEC_DELIVERY_HOST_ADAPTER:process.env.SPEC_DELIVERY_HOST_ADAPTER||'',
    SPEC_DELIVERY_HOST_OBSERVER:process.env.SPEC_DELIVERY_HOST_OBSERVER||'',
    SPEC_DELIVERY_SKILL_OBSERVER:process.env.SPEC_DELIVERY_SKILL_OBSERVER||''},
    stdio:['ignore',stdout,stderr]});
  atomic(path.join(home,'native-process.json'),{pid:child.pid,at:now()});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;try{process.kill(-process.pid,'SIGTERM');}catch{}},c.taskTimeoutMs);
  const outcome=await new Promise(resolve=>{
    child.once('exit',(code,signal)=>resolve({code,signal}));
    child.once('error',error=>resolve({code:null,signal:null,error:error.message}));
  });
  clearTimeout(timer);fs.closeSync(stdout);fs.closeSync(stderr);
  const nativeId=threadFrom(home),nativeEvents=events(path.join(home,'events.jsonl'));
  const terminal=nativeEvents.some(x=>x.type==='turn.completed');
  let resultFile=null;
  if(outcome.code===0&&terminal){
    let original='';
    const last=path.join(home,'last-message.txt');
    if(fs.existsSync(last))original=fs.readFileSync(last,'utf8');
    if(!original)original=nativeEvents.filter(x=>x.type==='item.completed'&&
      x.item?.type==='agent_message'&&typeof x.item.text==='string').at(-1)?.item.text||'';
    if(original.trim()){
      fs.mkdirSync(m.outputDirectory,{recursive:true});
      resultFile=`codex-final-${runId(m.token).slice(0,12)}.txt`;
      const destination=path.join(m.outputDirectory,resultFile);
      if(!fs.existsSync(destination))fs.writeFileSync(destination,original,{flag:'wx',mode:0o600});
      else assert(fs.readFileSync(destination,'utf8')===original,'原始回执文件发生冲突');
    }
  }
  const usage=nativeEvents.filter(x=>x.type==='turn.completed'&&x.usage).map(x=>x.usage);
  atomic(path.join(home,'finished.json'),{at:now(),exitCode:outcome.code,signal:outcome.signal,
    spawnError:outcome.error||null,timedOut,nativeId,resultFile,usage});
}
function start(c,configPath,file){
  const {r,route,packet,digest}=request(c,file);
  assert(routeProof(c,route),`模型 ${route.requestedModel} 没有成功的原生 provider/model 探测；先运行 probe-models`);
  const existing=manifest(c,r,digest);
  if(existing)return hostReply(c,r,route,digest);
  const home=homeFor(c,r.token);fs.mkdirSync(path.dirname(home),{recursive:true});
  try{fs.mkdirSync(home,{mode:0o700});}catch(error){
    if(error.code!=='EEXIST')throw error;return hostReply(c,r,route,digest);
  }
  const resumeFrom=r.resumeFrom?.nativeId||null;
  assert(!resumeFrom||packet.contextIntent?.kind==='continue','只有明确的续接 job 可使用前序 thread');
  const m={token:r.token,jobId:r.jobId,targetHost:r.targetHost,requestDigest:digest,
    requestedModel:r.requestedModel,packetPath:r.packetPath,outputDirectory:packet.outputDirectory,
    resumeFrom,startedAt:now()};
  atomic(path.join(home,'manifest.json'),m);
  const child=spawn(process.execPath,[self,'worker',path.resolve(configPath),home],{
    detached:true,stdio:'ignore',env:{...process.env,CODEX_ADAPTER_WORKER:'1'}});
  child.unref();atomic(path.join(home,'launch.json'),{pid:child.pid,at:now()});
  const until=Date.now()+c.startWaitMs;
  while(Date.now()<until){
    const reply=hostReply(c,r,route,digest);
    if(['running','completed','cancelled'].includes(reply.state))return reply;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  }
  return {token:r.token,jobId:r.jobId,targetHost:r.targetHost,state:'unknown',
    reason:'启动后尚未得到可绑定的原生 thread/provider/model；按同一 token 查询'};
}
function host(c,configPath,operation,file){
  const {r,route,digest}=request(c,file);
  if(operation==='start')return start(c,configPath,file);
  assert(['query','collect','cancel'].includes(operation),'未知宿主操作');
  if(operation!=='cancel')return hostReply(c,r,route,digest);
  const m=manifest(c,r,digest),current=hostReply(c,r,route,digest);
  if(!m||m.unsettled||['completed','cancelled'].includes(current.state))return current;
  const launch=path.join(m.home,'launch.json');
  if(!fs.existsSync(launch))return {...current,state:'unknown',reason:'未找到可停止的启动进程'};
  const pid=read(launch).pid;
  if(!fs.existsSync(path.join(m.home,'cancel-requested.json')))
    atomic(path.join(m.home,'cancel-requested.json'),{at:now(),pid});
  if(groupAlive(pid))try{process.kill(-pid,'SIGTERM');}catch{/* remain uncertain */}
  const until=Date.now()+5000;
  while(groupAlive(pid)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  if(groupAlive(pid))return {...current,state:'unknown',reason:'进程组尚未确认停止'};
  if(!fs.existsSync(path.join(m.home,'cancelled.json')))
    atomic(path.join(m.home,'cancelled.json'),{at:now(),pid});
  return hostReply(c,r,route,digest);
}
function nativeRun(c,nativeId,jobId){
  assert(/^[0-9a-f-]{36}$/.test(nativeId),'Codex thread 身份格式不符');
  const root=path.join(c.runtimeRoot,'runs');
  assert(fs.existsSync(root),'没有 Codex 派发记录');
  const matches=fs.readdirSync(root).flatMap(name=>{
    const home=path.join(root,name),file=path.join(home,'manifest.json');
    if(!fs.existsSync(file))return [];
    const m=read(file);
    return m.jobId===jobId&&threadFrom(home)===nativeId?[{home,m}]:[];
  });
  assert(matches.length===1,'job 与原生 thread 没有唯一的持久派发关联');
  const {home,m}=matches[0],route=c.routes.find(x=>x.requestedModel===m.requestedModel);
  assert(route,'请求模型路由缺失');
  const observed=nativeObservation(c,nativeId,m.startedAt,route);
  assert(observed,'原生 rollout 未证明本次 provider/model/turn');
  assert(m.resumeFrom||Date.parse(observed.sessionStartedAt)>=Date.parse(m.startedAt),
    'fresh/new 任务复用了旧 Codex thread');
  return {home,m,route,observed};
}
function observe(c,operation,nativeId,jobId){
  const {home,m,observed}=nativeRun(c,nativeId,jobId);
  if(operation==='availability')return {source:'native_host',nativeId,jobId,
    state:fs.existsSync(observed.rolloutPath)?'available':'unknown',
    observationId:observed.proofId,observedAt:now()};
  assert(operation==='observe','未知原生观测操作');
  const mode=m.resumeFrom?'resumed':'new';
  assert(!m.resumeFrom||m.resumeFrom===nativeId,'续接未沿用前序 Codex thread');
  const contextId=nativeId;
  return {source:'native_host',observationId:sha(`${jobId}:${observed.proofId}`),jobId,nativeId,
    provider:observed.provider,model:observed.model,observedAt:observed.observedAt,
    context:{contextId,mode,proofId:observed.proofId,
      ...(m.resumeFrom?{resumedFromContextId:m.resumeFrom}:{})}};
}
function skillPath(c,invocationId,nativeId,leaf){
  return path.join(c.runtimeRoot,'skills',sha(invocationId),'actors',sha(nativeId),leaf);
}
function invokingActor(c,statePath,invocationId){
  const state=read(statePath),invocation=state.v3?.skillInvocations?.find(i=>i.id===invocationId);
  assert(invocation,'技能调用不存在');
  const job=state.jobs.find(j=>j.id===invocation.jobId);
  assert(job?.nativeId&&job.session,'技能调用尚未绑定原生会话');
  const home=process.env.CODEX_ADAPTER_ACTOR_HOME;
  assert(home&&path.resolve(home)===path.resolve(nativeRun(c,job.nativeId,job.id).home),
    'skill-open/complete 必须在该 job 的 Codex 原生执行环境调用');
  return {state,invocation,job};
}
function skillOpen(c,statePath,invocationId){
  const {invocation,job}=invokingActor(c,statePath,invocationId);
  assert(invocation.mode==='source_execution'&&!invocation.result,'只对未完成的 source_execution 加载原技能');
  const bundle=read(invocation.sourceArchivePath);
  assert(bundle.fingerprint===invocation.bindingFingerprint&&Array.isArray(bundle.files),'技能包版本与调用不符');
  const root=skillPath(c,invocationId,job.nativeId,'loaded');fs.mkdirSync(root,{recursive:true});
  const loadedFiles=[];
  for(const file of bundle.files){
    assert(typeof file.relativePath==='string'&&!file.relativePath.startsWith('/')&&
      !file.relativePath.split('/').includes('..'),'技能资源路径不安全');
    const bytes=Buffer.from(file.dataBase64,'base64');
    assert(sha(bytes)===file.sha256,'技能资源与固定版本不符');
    const target=path.join(root,file.relativePath);fs.mkdirSync(path.dirname(target),{recursive:true});
    if(!fs.existsSync(target))fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
    else assert(fs.readFileSync(target).equals(bytes),'已加载技能资源变化');
    loadedFiles.push({relativePath:file.relativePath,sha256:file.sha256});
  }
  const receipt=skillPath(c,invocationId,job.nativeId,'loaded.json');
  const record={invocationId,jobId:job.id,nativeId:job.nativeId,
    bindingFingerprint:invocation.bindingFingerprint,loadedFiles,at:now()};
  if(!fs.existsSync(receipt))atomic(receipt,record);
  else assert(JSON.stringify(read(receipt).loadedFiles)===JSON.stringify(loadedFiles),'技能加载版本与前次不一致');
  return `${fs.readFileSync(path.join(root,'SKILL.md'),'utf8')}\n\nReferenced source files loaded at: ${root}\n`;
}
function skillComplete(c,statePath,invocationId,rawOutputPath){
  const {invocation,job}=invokingActor(c,statePath,invocationId);
  const loaded=read(skillPath(c,invocationId,job.nativeId,'loaded.json'));
  assert(loaded.bindingFingerprint===invocation.bindingFingerprint,'技能原文加载版本不符');
  const bytes=fs.readFileSync(rawOutputPath);
  assert(bytes.toString('utf8').trim(),'技能原始产物为空');
  const record={invocationId,jobId:job.id,nativeId:job.nativeId,
    rawOutputPath:path.resolve(rawOutputPath),rawSha256:sha(bytes),at:now()};
  const file=skillPath(c,invocationId,job.nativeId,'completed.json');
  if(!fs.existsSync(file))atomic(file,record);
  else assert(read(file).rawSha256===record.rawSha256,'技能结果与前次标记不一致');
  return {recordPath:file,mode:invocation.mode};
}
function skillObservation(c,operation,id,jobId){
  const state=read(path.join(process.cwd(),'state.json'));
  if(operation==='capabilities'){
    assert(state.jobs.some(j=>j.id===jobId)&&state.v3?.skillBindings?.some(b=>b.capability===id),
      '技能能力查询缺少当前 job 或固定绑定');
    return {source:'native_host',jobId,capability:id,capabilities:{
      nativeExplicit:{supported:false,registrations:[]},
      sourceExecution:{allowed:true,acceptsOriginalFiles:true}}};
  }
  assert(operation==='result','未知技能宿主观测操作');
  const invocation=state.v3?.skillInvocations?.find(i=>i.id===id);
  assert(invocation?.jobId===jobId&&invocation.mode==='source_execution','技能调用或实际模式不符');
  const job=state.jobs.find(j=>j.id===jobId);
  assert(job?.nativeId&&job.session,'技能宿主结果缺少已绑定身份');
  nativeRun(c,job.nativeId,jobId);
  const loaded=read(skillPath(c,id,job.nativeId,'loaded.json')),
    completed=read(skillPath(c,id,job.nativeId,'completed.json')),
    bundle=read(invocation.sourceArchivePath);
  assert(loaded.jobId===jobId&&loaded.nativeId===job.nativeId&&
    completed.jobId===jobId&&completed.nativeId===job.nativeId&&
    sha(fs.readFileSync(completed.rawOutputPath))===completed.rawSha256&&
    JSON.stringify(loaded.loadedFiles)===JSON.stringify(bundle.files.map(x=>({relativePath:x.relativePath,sha256:x.sha256}))),
    '原生 actor 未逐字加载固定技能或完成原始产物');
  return {source:'native_host',invocationId:id,jobId,nativeId:job.nativeId,
    observationId:job.session.observationId,mode:'source_execution',
    bindingFingerprint:invocation.bindingFingerprint,terminal:true,loadedFiles:loaded.loadedFiles};
}
function command(bin,args,options={}){
  const r=spawnSync(bin,args,{encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024,...options});
  return {exitCode:r.status,stdout:r.stdout||'',stderr:r.stderr||'',error:r.error?.message||null};
}
function probe(c){
  const version=command(c.codexBin,['--version']),exec=command(c.codexBin,['exec','--help']),
    resume=command(c.codexBin,['exec','resume','--help']);
  const interfaceReady=version.exitCode===0&&exec.exitCode===0&&resume.exitCode===0&&
    exec.stdout.includes('--json')&&exec.stdout.includes('--model')&&resume.stdout.includes('--model');
  return {adapter:'codex-cli-v3',hostId:c.hostId,version:version.stdout.trim(),
    cliInterface:interfaceReady?'available':'unavailable',
    routes:c.routes.map(route=>({requestedModel:route.requestedModel,cliModel:route.cliModel,
      provider:route.provider,model:route.model,nativeRouteVerified:!!routeProof(c,route)})),
    capabilities:{durableTokenQuery:'local-process-and-native-rollout',modelSelection:interfaceReady?'exec -m':'unavailable',
      providerModelObservation:'session_meta + turn_context',contextContinuation:'exec resume, verify same thread',
      freshContext:'new exec thread',skillMode:'source_execution only',nativeExplicit:false,
      stop:'process-group request plus formal reconcile',receiptRepair:'workflow recover-result',
      fullDeliveryRunVerified:false},
    note:'CLI 帮助和本地 token 协议不证明模型路由；各模型须 probe-models 成功，整轮交付另行验证。'};
}
function probeModels(c){
  const checks=[];
  for(const route of c.routes){
    const dir=path.dirname(proofPath(c,route));fs.mkdirSync(dir,{recursive:true});
    const startedAt=now(),last=path.join(dir,'last-message.txt');
    const args=['exec','--json','-m',route.cliModel,'--ignore-user-config','--skip-git-repo-check',
      '-s','read-only','-C',dir,'--output-last-message',last,
      'Reply with exactly READY. Do not use tools.'];
    const run=command(c.codexBin,args,{cwd:dir,env:{...process.env,CODEX_HOME:c.codexHome},
      timeout:c.probeTimeoutMs,maxBuffer:32*1024*1024});
    const raw=path.join(dir,`events-${Date.now()}.jsonl`);fs.writeFileSync(raw,run.stdout,{mode:0o600});
    const ids=[...new Set(events(raw).filter(x=>x.type==='thread.started').map(x=>x.thread_id))];
    let observed=null,error=run.error||run.stderr.trim().slice(-250)||'';
    if(ids.length===1)try{observed=nativeObservation(c,ids[0],startedAt,route);}catch(e){error=e.message;}
    const success=run.exitCode===0&&ids.length===1&&!!observed&&
      Date.parse(observed.sessionStartedAt)>=Date.parse(startedAt)&&
      events(raw).some(x=>x.type==='turn.completed');
    const record={success,requestedModel:route.requestedModel,cliModel:route.cliModel,
      provider:route.provider,model:route.model,codexBin:c.codexBin,codexHome:c.codexHome,
      version:command(c.codexBin,['--version']).stdout.trim(),startedAt,threadId:ids[0]||null,
      nativeProof:observed?.proofId||null,eventPath:raw,exitCode:run.exitCode,error:success?null:error||'原生终态未完成'};
    atomic(proofPath(c,route),record);
    checks.push(record);
  }
  return {adapter:'codex-cli-v3',checks,allVerified:checks.every(x=>x.success)};
}
function shellQuote(value){return `'${String(value).replaceAll("'","'\\''")}'`;}
function install(configPath,directory){
  assert(path.isAbsolute(directory),'包装脚本目录必须是绝对路径');
  fs.mkdirSync(directory,{recursive:true});
  const entries={host:'codex-host',observe:'codex-observer',skill:'codex-skill-observer'};
  for(const [mode,name] of Object.entries(entries)){
    const file=path.join(directory,name);
    fs.writeFileSync(file,`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(self)} ${mode} ${shellQuote(path.resolve(configPath))} "$@"\n`,{mode:0o700});
  }
  return {host:path.join(directory,entries.host),observer:path.join(directory,entries.observe),
    skillObserver:path.join(directory,entries.skill)};
}
async function main(argv){
  const [mode,configPath,...rest]=argv;
  assert(mode&&configPath,'用法: codex.mjs <probe|probe-models|install|host|observe|skill|skill-open|skill-complete|worker> <config.json> ...');
  const c=config(configPath);
  if(mode==='probe')return probe(c);
  if(mode==='probe-models')return probeModels(c);
  if(mode==='install')return install(configPath,rest[0]);
  if(mode==='host')return host(c,configPath,rest[0],rest[1]);
  if(mode==='observe')return observe(c,rest[0],rest[1],rest[2]);
  if(mode==='skill')return skillObservation(c,rest[0],rest[1],rest[2]);
  if(mode==='skill-open')return skillOpen(c,rest[0],rest[1]);
  if(mode==='skill-complete')return skillComplete(c,rest[0],rest[1],rest[2]);
  if(mode==='worker'){await worker(c,path.resolve(configPath),rest[0]);return {finished:true};}
  throw new Error('未知适配器命令');
}
try{
  const result=await main(process.argv.slice(2));
  if(typeof result==='string')process.stdout.write(result);
  else process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){
  process.stderr.write(`codex adapter: ${error?.message||'operation failed'}\n`);
  process.exitCode=1;
}
