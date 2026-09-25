import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { normalizeResult } from './host.ts';
import { renderZcode, stageResult, packet } from '../spec-delivery.workflow.ts';
import type { State, Job } from './core.ts';
function setup() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-host-'));
  const j:Job={id:'run:101:1:plan::try-1',ticket:'101',epoch:1,action:'plan',part:'',tier:'L1',model:'actual-provider/model',executor:'agent',fresh:true,contextKey:'ctx',head:'a',base:'b',tests:0,status:'leased',nativeId:''};
  const s:State={schema:1,protocol:2,id:'run',revision:0,inputs:{spec:100,targetBranch:'main',models:{L1:j.model,L2:'review',L3:'implement'}},spec:100,repo:{root,slug:'example/test',host:'github.com',defaultBranch:'main'},status:'running',jobs:[j],tickets:[],specCriteria:[],planEvidence:'',auditEpoch:1,events:[],facts:{base:'b',issueStates:{},prs:{},at:''}};
  const file=path.join(root,'state.json');fs.writeFileSync(file,JSON.stringify(s));fs.writeFileSync(path.join(root,'evidence.md'),'actual evidence');
  return {root,j,s,file};
}
test('宿主填入实际绑定身份，真实证据缺失不能形成回执',()=>{
  const x=setup();try {
    const r=normalizeResult(x.s,x.j,{model:'misspelled',complete:true,status:'planned',evidencePath:'evidence.md'});
    assert.equal(r.model,x.j.model);assert.equal(r.evidencePath,path.join(x.root,'evidence.md'));
    assert.throws(()=>stageResult(x.file,x.j.id,{complete:true,status:'planned',evidencePath:'missing'}));
    const receipt=stageResult(x.file,x.j.id,r);assert.ok(fs.existsSync(receipt.resultPath));assert.deepEqual(receipt.submitted,[],'原生身份尚未绑定时只持久化，不冒充已完成');
    assert.doesNotThrow(()=>stageResult(x.file,x.j.id,r));
    assert.throws(()=>stageResult(x.file,x.j.id,{...r,status:'different'}));
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('ZCode 每个 actor 完成后立即登记，快任务不等待整批慢任务',async()=>{
  const x=setup();try {
    x.s.jobs.push({...x.j,id:'run:102:1:plan::try-1',ticket:'102'});
    const batch=renderZcode(x.s,x.file)[0] as {arguments:{path:string}};
    const script=fs.readFileSync(batch.arguments.path,'utf8');
    const compiled=stripTypeScriptTypes(`async function execute(){${script}}`)+'\nreturn execute();';
    let release!:()=>void;const slow=new Promise<void>(r=>{release=r});const staged:string[]=[];
    const fn=new Function('agent','world','phase','report','artifact',compiled);
    const execution=fn((name:string)=>({ask:async()=>{if(name.startsWith('102'))await slow;return{resultJson:'{}',summary:'ok'};}}),{run:async(_cmd:string,args:string[])=>{staged.push(args[3]);return{exitCode:0,stdout:'{}',stderr:''};}},()=>{},()=>{},{markdown:async()=>{}});
    await new Promise(r=>setImmediate(r));assert.deepEqual(staged,[x.j.id]);release();await execution;assert.equal(staged.length,2);
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
test('派发只携带有界证据索引，fresh 不接收旧结论',()=>{
  const x=setup();try {
    for(let n=0;n<100;n++)x.s.jobs.push({...x.j,id:'old'+n,status:'done',result:{model:x.j.model,complete:true,status:'reviewed',evidencePath:'x',findings:[{id:'x',description:'z'.repeat(20000),evidence:'e'}]}});
    const p=packet(x.s,{...x.j,action:'publish',fresh:false},x.file);
    assert.ok(Buffer.byteLength(JSON.stringify(p))<16000);assert.ok(fs.existsSync(p.historyIndexPath));
    assert.ok(p.prior.every(item=>fs.existsSync(item.resultPath)));
    x.s.tickets.push({key:'101',lastProblem:'old review says bug',reason:'earlier conclusion',evidence:{}} as any);
    const f=packet(x.s,{...x.j,action:'review-lens',fresh:true},x.file);assert.deepEqual(f.prior,[]);assert.equal(f.historyIndexPath,'');assert.equal(f.blockingReason,'');
  } finally {fs.rmSync(x.root,{recursive:true,force:true});}
});
