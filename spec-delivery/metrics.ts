import type { DispatchRecord, HostInstanceRecord, HostUsageObservation, Json, State } from './core.ts';

type MaybeNumber = number | null;
type TokenValue = { value: MaybeNumber; sourcePath: string | null };
const absent = (): TokenValue => ({value:null,sourcePath:null});
const object = (x:Json | undefined): Record<string,Json> | null =>
  x && typeof x==='object' && !Array.isArray(x) ? x : null;
function field(raw:Json,path:string):MaybeNumber {
  let value:Json | undefined=raw;
  for(const part of path.split('.'))value=object(value)?.[part];
  return typeof value==='number' && Number.isFinite(value) && value>=0 ? value : null;
}
function first(raw:Json,paths:string[]):TokenValue {
  for(const sourcePath of paths) {
    const value=field(raw,sourcePath);
    if(value!==null)return {value,sourcePath};
  }
  return absent();
}
/** Provider fields are projections, not additive components of a made-up universal token total. */
export function normalizeUsage(raw:Json) {
  const inputTokens=first(raw,['input_tokens','prompt_tokens','inputTokens']);
  const outputTokens=first(raw,['output_tokens','completion_tokens','outputTokens']);
  const totalTokens=first(raw,['total_tokens','totalTokens']);
  const cachedReadTokens=first(raw,['input_tokens_details.cached_tokens',
    'prompt_tokens_details.cached_tokens','cache_read_input_tokens','prompt_cache_hit_tokens']);
  const cachedWriteTokens=first(raw,['cache_creation_input_tokens','cache_write_input_tokens']);
  const reasoningTokens=first(raw,['output_tokens_details.reasoning_tokens',
    'completion_tokens_details.reasoning_tokens']);
  const modelMs=first(raw,['model_ms','modelMs']);
  const cost=first(raw,['cost_usd','total_cost_usd','cost']);
  const root=object(raw);
  const explicitCurrency=typeof root?.currency==='string' && root.currency.trim()?root.currency.trim():null;
  const currency=cost.value===null?null:
    cost.sourcePath?.endsWith('_usd')?'USD':explicitCurrency;
  return {inputTokens,outputTokens,totalTokens,cachedReadTokens,cachedWriteTokens,
    reasoningTokens,modelMs,explicitCost:{...cost,currency},
    note:'缓存与 reasoning 是子项；不与 input/output/total 相加。total 只在宿主原文提供时存在。'};
}
const ms=(start?:string,end?:string):MaybeNumber=>{
  if(!start||!end)return null;
  const a=Date.parse(start),b=Date.parse(end);
  return Number.isFinite(a)&&Number.isFinite(b)&&b>=a?b-a:null;
};
function numericFields(value:Json,prefix=''): {path:string;value:number}[] {
  if(typeof value==='number')return Number.isFinite(value)&&value>=0&&prefix?[{path:prefix,value}]:[];
  if(!value||typeof value!=='object'||Array.isArray(value))return [];
  return Object.entries(value).flatMap(([key,child])=>numericFields(child,prefix?`${prefix}.${key}`:key));
}
type InstanceRow={host:string;nativeId:string;observations:HostInstanceRecord[];
  dispatches:DispatchRecord[];jobIds:Set<string>;detached:boolean};
function actualInstances(s:State) {
  const rows=new Map<string,InstanceRow>();
  const add=(host:string,i:HostInstanceRecord,d?:DispatchRecord,detached=false)=>{
    if(!i.nativeId)return;
    const key=JSON.stringify([host,i.nativeId]);
    let row=rows.get(key);
    if(!row){row={host,nativeId:i.nativeId,observations:[],dispatches:[],jobIds:new Set(),detached:false};rows.set(key,row);}
    row.observations.push(i);row.detached ||=detached;
    if(d){if(!row.dispatches.includes(d))row.dispatches.push(d);row.jobIds.add(d.jobId);}
  };
  for(const d of s.v3?.dispatchRecords||[])for(const i of d.instances)add(d.targetHost,i,d);
  for(const i of s.v3?.detachedInstances||[])add(i.targetHost,i,undefined,true);
  for(const j of s.jobs)if(j.nativeId&&j.executor==='agent'&&
    ![...rows.values()].some(r=>r.nativeId===j.nativeId&&r.jobIds.has(j.id))) {
    const host=s.capabilities?.framework||'unknown';
    const at=j.timing?.boundAt||j.timing?.leasedAt||'';
    add(host,{key:`legacy:${j.nativeId}`,nativeId:j.nativeId,state:j.status==='done'?'completed':'unknown',
      firstSeenAt:at,lastSeenAt:at,events:[],session:j.session},undefined,true);
    rows.get(JSON.stringify([host,j.nativeId]))!.jobIds.add(j.id);
  }
  return [...rows.values()];
}
const usageOrder=(a:HostUsageObservation,b:HostUsageObservation)=>a.at.localeCompare(b.at)||
  (a.sourcePath===b.sourcePath?(a.sourceIndex??0)-(b.sourceIndex??0):0)||a.id.localeCompare(b.id);
function usageSelection(observations:HostUsageObservation[]) {
  const sessions=observations.filter(o=>o.scope==='session').sort(usageOrder);
  if(sessions.length)return {basis:'latest_session_snapshot' as const,selected:[sessions.at(-1)!]};
  const byCall=new Map<string,HostUsageObservation>();
  for(const o of observations.filter(o=>o.scope==='model_call'&&o.modelCallId)
    .sort(usageOrder))byCall.set(o.modelCallId!,o);
  return {basis:byCall.size?'distinct_model_calls' as const:'unknown' as const,selected:[...byCall.values()]};
}
function instanceTimes(s:State,row:InstanceRow) {
  const associated=s.jobs.filter(j=>row.jobIds.has(j.id));
  const bound=associated.filter(j=>j.nativeId===row.nativeId);
  const events=row.observations.flatMap(i=>i.events).filter(e=>e.kind==='start'&&e.invokedAt)
    .sort((a,b)=>a.invokedAt!.localeCompare(b.invokedAt!));
  const firstStart=events[0]?.invokedAt;
  const starts=row.observations.map(i=>i.startedAt).filter((x):x is string=>!!x).sort();
  const ends=row.observations.flatMap(i=>[i.completedAt,i.cancelledAt]).filter((x):x is string=>!!x).sort();
  const start=starts[0],end=ends[0];
  const receipts=s.v3?.receiptRecords?.filter(r=>row.jobIds.has(r.jobId))
    .flatMap(r=>r.revisions).filter(r=>r.sourceNativeId===row.nativeId)
    .sort((a,b)=>a.at.localeCompare(b.at))||[];
  const firstReceipt=receipts[0],acceptedReceipt=receipts.find(r=>r.status==='accepted');
  const collectedAt=firstReceipt?.at||bound.map(j=>j.timing?.resultAt).filter((x):x is string=>!!x).sort()[0];
  const failure=s.tickets.flatMap(t=>t.failures||[]).filter(f=>f.jobId&&row.jobIds.has(f.jobId))
    .sort((a,b)=>a.at.localeCompare(b.at))[0];
  const recovered=s.v3?.recoveryRecords?.filter(r=>row.jobIds.has(r.jobId)&&
    (!failure||Date.parse(r.at)>=Date.parse(failure.at)))
    .sort((a,b)=>a.at.localeCompare(b.at)).at(-1);
  const stop=bound.map(j=>j.stopConfirmation?.at).filter((x):x is string=>!!x).sort().at(-1);
  return {queueMs:ms(associated.map(j=>j.timing?.leasedAt).filter((x):x is string=>!!x).sort()[0],firstStart),
    launchMs:ms(firstStart,start),executionMs:ms(start,end),
    completionToCollectionMs:ms(end,collectedAt),
    recoveryMs:ms(failure?.at,acceptedReceipt?.at||stop||recovered?.at),
    boundaries:{leasedAt:associated.map(j=>j.timing?.leasedAt).filter(Boolean).sort()[0]||null,
      startRequestedAt:firstStart||null,startedAt:start||null,endedAt:end||null,
      collectedAt:collectedAt||null,recoveryStartedAt:failure?.at||null,
      recoveryEndedAt:acceptedReceipt?.at||stop||recovered?.at||null}};
}
/** Pure, state-only reconciliation. It never probes GitHub, the host, or the filesystem. */
export function reconcileMetrics(s:State) {
  const jobs=s.jobs,agentJobs=jobs.filter(j=>j.executor==='agent'),dispatches=s.v3?.dispatchRecords||[];
  const instances=actualInstances(s).map(row=>{
    const boundJobs=jobs.filter(j=>row.jobIds.has(j.id)&&j.nativeId===row.nativeId);
    const sessions=row.observations.map(i=>i.session).filter((x):x is NonNullable<typeof x>=>!!x);
    const identities=[...new Set(sessions.map(x=>`${x.provider}/${x.model}`))];
    const provider=sessions[0]?.provider||row.observations.map(i=>i.observedProvider).find(Boolean)||null;
    const model=sessions[0]?.model||null;
    const raw=[...new Map(row.observations.flatMap(i=>i.usageObservations||[]).map(o=>[o.id,o])).values()]
      .sort(usageOrder);
    const selected=usageSelection(raw);
    const status=row.observations.some(i=>i.state==='completed')?'completed':
      row.observations.some(i=>i.state==='cancelled')?'cancelled':
      row.observations.some(i=>i.state==='running')?'running':'unknown';
    const reasons:string[]=[];
    if(!boundJobs.length)reasons.push('no_final_job_binding');
    if(row.dispatches.length>1)reasons.push('multiple_dispatch_attempts_same_native_id');
    if(identities.length>1)reasons.push('conflicting_native_session_observations');
    if(provider&&row.observations.some(i=>i.observedProvider&&i.observedProvider!==provider))
      reasons.push(sessions.length?'provider_claim_conflicts_with_native_session':'conflicting_provider_claims');
    if(!provider)reasons.push('provider_unobserved');
    if(!selected.selected.length)reasons.push(raw.length?'usage_scope_unknown':'usage_unobserved');
    const time=instanceTimes(s,row);
    const jobFailures=s.tickets.flatMap(t=>t.failures||[]).filter(f=>f.jobId&&row.jobIds.has(f.jobId));
    const receiptRevisions=(s.v3?.receiptRecords||[]).filter(r=>row.jobIds.has(r.jobId))
      .flatMap(r=>r.revisions).filter(r=>r.sourceNativeId===row.nativeId)
      .map(r=>({id:r.id,status:r.status,source:r.source,at:r.at,rawPath:r.rawPath,
        rawSha256:r.rawSha256,error:r.error||null}));
    return {key:JSON.stringify([row.host,row.nativeId]),targetHost:row.host,nativeId:row.nativeId,
      status,observedStates:row.observations.map(i=>i.state),provider,model,
      sessionObservationIds:sessions.map(x=>x.observationId),
      jobIds:[...row.jobIds],boundJobIds:boundJobs.map(j=>j.id),
      dispatches:row.dispatches.map(d=>({jobId:d.jobId,attempt:d.attempt,token:d.token,status:d.status})),
      detached:row.detached,unexplainedReasons:reasons,usageObservations:raw.map(o=>({
        ...o,normalized:normalizeUsage(o.raw)})),usageBasis:selected.basis,
      jobFailureEvents:jobFailures,receiptRevisions,
      selectedUsageObservationIds:selected.selected.map(o=>o.id),
      selectedUsage:selected.selected.map(o=>({id:o.id,normalized:normalizeUsage(o.raw)})),
      timing:time};
  });
  const fields=new Map<string,{provider:string;path:string;sum:number;contributionCount:number}>();
  const costs=new Map<string,{provider:string;currency:string;amount:number;contributionCount:number}>();
  for(const i of instances) {
    const provider=i.provider||'unknown';
    for(const id of i.selectedUsageObservationIds) {
      const raw=i.usageObservations.find(o=>o.id===id)!.raw;
      for(const f of numericFields(raw)) {
        // Monetary values have no common unit until the provider supplied an explicit currency.
        if(/(?:^|\.)(?:cost|cost_usd|total_cost_usd)$/.test(f.path))continue;
        const key=JSON.stringify([provider,f.path]),value=fields.get(key)||{provider,path:f.path,sum:0,contributionCount:0};
        value.sum+=f.value;value.contributionCount++;fields.set(key,value);
      }
      const cost=normalizeUsage(raw).explicitCost;
      if(cost.value!==null&&cost.currency) {
        const key=JSON.stringify([provider,cost.currency]),value=costs.get(key)||{
          provider,currency:cost.currency,amount:0,contributionCount:0};
        value.amount+=cost.value;value.contributionCount++;costs.set(key,value);
      }
    }
  }
  // Recovery is a job-level interval and can span multiple corrected identities;
  // only explicit wait intervals are aggregated, avoiding duplicate instance time.
  const timeFields=['queueMs','launchMs','executionMs','completionToCollectionMs'] as const;
  const durations=Object.fromEntries(timeFields.map(key=>{
    const measured=instances.map(i=>i.timing[key]).filter((x):x is number=>x!==null);
    return [key,{measuredInstances:measured.length,unknownInstances:instances.length-measured.length,
      sumKnownMs:measured.length?measured.reduce((a,b)=>a+b,0):null}];
  }));
  const waits=s.waitIntervals||[];
  const external=waits.filter(w=>w.kind==='external').map(w=>({...w,durationMs:ms(w.startedAt,w.endedAt)}));
  const externalMeasured=external.map(w=>w.durationMs).filter((x):x is number=>x!==null);
  const recovery=waits.filter(w=>w.kind==='recovery').map(w=>({...w,durationMs:ms(w.startedAt,w.endedAt)}));
  const recoveryMeasured=recovery.map(w=>w.durationMs).filter((x):x is number=>x!==null);
  const callIds=new Set(instances.flatMap(i=>i.usageObservations.filter(o=>o.scope==='model_call'&&o.modelCallId)
    .map(o=>`${i.key}:${o.modelCallId}`)));
  const placeholders=dispatches.flatMap(d=>d.instances.filter(i=>!i.nativeId).map(i=>({
    jobId:d.jobId,token:d.token,targetHost:d.targetHost,state:i.state,
    usageObservations:i.usageObservations||[]}))).filter(i=>i.usageObservations.length>0||i.state==='unknown');
  const first=s.events.map(e=>e.at).filter((x):x is string=>!!x).sort()[0];
  const last=s.events.map(e=>e.at).filter((x):x is string=>!!x).sort().at(-1);
  return {scope:{jobCount:jobs.length,agentJobCount:agentJobs.length,
    commandJobCount:jobs.filter(j=>j.executor==='command').length,
    dispatchAttemptCount:dispatches.length,observedNativeInstanceCount:instances.length,
    verifiedNativeSessionCount:instances.filter(i=>i.sessionObservationIds.length>0).length,
    observedModelCallCount:callIds.size,totalModelCallCount:null,
    skillInvocationCount:s.v3?.skillInvocations.length||0,
    skillChildRequestCount:s.v3?.skillChildren?.length||0,
    githubCliInvocations:s.telemetry?.ghInvocations??null,
    mainSession:s.mainSession?.source==='native_host'?{
      nativeId:s.mainSession.nativeId,provider:s.mainSession.provider,model:s.mainSession.model,
      usage:null}:{nativeId:null,provider:null,model:null,usage:null},
    coversMainSessionUsage:false,coversCommandUsage:false,
    note:'jobs、dispatch attempts、原生实例、模型调用、命令与 GitHub CLI 调用是不同计数；模型调用总数未知。'},
    instances,unexplainedInstances:instances.filter(i=>i.unexplainedReasons.length).map(i=>({
      key:i.key,reasons:i.unexplainedReasons})),unallocatedTokenObservations:placeholders,
    rawFieldTotals:[...fields.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.path.localeCompare(b.path)),
    explicitCostByCurrency:[...costs.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.currency.localeCompare(b.currency)),
    instancesMissingUsage:instances.filter(i=>!i.selectedUsageObservationIds.length).map(i=>i.key),
    instancesMissingExplicitCost:instances.filter(i=>!i.selectedUsage.some(o=>o.normalized.explicitCost.value!==null&&
      o.normalized.explicitCost.currency)).map(i=>i.key),
    durationSummary:{...durations,externalWaitMs:{measuredIntervals:externalMeasured.length,
      unknownIntervals:external.length-externalMeasured.length,
      sumKnownMs:externalMeasured.length?externalMeasured.reduce((a,b)=>a+b,0):null},
      recoveryWaitMs:{measuredIntervals:recoveryMeasured.length,
        unknownIntervals:recovery.length-recoveryMeasured.length,
        sumKnownMs:recoveryMeasured.length?recoveryMeasured.reduce((a,b)=>a+b,0):null},
      runWallMs:['complete','retired'].includes(s.status)?ms(first,last):null,
      note:'各实例时长可能并行重叠；累计毫秒不等于墙钟节省。宿主未提供的边界保持 null。'},
    externalWaits:external,recoveryWaits:recovery,
    semantics:'rawFieldTotals 仅按同一 provider 与原始字段路径分别求和；缓存/reasoning 子项不与 input/output/total 相加。仅显式货币费用可计入 explicitCostByCurrency。'};
}

export function compareMetrics(before:State,after:State) {
  const a=reconcileMetrics(before),b=reconcileMetrics(after);
  const keys=['jobCount','agentJobCount','commandJobCount','dispatchAttemptCount',
    'observedNativeInstanceCount','verifiedNativeSessionCount','observedModelCallCount','skillInvocationCount',
    'skillChildRequestCount'] as const;
  const delta=Object.fromEntries(keys.map(k=>[k,b.scope[k]-a.scope[k]]));
  const measures=(m:ReturnType<typeof reconcileMetrics>)=>({rawFieldTotals:m.rawFieldTotals,
    explicitCostByCurrency:m.explicitCostByCurrency,durationSummary:m.durationSummary,
    missingUsageInstances:m.instancesMissingUsage.length,
    missingExplicitCostInstances:m.instancesMissingExplicitCost.length});
  return {beforeRun:before.id,afterRun:after.id,before:a.scope,after:b.scope,delta,
    sameRun:before.id===after.id,sameSpec:before.spec===after.spec,
    sameTicketSet:JSON.stringify(before.tickets.map(t=>t.number).sort())===
      JSON.stringify(after.tickets.map(t=>t.number).sort()),
    beforeMeasures:measures(a),afterMeasures:measures(b),
    note:'前后展示同名可观测指标；调用者须确认工作量相同。未知费用、模型调用总数和并行墙钟节省不推算。'};
}
