#!/usr/bin/env node
/** Controlled native host with durable token, identity and terminal result records. */
import fs from 'node:fs';
import path from 'node:path';

const file=process.env.SPEC_DELIVERY_COMBINED_HOST_DB;
const sessionsFile=process.env.SPEC_DELIVERY_COMBINED_SESSIONS;
if (!file || !sessionsFile) throw Error('missing combined host fixture');
const [operation,requestPath]=process.argv.slice(2);
const request=JSON.parse(fs.readFileSync(requestPath,'utf8'));
const db=JSON.parse(fs.readFileSync(file,'utf8'));
const actor=db.actors[request.token];
const save=()=>fs.writeFileSync(file,JSON.stringify(db));
const reply=fields=>console.log(JSON.stringify({token:request.token,jobId:request.jobId,
  targetHost:request.targetHost,...fields}));
if (operation==='query') {
  if (!actor) reply({state:'not_found',authoritative:true});
  else reply({state:actor.state,nativeId:actor.nativeId,startedAt:actor.startedAt,
    completedAt:actor.completedAt,usage:actor.usage});
} else if (operation==='start') {
  if (actor) throw Error('duplicate native start for token');
  const nativeId='combined-native-'+Object.keys(db.actors).length;
  const statePath=path.join(path.dirname(requestPath),'..','state.json');
  const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
  const job=state.jobs.find(row=>row.id===request.jobId);
  const previous=state.jobs.find(row=>row.id===job?.contextIntent?.predecessorJobId ||
    row.id===job?.contextIntent?.parentJobId);
  const resumed=job?.contextIntent?.kind==='continue' && previous?.contextObservation &&
    previous.model===request.requestedModel;
  const contextId=resumed?previous.contextObservation.contextId:nativeId;
  const context={contextId,mode:resumed?'resumed':'new',proofId:'native-context-'+nativeId};
  if (resumed) context.resumedFromContextId=previous.contextObservation.contextId;
  db.actors[request.token]={state:'running',nativeId,
    startedAt:'2026-09-27T00:00:00.000Z',jobId:request.jobId};
  db.starts=(db.starts || 0)+1;save();
  const sessions=JSON.parse(fs.readFileSync(sessionsFile,'utf8'));
  sessions[nativeId]={source:'native_host',observationId:'observed-'+nativeId,
    jobId:request.jobId,nativeId,provider:'fixture',model:request.requestedModel,
    context,observedAt:'2026-09-27T00:00:00.000Z'};
  fs.writeFileSync(sessionsFile,JSON.stringify(sessions));
  reply({state:'running',nativeId,startedAt:db.actors[request.token].startedAt});
} else if (operation==='collect') {
  if (!actor || actor.state!=='completed') throw Error('actor has no terminal result');
  reply({state:'completed',nativeId:actor.nativeId,result:actor.result,
    startedAt:actor.startedAt,completedAt:actor.completedAt,usage:actor.usage});
} else if (operation==='cancel') {
  if (!actor) throw Error('unknown actor');
  actor.state='cancelled';save();reply({state:'cancelled',nativeId:actor.nativeId,
    cancelledAt:'2026-09-27T00:00:02.000Z'});
} else throw Error('unknown host operation '+operation);
