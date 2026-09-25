import test from 'node:test';
import assert from 'node:assert/strict';
import * as e from './core.ts';

function fixture(human = false): e.State {
  const s: e.State = { schema: 1, id: 'isolated-test', revision: 0,
    inputs: { spec: 100, targetBranch: 'main', models: { L1: 'large', L2: 'middle', L3: 'small' } }, spec: 100,
    repo: { root: '/unused', slug: 'example/test', host: 'github.com', defaultBranch: 'main' }, status: 'planning',
    specCriteria: [], planEvidence: '', tickets: [], jobs: [], auditEpoch: 1, events: [],
    facts: { base: 'A', issueStates: { 100: 'OPEN', 101: 'OPEN', 102: 'OPEN' }, prs: {}, at: 'fixture' } };
  const tickets: e.TicketPlan[] = [{ number: 101, kind: 'software', dependencies: [], criteria: ['software'], visual: false }];
  if (human) tickets.push({ number: 102, kind: 'human', dependencies: [101], criteria: ['onsite'], visual: false });
  e.applyPlan(s, { capabilities: { framework: 'test', mainModel: 'large', modelRouting: 'per_agent', models: ['large', 'middle', 'small'] },
    policy: { agents: 8, issues: 2, tests: 1, noProgress: 2, rounds: 5 }, tickets, specCriteria: ['spec'], evidencePath: '/fixture/plan' },
  tickets.map(t => ({ number: t.number, state: 'OPEN', blockedBy: [] })));
  return s;
}
function response(s: e.State, j: e.Job, opts: { finding?: number; human?: boolean } = {}): e.Result {
  const t = s.tickets.find(t => t.key === j.ticket);
  const r: e.Result = { model: j.model, complete: true, status: '', head: t?.head || '', base: j.base,
    evidencePath: `/fixture/${j.id}`, handoffPath: '/fixture/handoff', data: {} };
  switch (j.action) {
    case 'claim': r.status = 'claimed'; r.data = { branch: 'codex/task', worktree: '/fixture/worktree', head: 'A' }; break;
    case 'plan': case 'replan': r.status = 'planned'; r.data = { planPath: '/fixture/plan', checksPath: '/fixture/checks' }; break;
    case 'plan-check': r.status = 'pass'; break;
    case 'implement': case 'integrate': r.status = 'implemented'; r.head = t!.head + '1'; break;
    case 'self-standards': case 'self-spec': case 'review-lens':
      r.status = 'reviewed'; r.findings = opts.finding !== undefined && j.action === 'review-lens' && j.part === '0'
        ? [{ id: 'bug', description: 'reproducible bug', evidence: 'file:1' }] : []; break;
    case 'confirm': r.status = 'confirmed'; r.findings = [{ id: j.part, description: 'reproducible bug', evidence: 'reproducer', confidence: opts.finding || 0, confirmed: (opts.finding || 0) >= 50 }]; break;
    case 'verify': r.status = 'pass'; break;
    case 'publish': r.status = 'published'; r.data = { pr: 201, commentUrl: 'https://example/comment' };
      s.facts.prs[201] = { number: 201, head: t!.head, base: t!.base, baseRef: 'main', state: 'OPEN', draft: false, mergeable: 'MERGEABLE', checks: [{ id: 'ci', status: 'pass' }] }; break;
    case 'review-report': r.status = 'posted'; r.data = { commentUrl: 'https://example/review' }; break;
    case 'accept': r.status = 'ready'; r.data = { satisfiedCriteria: t!.criteria }; break;
    case 'merge': r.status = 'merged'; s.facts.prs[t!.pr].state = 'MERGED'; s.facts.base = 'merged'; break;
    case 'close': r.status = 'closed'; s.facts.issueStates[t!.number] = 'CLOSED'; break;
    case 'cleanup': r.status = 'cleaned'; break;
    case 'spec-audit': r.status = opts.human ? 'waiting_human' : 'complete'; r.data = { satisfiedCriteria: ['spec'], humanHandoffUrl: 'https://example/handoff' }; break;
    case 'spec-close': r.status = 'closed'; s.facts.issueStates[s.spec] = 'CLOSED'; break;
  }
  return r;
}
function finish(s: e.State, j: e.Job, options: {finding?: number; human?: boolean} = {}) {
  e.bind(s, j.id, { nativeId: `actual-${j.id}`, model: j.model }); e.submit(s, j.id, response(s, j, options));
}
function until(s: e.State, condition: () => boolean, options: {finding?: number; human?: boolean} = {}) {
  for (let n = 0; n < 100 && !condition(); n++) {
    const js = e.reserve(s); assert.ok(js.length, `Unexpected stall: ${s.tickets.map(t => t.phase)}`);
    for (const j of js) finish(s, j, options);
  }
  assert.ok(condition(), 'Finite simulation did not reach intended boundary');
}
test('完整软件路径：独立两轮审查、合并、关闭、清理、spec 验收', () => {
  const s = fixture(); until(s, () => s.status === 'complete');
  assert.equal(s.tickets[0].cleaned, true);
  assert.equal(s.jobs.filter(j => j.action === 'review-lens').length, 10);
  assert.equal(s.jobs.filter(j => j.action === 'accept').length, 1);
});
test('人工尾项保持父 spec 打开并产生交接', () => {
  const s = fixture(true); until(s, () => s.status === 'waiting_human', {human:true});
  assert.equal(s.facts.issueStates[100], 'OPEN'); assert.equal(s.tickets[0].cleaned, true);
});
test('>=50 回到修复；49 不阻塞', () => {
  for (const score of [49, 50]) {
    const s = fixture(); until(s, () => s.jobs.some(j => j.action === 'review-report' && j.status === 'done'), {finding:score});
    assert.equal(s.tickets[0].phase, score === 50 ? 'implement' : 'fresh');
  }
});
test('五路之一未完成时不能汇总为通过', () => {
  const s = fixture(); until(s, () => s.tickets[0].phase === 'review');
  const jobs = e.reserve(s); assert.equal(jobs.length, 5);
  for (const j of jobs.slice(0, 4)) finish(s, j);
  assert.deepEqual(e.reserve(s), []); assert.equal(s.tickets[0].evidence.regular, undefined);
});
test('模型不匹配与跳过均不能冒充完成', () => {
  const s = fixture(), j = e.reserve(s)[0];
  assert.throws(() => e.bind(s, j.id, {nativeId:'actual',model:'wrong'}));
  e.bind(s, j.id, {nativeId:'actual',model:j.model});
  assert.throws(() => e.submit(s, j.id, {model:j.model,complete:true,status:'skipped',evidencePath:'/fixture'}));
});
test('CI 实际失败不可豁免；缺 CI 需明确证据', () => {
  const pr = { checks: [{id:'1',status:'failed'}] } as e.LivePR;
  const r = { data: {ciWaiver:{reason:'billing',evidence:'bill',notStartedIds:['1']}} } as unknown as e.Result;
  assert.equal(e.ciAllowed(pr, r), false);
  assert.equal(e.ciAllowed({...pr,checks:[]}), false);
  assert.equal(e.ciAllowed({...pr,checks:[]}, {...r,data:{ciConfigured:false,ciWaiver:{reason:'no_ci',evidence:'inspected'}}}), true);
  assert.equal(e.ciAllowed({...pr,checks:[{id:'1',status:'pending'}]}, r), false);
});
test('修复已提交尚未推送时，旧远端 head 不覆盖本地新候选', () => {
  const s = fixture(); until(s, () => s.tickets[0].phase === 'implement' && s.tickets[0].round > 0, {finding:50});
  const job = e.reserve(s)[0]; finish(s, job);
  const head = s.tickets[0].head;
  e.reconcileFacts(s, structuredClone(s.facts));
  assert.equal(s.tickets[0].head, head); assert.equal(s.tickets[0].phase, 'self');
  for (const j of e.reserve(s)) finish(s, j);
  assert.equal(s.tickets[0].phase, 'verify');
});
test('目标分支改变后作废 spec 审核', () => {
  const s = fixture(); s.tickets[0].phase = 'done';
  const audit = e.reserve(s)[0]; finish(s, audit);
  e.reconcileFacts(s, {...s.facts,base:'B'});
  assert.equal(s.specAudit, undefined); assert.equal(e.reserve(s)[0].action, 'spec-audit');
});
test('中途人工技术前置触发交接而不是空转或提前完成', () => {
  const s = fixture(true); s.tickets[0].dependencies = [102]; s.tickets[1].dependencies = [];
  const audit = e.reserve(s)[0]; assert.equal(audit.action, 'spec-audit');
  e.bind(s,audit.id,{nativeId:'audit',model:audit.model});
  assert.throws(() => e.submit(structuredClone(s),audit.id,response(s,audit)));
  e.submit(s,audit.id,response(s,audit,{human:true})); assert.equal(s.status,'waiting_human');
});
test('审查单路丢失可重派，其余上下文与结果保留', () => {
  const s = fixture(); until(s, () => s.tickets[0].phase === 'review');
  const js = e.reserve(s); js[0].status = 'cancelled';
  for (const j of js.slice(1)) finish(s,j);
  const replacement=e.reserve(s)[0]; assert.notEqual(replacement.id,js[0].id); assert.equal(replacement.epoch,js[0].epoch);
  finish(s,replacement); assert.equal(e.reserve(s)[0].action,'review-report');
});
test('恢复次数不消耗实际收尾轮数', () => {
  const s=fixture(); s.tickets[0].phase='done'; s.auditEpoch=100;
  const j=e.reserve(s)[0]; e.bind(s,j.id,{nativeId:'audit',model:j.model});
  const r=response(s,j); r.status='needs_closeout'; r.data={planPath:'/fixture/plan',remainingCriteria:['missing']};
  e.submit(s,j.id,r); assert.equal(s.tickets.filter(t=>t.closeout).length,1); assert.equal(s.status,'running');
});
test('父 spec 提前被关闭仍会清理已验收的收尾资源', () => {
  const s=fixture(); s.tickets[0].phase='done';
  const t=e.buildTicket({number:100,kind:'software',dependencies:[],criteria:['spec'],visual:false},'A',true);
  t.phase='done'; t.worktree='/fixture/worktree'; s.tickets.push(t); s.facts.issueStates[100]='CLOSED';
  s.specAudit={model:'large',complete:true,status:'complete',base:'A',evidencePath:'/fixture'};
  e.reconcileFacts(s,structuredClone(s.facts)); assert.equal(t.phase,'cleanup'); assert.equal(s.status,'running');
});
test('issue 未关闭时绝不允许清理成功', () => {
  const s=fixture(); until(s,()=>s.tickets[0].phase==='close');
  assert.equal(e.reserve(s)[0].action,'close'); assert.equal(s.tickets[0].cleaned,false);
});
test('外部将 PR 合入另一分支后保留工单和资源', () => {
  const s=fixture(); until(s,()=>s.tickets[0].phase==='accept');
  const facts=structuredClone(s.facts); facts.prs[201].state='MERGED'; facts.prs[201].baseRef='elsewhere';
  e.reconcileFacts(s,facts); assert.equal(s.tickets[0].phase,'blocked'); assert.equal(s.tickets[0].cleaned,false);
});
test('CI 等待保留队首并等待事件，通过后恢复验收，不派空转审计', () => {
  const s=fixture(); until(s,()=>s.tickets[0].phase==='accept');
  const accept=e.reserve(s)[0]; e.bind(s,accept.id,{nativeId:'accept',model:accept.model});
  s.facts.prs[201].checks=[{id:'ci',status:'pending'}];
  e.submit(s,accept.id,response(s,accept)); assert.equal(s.tickets[0].reason,'waiting_ci');
  assert.deepEqual(e.reserve(s),[]);assert.equal(s.validationOwner,s.tickets[0].key);
  const facts=structuredClone(s.facts); facts.prs[201].checks=[{id:'ci',status:'pass'}];
  e.reconcileFacts(s,facts); assert.equal(s.status,'running'); assert.equal(s.specAudit,undefined);
  until(s,()=>s.status==='complete');
});
test('真实 CI 失败回到修复；等待时外部基线变化先集成再验收',()=>{
  for(const outcome of ['failed','moved']) {
    const s=fixture();until(s,()=>s.tickets[0].phase==='accept');const j=e.reserve(s)[0];e.bind(s,j.id,{nativeId:'accept',model:j.model});
    s.facts.prs[201].checks=[{id:'ci',status:'pending'}];e.submit(s,j.id,response(s,j));
    const facts=structuredClone(s.facts);facts.prs[201].checks=[{id:'ci',status:outcome==='failed'?'failed':'pass'}];
    if(outcome==='moved'){facts.base='new-base';facts.prs[201].base='new-base';s.validationOwner=undefined;}
    e.reconcileFacts(s,facts);assert.equal(e.reserve(s)[0].action,outcome==='failed'?'implement':'integrate');
    assert.equal(s.tickets[0].evidence.accept,undefined);
  }
});
test('对账保留用户暂停状态，不自动启动资源清理', () => {
  const s=fixture(); s.tickets[0].phase='done';
  const t=e.buildTicket({number:100,kind:'software',dependencies:[],criteria:['spec'],visual:false},'A',true);
  t.phase='done'; t.worktree='/fixture/worktree'; s.tickets.push(t); s.facts.issueStates[100]='CLOSED';
  s.specAudit={model:'large',complete:true,status:'complete',base:'A',evidencePath:'/fixture'}; s.status='paused';
  e.reconcileFacts(s,structuredClone(s.facts)); assert.equal(s.status,'paused'); assert.throws(()=>e.reserve(s));
});

test('并行完成的候选排队验证，前一票合并不重审队外候选', () => {
  const s=fixture();
  const a=s.tickets[0]; a.phase='implement'; a.worktree='/fixture/a'; a.head='A';
  const b=e.buildTicket({number:102,kind:'software',dependencies:[],criteria:['b'],visual:false},'A');
  b.phase='implement'; b.worktree='/fixture/b'; b.head='A'; s.tickets.push(b); s.policy!.tests=2;
  for(const j of e.reserve(s)) finish(s,j);
  const js=e.reserve(s);
  assert.equal(new Set(js.map(j=>j.ticket)).size,1,'只有队首可以进入自检和最终验证');
  assert.equal(js.length,2,'保留两轴独立自检');
  const waiting=s.tickets.find(t=>t.key!==js[0].ticket)!;
  e.reconcileFacts(s,{...structuredClone(s.facts),base:'B'});
  assert.equal(waiting.head,'A1');
  assert.equal(s.jobs.some(j=>j.ticket===waiting.key&&j.action==='integrate'),false,'队外不反复集成');
});

test('队首外部基线变化必须集成，反复失效进入有限重规划', () => {
  const s=fixture(); until(s,()=>s.tickets[0].phase==='review');
  e.reconcileFacts(s,{...structuredClone(s.facts),base:'B'});
  assert.equal(e.reserve(s)[0].action,'integrate');
  const j=s.jobs.at(-1)!; finish(s,j);
  e.reconcileFacts(s,{...structuredClone(s.facts),base:'C'});
  assert.equal(s.tickets[0].phase,'replan');
  assert.equal(s.tickets[0].baseInvalidations,2);
});
test('spec 审计在途时继续调度不会重复审计或误判工单', () => {
  const s=fixture(); s.tickets[0].phase='done';
  const j=e.reserve(s)[0]; e.bind(s,j.id,{nativeId:'audit',model:j.model});
  assert.deepEqual(e.reserve(s),[]);
});

test('多个视角的同一问题只复核一次，并保留所有原始发现', () => {
  const s=fixture(); s.policy!.tests=2; until(s,()=>s.tickets[0].phase==='review');
  for(const j of e.reserve(s)) {
    e.bind(s,j.id,{nativeId:j.id,model:j.model}); const r=response(s,j);
    if(['0','2'].includes(j.part)) r.findings=[{id:j.part,description:'README test count is outdated',evidence:'README:80',identity:{path:'README.md',rule:'test-count',trigger:'tests-added'}}];
    e.submit(s,j.id,r);
  }
  const js=e.reserve(s); assert.equal(js.length,1); assert.equal(js[0].action,'confirm');
  assert.equal(s.jobs.filter(j=>j.action==='review-lens'&&j.result?.findings?.length).length,2);
});

test('同一候选 regular 与 fresh 判定分歧交 L1 裁决，不能直接签发通过', () => {
  const s=fixture(); until(s,()=>s.tickets[0].phase==='fresh',{finding:25});
  until(s,()=>s.jobs.some(j=>j.action==='confirm'&&j.fresh&&j.status==='done'),{finding:50});
  const j=e.reserve(s)[0]; assert.equal(j.action,'adjudicate'); assert.equal(j.tier,'L1'); assert.equal(j.fresh,true);
  e.bind(s,j.id,{nativeId:j.id,model:j.model});
  const r: e.Result={model:j.model,complete:true,status:'confirmed',head:j.head,base:j.base,evidencePath:'/fixture/judgement',findings:[{id:j.part,description:'same verified defect',evidence:'proof',confidence:50,confirmed:true,assessment:{factual:'reproduced',responsibility:'introduced by this candidate',severity:'minor',rationale:'the earlier exclusion confused responsibility with severity'}}]};
  e.submit(s,j.id,r); const report=e.reserve(s)[0]; assert.equal(report.action,'review-report'); finish(s,report);
  assert.equal(s.tickets[0].phase,'implement');
});

test('五工单回放：十组五路审查完成交付，队列无基线反复失效',()=>{
  const s=fixture();s.policy={agents:8,issues:3,tests:3,noProgress:3,rounds:4};
  s.tickets=[101,102,103,104,105].map(number=>e.buildTicket({number,kind:'software',dependencies:number===102?[101]:number===103?[102]:[],criteria:['done'],visual:false},'A'));
  for(const t of s.tickets)s.facts.issueStates[t.number]='OPEN';
  for(let step=0;step<150&&s.status!=='complete';step++) {
    e.reconcileFacts(s,structuredClone(s.facts));const js=e.reserve(s);assert.ok(js.length,'scheduler must progress');
    for(const j of js) {
      e.bind(s,j.id,{nativeId:j.id,model:j.model});const r=response(s,j);const t=s.tickets.find(t=>t.key===j.ticket);
      if(j.action==='publish') {delete s.facts.prs[201];const pr=200+t!.number;r.data={pr,commentUrl:'https://example/pr'};s.facts.prs[pr]={number:pr,head:t!.head,base:t!.base,baseRef:'main',state:'OPEN',draft:false,mergeable:'MERGEABLE',checks:[{id:'ci',status:'pass'}]};}
      if(j.action==='merge')s.facts.base=`merge-${t!.number}`;
      e.submit(s,j.id,r);
    }
  }
  assert.equal(s.status,'complete');assert.equal(s.jobs.filter(j=>j.action==='review-lens').length,50);
  assert.equal(s.tickets.reduce((n,t)=>n+(t.baseInvalidations||0),0),0);
  assert.ok(s.jobs.filter(j=>j.action==='integrate').length<=4);
});
test('不完整历史确认没有 findings 时不参与跨轮裁决',()=>{
  const s=fixture();until(s,()=>s.tickets[0].phase==='review');
  for(const j of e.reserve(s))finish(s,j,{finding:25});
  const confirmation=e.reserve(s)[0];finish(s,confirmation,{finding:25});
  s.jobs.push({...confirmation,id:'old-incomplete',epoch:confirmation.epoch-1,result:{model:confirmation.model,complete:false,status:'interrupted',evidencePath:'/fixture/interrupted'}});
  assert.equal(e.reserve(s)[0].action,'review-report');
});
