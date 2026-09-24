/** 可移植的调度内核。语义判断由 L1/2/3 提供；转换、预算和证据版本由代码约束。 */
export type Tier = 'L1' | 'L2' | 'L3';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Inputs { spec: number | string; targetBranch: string; models: Record<Tier, string> }
export interface Policy { agents: number; issues: number; tests: number; noProgress: number; rounds: number }
export interface Capabilities { framework: string; mainModel: string; modelRouting: 'per_agent' | 'per_run'; models: string[] }
export interface Finding { id: string; description: string; evidence: string; confidence?: number; confirmed?: boolean; advisory?: boolean }
export interface TicketPlan {
  number: number; kind: 'software' | 'human'; dependencies: number[]; criteria: string[];
  visual: boolean;
  /** 由原生依赖读取，不由用户配置。 */
  externalDependencies?: string[];
  /** 仅验收归属转移；两端记录都必须存在，技术前置不能移。 */
  deferredDependencies?: { issue: number; target: number; kind: 'acceptance_only'; records: string[] }[];
}
export interface ExecutionPlan { capabilities: Capabilities; policy: Policy; tickets: TicketPlan[]; specCriteria: string[]; evidencePath: string }
export type Phase = 'claim' | 'plan' | 'plan_check' | 'implement' | 'self' | 'verify' | 'publish' | 'review' | 'fresh' | 'accept' | 'integrate' | 'replan' | 'merge' | 'close' | 'cleanup' | 'done' | 'human' | 'blocked';
export type Action = 'claim' | 'plan' | 'plan-check' | 'implement' | 'self-standards' | 'self-spec' | 'verify' | 'publish' | 'review-lens' | 'confirm' | 'review-report' | 'accept' | 'integrate' | 'replan' | 'merge' | 'close' | 'cleanup' | 'spec-audit' | 'spec-close';
export interface Evidence { head: string; base: string; path: string }
export interface Ticket extends TicketPlan {
  key: string; phase: Phase; epoch: number; round: number; stalls: number; escalations: number;
  head: string; base: string; pr: number; branch: string; worktree: string;
  planPath: string; checksPath: string; handoffPath: string; reviewHandoff: string;
  evidence: Partial<Record<'self' | 'tests' | 'regular' | 'fresh' | 'accept' | 'visual', Evidence>>;
  lastProblem: string; reason: string; closeout: boolean;
  cleaned: boolean;
}
export interface LivePR { number: number; head: string; base: string; baseRef: string; state: string; draft: boolean; mergeable: string; checks: {id: string; status: string}[] }
export interface LiveFacts { base: string; issueStates: Record<string, string>; prs: Record<string, LivePR>; at: string }
export interface Result {
  /** 宿主实际选择的模型；command/main 工作用已绑定的主控模型。 */
  model: string;
  /** 动作完整执行才为 true；完整执行的验证失败仍可为 true，跳过/未完成为 false。 */
  complete: boolean;
  status: string;
  head?: string; base?: string; evidencePath: string; handoffPath?: string;
  findings?: Finding[];
  /** 各动作字段见 roles.md；不是用户的启动参数。 */
  data?: Record<string, Json>;
}
export interface Job {
  id: string; ticket: string; epoch: number; action: Action; part: string;
  tier: Tier; model: string; executor: 'agent' | 'main' | 'command'; fresh: boolean; contextKey: string;
  head: string; base: string; tests: number; status: 'leased' | 'running' | 'done' | 'cancelled';
  nativeId: string; result?: Result; finding?: Finding;
}
export interface State {
  schema: 1; id: string; revision: number; inputs: Inputs; spec: number;
  repo: { root: string; slug: string; host: string; defaultBranch: string };
  status: 'planning' | 'running' | 'waiting_human' | 'blocked' | 'complete' | 'paused';
  policy?: Policy; capabilities?: Capabilities; specCriteria: string[]; planEvidence: string;
  tickets: Ticket[]; jobs: Job[]; facts: LiveFacts; auditEpoch: number; specAudit?: Result;
  events: { revision: number; message: string }[];
}
export const lenses = ['规范', '明显缺陷', 'Git 历史', '历史 PR 评论', '代码注释'];
export function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function event(s: State, message: string) { s.revision++; s.events.push({ revision: s.revision, message }); }
export function freshEvidence(t: Ticket, key: keyof Ticket['evidence']) {
  const e = t.evidence[key]; return !!e && e.head === t.head && e.base === t.base && !!e.path;
}
export function ticket(s: State, key: string) { const t = s.tickets.find(t => t.key === key); ensure(t, `未知工单 ${key}`); return t; }
const busy = (j: Job) => j.status === 'leased' || j.status === 'running';
const tierFor = (a: Action): Tier => ['claim', 'plan', 'plan-check', 'replan', 'spec-audit', 'spec-close', 'verify', 'cleanup'].includes(a) ? 'L1' : ['implement', 'self-standards', 'self-spec', 'publish'].includes(a) ? 'L3' : 'L2';
const hasTests = (a: Action) => ['implement', 'verify', 'confirm', 'integrate'].includes(a) ? 1 : 0;
export function buildTicket(p: TicketPlan, base: string, closeout = false): Ticket {
  return { ...p, key: closeout ? `spec-final-${p.number}` : String(p.number), phase: p.kind === 'human' ? 'human' : 'claim',
    epoch: 1, round: 0, stalls: 0, escalations: 0, head: '', base, pr: 0, branch: '', worktree: '',
    planPath: '', checksPath: '', handoffPath: '', reviewHandoff: '', evidence: {}, lastProblem: '', reason: '', closeout, cleaned: false };
}
export function applyPlan(s: State, p: ExecutionPlan, discovered: { number: number; state: string; blockedBy: { repo: string; number: number; state: string }[] }[]) {
  ensure(s.status === 'planning', '本轮执行计划已经确认；修改计划需先停止受影响任务');
  ensure(p.capabilities.mainModel === s.inputs.models.L1, '主 agent 实际模型必须与 L1 相同，不能用角色名称代替');
  ensure(['per_agent', 'per_run'].includes(p.capabilities.modelRouting), '宿主缺少明确的模型路由能力');
  for (const m of Object.values(s.inputs.models)) ensure(p.capabilities.models.includes(m), `宿主未确认模型可用：${m}`);
  for (const k of ['agents', 'issues', 'tests', 'noProgress', 'rounds'] as const) ensure(Number.isSafeInteger(p.policy[k]) && p.policy[k] > 0, `L1 的资源策略 ${k} 必须是正整数`);
  ensure(p.policy.agents >= 2, '至少留出主 agent 和一个子 agent 的额度');
  ensure(p.specCriteria.length && p.evidencePath, '需要 L1 的 spec 执行计划和验收条件');
  ensure(new Set(p.tickets.map(t => t.number)).size === p.tickets.length, '工单编号重复');
  for (const i of discovered) ensure(p.tickets.some(t => t.number === i.number), `执行计划遗漏既有子工单 #${i.number}`);
  for (const t of p.tickets) {
    const source = discovered.find(i => i.number === t.number); ensure(source, `#${t.number} 不是现有 sub-issue，工作流不负责拆票`);
    t.externalDependencies = source.blockedBy.filter(b => b.repo !== s.repo.slug && b.state !== 'CLOSED').map(b => `${b.repo}#${b.number}`);
    ensure(t.criteria.length > 0, `#${t.number} 缺少验收条件`);
    for (const d of t.deferredDependencies || []) {
      ensure(d.kind === 'acceptance_only' && d.records.length >= 2, '延期人工验收必须保留两端已发布的追溯记录');
      ensure(d.target === s.spec || p.tickets.some(i => i.number === d.target && i.kind === 'human'), '人工验收只能移交现有人工工单或父 spec');
    }
    for (const b of source.blockedBy) {
      if (b.state === 'CLOSED') continue;
      const deferred = (t.deferredDependencies || []).some(d => d.issue === b.number && b.repo === s.repo.slug);
      ensure(b.repo !== s.repo.slug || t.dependencies.includes(b.number) || deferred, `遗漏原生 blocked 关系：#${t.number} ← #${b.number}`);
    }
  }
  const visit = (n: number, path: number[]) => {
    ensure(!path.includes(n), `依赖成环：${[...path, n].join(' → ')}`);
    const t = p.tickets.find(t => t.number === n);
    if (t) for (const d of t.dependencies) visit(d, [...path, n]);
  };
  for (const t of p.tickets) visit(t.number, []);
  s.policy = p.policy; s.capabilities = p.capabilities; s.specCriteria = p.specCriteria; s.planEvidence = p.evidencePath;
  s.tickets = p.tickets.map(t => {
    const item = buildTicket(t, s.facts.base);
    if (discovered.find(i => i.number === t.number)?.state === 'CLOSED') item.phase = 'done';
    return item;
  });
  s.status = 'running'; event(s, 'L1 确认 spec 执行图与资源预算；开始按 blocked 关系调度');
}
function jobsAt(s: State, t: Ticket, action: Action) { return s.jobs.filter(j => j.ticket === t.key && j.epoch === t.epoch && j.action === action && j.status !== 'cancelled'); }
function dependencyReady(s: State, t: Ticket) {
  return t.dependencies.every(n => s.tickets.find(x => x.number === n)?.phase === 'done' || s.facts.issueStates[String(n)] === 'CLOSED') &&
    (t.externalDependencies || []).every(key => s.facts.issueStates[key] === 'CLOSED');
}
function resetCandidate(t: Ticket, head: string, base: string, phase: Phase) {
  t.head = head; t.base = base; t.evidence = {}; t.epoch++; t.phase = phase;
}
function problem(s: State, t: Ticket, signature: string, next: Phase) {
  t.round++; t.stalls = signature === t.lastProblem ? t.stalls + 1 : 0; t.lastProblem = signature;
  ensure(s.policy, '缺少策略');
  if (t.round >= s.policy.rounds || t.stalls >= s.policy.noProgress) {
    t.phase = t.escalations ? 'blocked' : 'replan'; t.reason = signature;
  } else t.phase = next;
  t.epoch++; t.evidence = {};
}
export function ciAllowed(pr: LivePR, r?: Result) {
  const checks = pr.checks;
  if (checks.some(c => c.status === 'failed')) return false;
  if (checks.length && checks.every(c => c.status === 'pass')) return true;
  const waiver = r?.data?.ciWaiver as { reason?: string; evidence?: string; notStartedIds?: string[] } | undefined;
  if (!waiver?.evidence) return false;
  if (waiver.reason === 'no_ci') return checks.length === 0 && r?.data?.ciConfigured === false;
  if (waiver.reason === 'billing') return checks.every(c => c.status === 'pass' ||
    (c.status === 'startup_failure' && waiver.notStartedIds?.includes(c.id)));
  return false;
}
export function mergeGate(s: State, t: Ticket) {
  const live = s.facts.prs[String(t.pr)];
  return !!live && live.state === 'OPEN' && !live.draft && live.head === t.head && live.base === t.base &&
    live.baseRef === s.inputs.targetBranch && s.facts.base === t.base && live.mergeable === 'MERGEABLE' &&
    ['self', 'tests', 'regular', 'fresh', 'accept'].every(k => freshEvidence(t, k as keyof Ticket['evidence'])) &&
    (!t.visual || freshEvidence(t, 'visual')) && ciAllowed(live, jobsAt(s, t, 'accept').find(j => j.status === 'done')?.result);
}
function advanceGroups(s: State, t: Ticket) {
  if (t.phase === 'self') {
    const a = jobsAt(s, t, 'self-standards'), b = jobsAt(s, t, 'self-spec');
    if (a[0]?.status === 'done' && b[0]?.status === 'done') {
      const findings = [...(a[0].result?.findings || []), ...(b[0].result?.findings || [])].filter(f => !f.advisory);
      if (findings.length) problem(s, t, findings.map(f => f.description).sort().join('|'), 'implement');
      else { t.evidence.self = { head: t.head, base: t.base, path: [a[0].result!.evidencePath, b[0].result!.evidencePath].join('\n') }; t.phase = 'verify'; }
    }
  }
}
interface Candidate { t?: Ticket; action: Action; part?: string; finding?: Finding }
function candidates(s: State): Candidate[] {
  const out: Candidate[] = [];
  for (const t of s.tickets) {
    advanceGroups(s, t);
    if (['done', 'human', 'blocked'].includes(t.phase)) continue;
    if (t.phase === 'claim' && !dependencyReady(s, t)) continue;
    if (t.phase === 'self') { out.push({ t, action: 'self-standards' }, { t, action: 'self-spec' }); continue; }
    if (t.phase === 'review' || t.phase === 'fresh') {
      const rs = jobsAt(s, t, 'review-lens');
      if (rs.filter(j => j.status === 'done').length !== lenses.length) {
        lenses.forEach((_, n) => out.push({ t, action: 'review-lens', part: String(n) })); continue;
      }
      const fs = rs.flatMap(j => (j.result!.findings || []).map((f, n) => ({ ...f, id: `${j.part}-${n}` })));
      const cs = jobsAt(s, t, 'confirm');
      if (cs.filter(j => j.status === 'done').length !== fs.length) {
        fs.forEach(f => out.push({ t, action: 'confirm', part: f.id, finding: f })); continue;
      }
      out.push({ t, action: 'review-report' }); continue;
    }
    if (t.phase === 'plan_check') { out.push({ t, action: 'plan-check' }); continue; }
    if (t.phase === 'merge' && !mergeGate(s, t)) continue;
    out.push({ t, action: t.phase as Action });
  }
  // 中途人工技术前置或外部依赖也可能使整张图暂无可运行节点。
  // 交给独立 L1 给出明确人工交接/阻断结论，不能空轮询或假定软件都完成。
  if (out.length === 0 && !s.jobs.some(busy)) {
    if (!s.specAudit) out.push({ action: 'spec-audit' });
    else if (s.specAudit.status === 'complete' && s.facts.issueStates[String(s.spec)] !== 'CLOSED') out.push({ action: 'spec-close' });
  }
  return out;
}
export function reserve(s: State): Job[] {
  ensure(s.status === 'running' && s.policy, '只有运行中的已规划 workflow 可以派发');
  const created: Job[] = [];
  const list = candidates(s);
  for (const c of list) {
    const key = c.t?.key || '$spec', epoch = c.t?.epoch || s.auditEpoch;
    const part = c.part || '';
    const attempts = s.jobs.filter(j => j.ticket === key && j.epoch === epoch && j.action === c.action && j.part === part);
    if (attempts.some(j => j.status !== 'cancelled')) continue;
    const id = `${s.id}:${key}:${epoch}:${c.action}:${part}:try-${attempts.length + 1}`;
    const active = s.jobs.filter(busy);
    const command = ['verify', 'cleanup'].includes(c.action);
    const executor = command ? 'command' : c.action === 'claim' ? 'main' : 'agent';
    if (active.filter(j => j.executor === 'agent').length + 1 + (executor === 'agent' ? 1 : 0) > s.policy.agents) continue;
    if (active.reduce((n, j) => n + j.tests, 0) + hasTests(c.action) > s.policy.tests) continue;
    const inFlightIssues = new Set(s.tickets.filter(t => !['claim', 'done', 'human', 'blocked'].includes(t.phase)).map(t => t.key));
    for (const j of active) if (j.action === 'claim') inFlightIssues.add(j.ticket);
    if (c.action === 'claim' && inFlightIssues.size >= s.policy.issues) continue;
    // 所有合并、关闭以及 spec 终结共用一个提交通道。
    if (['merge', 'close', 'spec-close'].includes(c.action) && active.some(j => ['merge', 'close', 'spec-close'].includes(j.action))) continue;
    const tier = tierFor(c.action);
    const fresh = c.t?.phase === 'fresh' || ['plan', 'plan-check', 'accept', 'replan', 'spec-audit'].includes(c.action);
    const continuity = ['implement', 'publish'].includes(c.action) ? 'author' : ['review-lens', 'confirm', 'review-report'].includes(c.action) ? `review-${part}` : c.action;
    const j: Job = { id, ticket: key, epoch, action: c.action, part, tier, model: s.inputs.models[tier], executor, fresh,
      contextKey: `${s.id}:${key}:${continuity}${fresh ? `:fresh-${epoch}` : ''}`, head: c.t?.head || '', base: c.t?.base || s.facts.base,
      tests: hasTests(c.action), status: 'leased', nativeId: '', finding: c.finding };
    s.jobs.push(j); created.push(j);
  }
  if (created.length) event(s, `已预留 ${created.length} 个任务，含所有显式审查 actors`);
  return created;
}
export function bind(s: State, id: string, ref: { nativeId: string; model: string }) {
  ensure(s.status === 'running', '当前 workflow 未运行，不能派发新任务');
  const j = s.jobs.find(j => j.id === id); ensure(j && busy(j), '任务不是待执行状态');
  ensure(ref.model === j.model && !!ref.nativeId, '实际派发模型或宿主任务身份不匹配');
  ensure(!j.nativeId || j.nativeId === ref.nativeId, '同一租约不能重复绑定另一任务');
  j.nativeId = ref.nativeId; j.status = 'running'; event(s, `已绑定 ${j.action} 的原生任务`);
}
export function submit(s: State, id: string, r: Result) {
  const paused = s.status === 'paused';
  const j = s.jobs.find(j => j.id === id); ensure(j, '未知任务');
  if (j.status === 'done') { ensure(JSON.stringify(j.result) === JSON.stringify(r), '重复回执内容不一致'); return; }
  ensure(busy(j) && j.nativeId, '先绑定实际任务，才能提交结果');
  ensure(r.model === j.model && !!r.evidencePath, '回执必须包含实际模型及证据路径');
  const allowed: Record<Action, string[]> = {
    claim: ['claimed'], plan: ['planned'], 'plan-check': ['pass', 'changes'], implement: ['implemented', 'replan'],
    'self-standards': ['reviewed'], 'self-spec': ['reviewed'], verify: ['pass', 'fail'], publish: ['published'],
    'review-lens': ['reviewed'], confirm: ['confirmed'], 'review-report': ['posted'],
    accept: ['ready', 'gap', 'conflict', 'waiting_ci', 'needs_human', 'blocked'], integrate: ['implemented', 'replan'],
    replan: ['planned'], merge: ['merged', 'waiting_merge'], close: ['closed'], cleanup: ['cleaned'],
    'spec-audit': ['complete', 'needs_closeout', 'waiting_human', 'blocked'], 'spec-close': ['closed'],
  };
  if (r.complete) ensure(allowed[j.action].includes(r.status), `${j.action} 不接受完成状态 ${r.status}；跳过不能算通过`);
  const t = j.ticket === '$spec' ? undefined : ticket(s, j.ticket);
  ensure(!t || t.epoch === j.epoch, '候选已经更新，回执失效');
  j.result = r; j.status = 'done';
  if (!r.complete) {
    if (t) { t.phase = 'blocked'; t.reason = `${j.action}: ${r.status}`; }
    else if (!paused) s.status = 'blocked';
    event(s, `${j.action} 未完整执行，不能视为通过`); return;
  }
  const live = t?.pr ? s.facts.prs[String(t.pr)] : undefined;
  if (t && !['claim', 'cleanup', 'close', 'merge', 'implement', 'integrate'].includes(j.action) &&
      (s.facts.base !== j.base || (['review-lens', 'confirm', 'review-report', 'accept'].includes(j.action) && live?.state === 'OPEN' && live.head !== j.head))) {
    t.phase = 'blocked'; t.reason = 'stale'; event(s, `${j.action} 完成时版本已变，不能保留通过结论`); return;
  }
  if (t && !['claim', 'plan', 'plan-check', 'replan', 'cleanup', 'close'].includes(j.action)) {
    ensure(r.base === j.base && !!r.head, '结果必须绑定派发时的 head/base');
    if (!['implement', 'integrate'].includes(j.action)) ensure(r.head === j.head, '只读阶段不能更换候选 SHA');
  }
  const data = r.data || {};
  const evidence = (): Evidence => ({ head: t!.head, base: t!.base, path: r.evidencePath });
  if (t && r.handoffPath) { if (j.action === 'review-report') t.reviewHandoff = r.handoffPath; else t.handoffPath = r.handoffPath; }
  switch (j.action) {
    case 'claim':
      ensure(t && data.branch && data.worktree, '认领必须先创建专属 branch/worktree');
      t.branch = String(data.branch); t.worktree = String(data.worktree); t.head = String(data.head || ''); t.phase = 'plan'; break;
    case 'plan':
      ensure(t && data.planPath && data.checksPath, 'L1 必须产出计划和验证清单');
      t.planPath = String(data.planPath); t.checksPath = String(data.checksPath); t.phase = 'plan_check'; break;
    case 'plan-check':
      ensure(t, '缺少工单');
      if (r.status === 'pass') { if (data.checksPath) t.checksPath = String(data.checksPath); t.phase = 'implement'; }
      else problem(s, t, String(data.reason || '计划尚未满足验收'), 'plan'); break;
    case 'implement': case 'integrate':
      ensure(t, '缺少工单');
      if (r.status === 'replan') { problem(s, t, String(data.reason || '实现边界改变'), 'replan'); break; }
      ensure(r.status === 'implemented' && r.handoffPath, '代码修改后必须交接，再进行作者自检');
      resetCandidate(t, r.head!, r.base!, 'self');
      if (data.visualEvidence) t.evidence.visual = { head: t.head, base: t.base, path: String(data.visualEvidence) }; break;
    case 'self-standards': case 'self-spec':
      ensure(t && Array.isArray(r.findings), '双轴自检必须分别返回完整 findings（允许空数组）'); advanceGroups(s, t); break;
    case 'verify':
      ensure(t, '缺少工单');
      if (r.status === 'pass') { t.evidence.tests = evidence(); t.phase = 'publish'; }
      else problem(s, t, String(data.failureSignature || r.status), 'implement'); break;
    case 'publish':
      ensure(t && freshEvidence(t, 'tests') && freshEvidence(t, 'self'), '发布前需要同候选的自检与测试');
      ensure(!t.visual || freshEvidence(t, 'visual'), '适用视觉检查缺失');
      ensure(Number(data.pr) > 0 && data.commentUrl, '需要 PR 以及作者完成评论');
      t.pr = Number(data.pr); t.phase = 'review'; t.epoch++; break;
    case 'review-lens': ensure(Array.isArray(r.findings), '每一路审查必须明确返回 findings'); break;
    case 'confirm':
      ensure(Array.isArray(r.findings) && r.findings.length === 1, '逐项独立核实必须返回一个问题');
      ensure(Number.isFinite(r.findings[0].confidence) && r.findings[0].confidence! >= 0 && r.findings[0].confidence! <= 100, '缺少 0–100 置信评分');
      ensure(r.findings[0].confidence! < 50 || r.findings[0].confirmed === true, '>=50 的问题必须被独立证据确认'); break;
    case 'review-report': {
      ensure(t && data.commentUrl && r.handoffPath, '审查必须留下完成评论和持久交接');
      const cs = jobsAt(s, t, 'confirm').flatMap(x => x.result?.findings || []);
      const blockers = cs.filter(f => f.confidence! >= 50);
      if (blockers.length) problem(s, t, blockers.map(f => f.description).sort().join('|'), 'implement');
      else if (t.phase === 'review') { t.evidence.regular = evidence(); t.phase = 'fresh'; t.epoch++; }
      else { ensure(t.phase === 'fresh', '非审查阶段'); t.evidence.fresh = evidence(); t.phase = 'accept'; }
      break;
    }
    case 'accept':
      ensure(t && freshEvidence(t, 'regular') && freshEvidence(t, 'fresh'), '验收前必须完成 regular 和 fresh 审查');
      if (r.status === 'ready') {
        ensure(Array.isArray(data.satisfiedCriteria) && t.criteria.every(c => (data.satisfiedCriteria as Json[]).includes(c)), 'issue 验收条件未全部满足');
        t.evidence.accept = evidence();
        if (live?.mergeable === 'CONFLICTING') problem(s, t, '目标分支存在冲突', 'integrate');
        else if (!live || !ciAllowed(live, r)) { t.phase = 'blocked'; t.reason = 'waiting_ci'; }
        else t.phase = 'merge';
      } else if (r.status === 'gap') {
        ensure(data.planPath, '验收缺口必须附 L2 补充计划'); t.planPath = String(data.planPath); problem(s, t, String(data.reason || '验收缺口'), 'plan_check');
      } else if (r.status === 'conflict') { problem(s, t, '需要集成目标分支', 'integrate'); }
      else if (r.status === 'waiting_ci') { t.phase = 'blocked'; t.reason = 'waiting_ci'; }
      else { t.phase = 'blocked'; t.reason = String(data.reason || r.status); }
      break;
    case 'replan':
      ensure(t && data.planPath && data.checksPath, '独立 L1 重规划需要计划与验证清单');
      t.planPath = String(data.planPath); t.checksPath = String(data.checksPath); t.escalations++; t.stalls = 0; t.round = 0;
      t.phase = 'plan_check'; t.epoch++; break;
    case 'merge':
      if (r.status === 'waiting_merge') { ensure(t, '缺少工单'); t.phase = 'blocked'; t.reason = 'waiting_merge'; break; }
      ensure(t && s.facts.prs[String(t.pr)]?.state === 'MERGED', '尚未观察到远端 PR MERGED');
      t.phase = t.closeout ? 'done' : 'close'; break;
    case 'close': ensure(t && s.facts.issueStates[String(t.number)] === 'CLOSED', '远端 issue 尚未关闭'); t.phase = 'cleanup'; break;
    case 'cleanup': ensure(t && s.facts.issueStates[String(t.number)] === 'CLOSED' && s.facts.prs[String(t.pr)]?.state === 'MERGED', '清理必须同时满足 MERGED + CLOSED'); t.cleaned = true; t.phase = 'done'; break;
    case 'spec-audit':
      ensure(r.base === s.facts.base, 'spec 验收必须覆盖当前目标分支'); s.specAudit = r;
      if (r.status === 'needs_closeout') {
        ensure(s.tickets.every(t => t.phase === 'done' || t.phase === 'human'), '仍有未完成的自动工单，不能用收尾 PR 绕过依赖');
        if (s.tickets.filter(t => t.closeout).length >= s.policy!.rounds) { s.status = 'blocked'; event(s, 'Spec 收尾达到 L1 设定的轮次上限，需要重新判断未收敛原因'); break; }
        ensure(data.planPath && Array.isArray(data.remainingCriteria), '收尾需要现有 spec 内的明确缺口');
        const task = buildTicket({ number: s.spec, kind: 'software', dependencies: [], criteria: data.remainingCriteria.map(String), visual: data.visual === true }, s.facts.base, true);
        task.key = `spec-final-${s.auditEpoch}`; task.planPath = String(data.planPath); s.tickets.push(task); s.specAudit = undefined; s.auditEpoch++;
      } else if (r.status === 'waiting_human') { ensure(data.humanHandoffUrl, '人工阶段需要现有 issue/spec 上的交接记录'); s.status = 'waiting_human'; }
      else if (r.status !== 'complete') s.status = 'blocked';
      else {
        ensure(s.tickets.every(t => t.phase === 'done'), '仍有未完成工单时不能关闭 spec');
        ensure(!s.tickets.some(t => t.phase === 'human' && s.facts.issueStates[String(t.number)] !== 'CLOSED'), '未完成人工工单时不能关闭 spec');
        ensure(Array.isArray(data.satisfiedCriteria) && s.specCriteria.every(c => (data.satisfiedCriteria as Json[]).includes(c)), 'spec 条件必须全部满足，包括迁移到父 spec 的人工条件');
      }
      break;
    case 'spec-close':
      ensure(s.specAudit?.status === 'complete' && s.specAudit.base === s.facts.base && j.base === s.facts.base, 'spec 验收已过期，需要新 L1 重新验收');
      ensure(s.facts.issueStates[String(s.spec)] === 'CLOSED', 'spec 尚未关闭'); s.status = 'complete';
      for (const x of s.tickets) if (x.closeout && x.worktree && !x.cleaned) { x.phase = 'cleanup'; s.status = 'running'; } break;
  }
  if (paused) s.status = 'paused';
  event(s, `${j.ticket} · ${j.action} → ${r.status}`);
}

/** 外部状态变化时撤销旧结论。仍在运行的任务必须先由宿主确认停止，不能擅自释放写锁。 */
export function reconcileFacts(s: State, facts: LiveFacts) {
  s.facts = facts;
  if (s.specAudit && s.specAudit.base !== facts.base) { s.specAudit = undefined; s.auditEpoch++; }
  for (const t of s.tickets) {
    if (t.phase === 'human' && facts.issueStates[String(t.number)] === 'CLOSED') t.phase = 'done';
    if (['done', 'human', 'cleanup', 'close'].includes(t.phase) || s.jobs.some(j => j.ticket === t.key && busy(j))) continue;
    const p = facts.prs[String(t.pr)];
    if (p?.state === 'MERGED') {
      const intended = s.jobs.some(j => j.ticket === t.key && j.action === 'merge' && j.head === p.head && j.nativeId);
      if (!intended || p.head !== t.head || p.baseRef !== s.inputs.targetBranch || !freshEvidence(t, 'accept')) {
        t.phase = 'blocked'; t.reason = 'PR 被外部合并或合入另一分支，需要核对验收；保留资源'; continue;
      }
      t.phase = t.closeout ? 'done' : facts.issueStates[String(t.number)] === 'CLOSED' ? 'cleanup' : 'close'; continue;
    }
    if (p?.state === 'CLOSED') { t.phase = 'blocked'; t.reason = 'PR 已关闭但未合并，保留资源'; continue; }
    if (p && p.head !== t.head && (['review', 'fresh', 'accept', 'merge'].includes(t.phase) || t.reason === 'stale')) {
      resetCandidate(t, p.head, facts.base, 'integrate'); t.reason = '已发布候选被外部更新；先同步再验证';
    }
    else if (t.base !== facts.base) { resetCandidate(t, t.head, facts.base, t.worktree ? 'integrate' : 'claim'); t.reason = '目标分支已前进'; }
    if (t.phase === 'blocked' && t.reason === 'waiting_ci' && p && ciAllowed(p)) { t.phase = 'accept'; t.epoch++; }
    if (t.phase === 'merge' && p?.mergeable === 'CONFLICTING') resetCandidate(t, t.head, facts.base, 'integrate');
  }
  if (s.status === 'blocked' && s.tickets.some(t => !['done', 'human', 'blocked'].includes(t.phase))) {
    s.status = 'running';
    if (s.specAudit && s.specAudit.status !== 'complete') { s.specAudit = undefined; s.auditEpoch++; }
  }
  if (s.specAudit?.status === 'complete' && facts.issueStates[String(s.spec)] === 'CLOSED') {
    for (const t of s.tickets) if (t.closeout && t.worktree && !t.cleaned && t.phase === 'done') {
      t.phase = 'cleanup'; if (s.status !== 'paused') s.status = 'running';
    }
  }
  if (s.status === 'running' && s.specAudit?.status === 'complete' && facts.issueStates[String(s.spec)] === 'CLOSED' && s.tickets.every(t => t.phase === 'done')) s.status = 'complete';
}
