#!/usr/bin/env node
/** Observe the actual calling Codex coordinator session, without emitting rollout contents. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{throw new Error(message);};
const assert=(condition,message)=>{if(!condition)fail(message);};
function rollout(root,id){
  const sessions=path.join(root,'sessions');
  const found=[];
  for(const year of fs.readdirSync(sessions,{withFileTypes:true}).filter(x=>x.isDirectory())){
    for(const month of fs.readdirSync(path.join(sessions,year.name),{withFileTypes:true}).filter(x=>x.isDirectory())){
      const monthPath=path.join(sessions,year.name,month.name);
      for(const day of fs.readdirSync(monthPath,{withFileTypes:true}).filter(x=>x.isDirectory())){
        const dayPath=path.join(monthPath,day.name);
        for(const file of fs.readdirSync(dayPath,{withFileTypes:true})){
          if(file.isFile()&&file.name.endsWith(`-${id}.jsonl`))found.push(path.join(dayPath,file.name));
        }
      }
    }
  }
  assert(found.length===1,'当前 Codex 会话 rollout 未唯一定位');
  return found[0];
}
function observe(nativeId,jobId){
  assert(jobId==='$main','Codex 主会话 observer 只处理 $main');
  const current=process.env.CODEX_SESSION_ID,thread=process.env.CODEX_THREAD_ID;
  assert(/^[0-9a-f-]{36}$/.test(current||'')&&current===thread&&nativeId===current,
    '请求身份不是当前 Codex 主会话');
  const file=rollout(path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex')),current);
  let meta=null,context=null,metaLine='',contextLine='';
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
    if(!line)continue;
    let event;try{event=JSON.parse(line);}catch{continue;}
    if(event.type==='session_meta'){
      assert(event.payload?.id===current&&event.payload?.session_id===current,
        'rollout 主会话身份不符');
      if(meta)assert(meta.model_provider===event.payload.model_provider,'rollout provider 变化');
      meta=event.payload;metaLine=line;
    }
    if(event.type==='turn_context'&&typeof event.payload?.model==='string'){
      context=event;contextLine=line;
    }
  }
  assert(meta?.model_provider&&context?.payload?.model&&Number.isFinite(Date.parse(context.timestamp)),
    'rollout 缺少原生 provider、当前 turn 模型或时间');
  const proofId=sha(`${current}\n${metaLine}\n${contextLine}`);
  return {source:'native_host',observationId:sha(`${proofId}:$main`),jobId,nativeId:current,
    provider:meta.model_provider,model:context.payload.model,observedAt:context.timestamp,
    context:{contextId:current,mode:'new',proofId}};
}
try{
  const [operation,nativeId,jobId]=process.argv.slice(2);
  assert(operation==='observe','仅支持 observe');
  process.stdout.write(JSON.stringify(observe(nativeId,jobId))+'\n');
}catch(error){
  process.stderr.write(`codex main observer: ${error?.message||'observation failed'}\n`);
  process.exitCode=1;
}
