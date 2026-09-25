/**
 * spec-delivery — 通用 TypeScript workflow，供当前仓库中的 L1 主 agent 驱动。
 * 用户输入仅 spec、targetBranch、models.L1/L2/L3。
 * 参考 dynamic-workflows 的显式 actors、类型化结果、有界循环与证据门禁。
 * 这是 portable host 协议入口，不是 ZCode 原生 facade 脚本；zcode 命令生成原生批次。
 * 用法与框架适配：./spec-delivery/README.md；角色约束：./spec-delivery/roles.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as engine from './spec-delivery/core.ts';
import * as gh from './spec-delivery/github.ts';
import { normalizeResult, resultPaths, metrics } from './spec-delivery/host.ts';
import { summarize } from './spec-delivery/summary.ts';
export * from './spec-delivery/core.ts';

const home = path.dirname(fileURLToPath(import.meta.url));
export const workflowVersion = '0.2.0';
const rolesPath = path.join(home, 'spec-delivery', 'roles.md');
const active = (j: engine.Job) => j.status === 'leased' || j.status === 'running';
const sha = (x: string) => createHash('sha256').update(x).digest('hex');
function read<T>(file: string): T { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function command(root: string, exe: string, argv: string[]) {
  return execFileSync(exe, argv, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function git(root: string, ...argv: string[]) { return command(root, 'git', argv); }
function safeFile(file: string) { engine.ensure(file && fs.statSync(file).isFile(), `工件不存在：${file}`); return file; }
function localHead(t: engine.Ticket) { return git(t.worktree, 'rev-parse', 'HEAD'); }
function clean(t: engine.Ticket) { return git(t.worktree, 'status', '--porcelain') === ''; }
function allowCompletion(s: engine.State) { engine.ensure(s.status !== 'retired', '已退役运行不能接收执行结果'); }
function requireProtocol(s: engine.State) {
  engine.ensure(s.protocol === 2, '旧版运行须先核对并停止在途任务，再执行 upgrade；inspect/metrics/summary 可直接读取');
  engine.ensure(s.status !== 'retired', '运行已退役；只允许 inspect/metrics/summary，保留账本和资源');
}
function lock(file: string) {
  const dir = file + '.lock';
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { fs.mkdirSync(dir); break; }
    catch (error) {
      engine.ensure((error as NodeJS.ErrnoException).code === 'EEXIST', String(error));
      try {
        const owner = read<{pid:number;host:string}>(path.join(dir,'owner.json'));
        engine.ensure(owner.host === os.hostname(), '状态锁位于另一机器；需要先核对持有者');
        try { process.kill(owner.pid,0); }
        catch (e) { if ((e as NodeJS.ErrnoException).code==='ESRCH') {
          // 多个 actor 同时发现死锁时，恢复者串行重读 owner，避免删除别人刚获得的新锁。
          const recovery = dir + '.recovery';
          let elected = false;
          try { fs.mkdirSync(recovery); elected = true; }
          catch (r) { if ((r as NodeJS.ErrnoException).code !== 'EEXIST') throw r; }
          if (elected) {
            try {
              write(path.join(recovery, 'owner.json'), {pid:process.pid,host:os.hostname()});
              const current = read<{pid:number;host:string}>(path.join(dir,'owner.json'));
              if (current.host === os.hostname() && !processAlive(current.pid)) fs.rmSync(dir,{recursive:true,force:true});
            } catch (r) { if ((r as NodeJS.ErrnoException).code !== 'ENOENT') throw r; }
            finally { fs.rmSync(recovery,{recursive:true,force:true}); }
          }
        } }
      } catch (e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
      engine.ensure(Date.now()<deadline, '状态锁等待超时；保留结果，稍后 collect，不重跑 actor');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
    }
  }
  write(path.join(dir, 'owner.json'), { pid: process.pid, host: os.hostname() });
  return () => fs.rmSync(dir, { recursive: true });
}
function save(file: string, s: engine.State) {
  // 先保存完整历史，再原子替换当前状态；重复提交不会覆盖历史证据。
  write(path.join(path.dirname(file), 'history', `${String(s.revision).padStart(6, '0')}-${randomUUID()}.json`), s);
  write(file, s);
}
function archiveResult(statePath:string,j:engine.Job) {
  const file=resultPaths(statePath,j.id).result;
  if(j.result && !fs.existsSync(file))write(file,j.result);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * schema:1 账本的形状门禁：只放行 summarize 实际读取且类型正确的字段，
 * 避免对合法 JSON 但形状损坏（截断、改写）的账本输出编造的摘要。
 * 类型不符一律抛出，由统一入口转成非零退出；不做逐字段枚举式的完整校验。
 */
function ensureSummaryShape(raw: Record<string, unknown>): engine.State {
  const bad = (detail: string): never => { throw new Error(`状态文件结构不符合 schema 1：${detail}`); };
  if (typeof raw.spec !== 'number') bad('spec 必须是数字');
  if (typeof raw.status !== 'string' || !raw.status) bad('status 必须是非空字符串');
  if (!isRecord(raw.inputs) || typeof raw.inputs.targetBranch !== 'string') bad('inputs.targetBranch 必须是字符串');
  if (!Array.isArray(raw.tickets)) bad('tickets 必须是数组');
  for (const t of raw.tickets) if (!isRecord(t) || typeof t.phase !== 'string') bad('tickets 的元素必须是带字符串 phase 的对象');
  if (!Array.isArray(raw.jobs)) bad('jobs 必须是数组');
  for (const j of raw.jobs) if (!isRecord(j) || typeof j.status !== 'string') bad('jobs 的元素必须是带字符串 status 的对象');
  if (raw.validationOwner !== undefined && raw.validationOwner !== null && typeof raw.validationOwner !== 'string') bad('validationOwner 必须是字符串');
  return raw as unknown as engine.State;
}
/**
 * 离线只读投影：先按真实故障分类核对路径与可读性，再读文件、解析、校验 schema 与形状，最后复用纯函数 summarize。
 * 不取锁、不调用 gh/git、不写状态或 history，也不参与锁恢复；失败一律抛出由统一入口转成非零退出。
 * 故障文案按事实区分：路径不存在（ENOENT/ENOTDIR/ELOOP，含悬空符号链接）、不是普通文件（目录等）、
 * 不可读（EACCES/EPERM/EIO 等，statSync 与 readFileSync 都附原始 errno，父目录不可搜索时不误报为不存在）、
 * 内容不是合法 JSON、结构不符合 schema 1，不让可读性或形状故障被误报成 JSON 语法问题。
 */
function summarizeLedger(statePath: string) {
  let stats: fs.Stats;
  try { stats = fs.statSync(statePath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') throw new Error(`状态文件不存在：${statePath}`);
    throw new Error(`状态文件不可读：${statePath}；${(error as Error).message}`);
  }
  engine.ensure(stats.isFile(), `状态文件不是普通文件：${statePath}`);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`状态文件不是合法 JSON：${(error as Error).message}`);
    throw new Error(`状态文件不可读：${statePath}；${(error as Error).message}`);
  }
  engine.ensure(isRecord(raw) && raw.schema === 1, '不支持的状态版本');
  return summarize(ensureSummaryShape(raw as Record<string, unknown>));
}
export function observe(s: engine.State, jobs?: engine.Job[]): engine.LiveFacts {
  const before = { ...gh.observationMetrics };
  const numbers = [...new Set([s.spec, ...s.tickets.map(t => t.number), ...s.tickets.flatMap(t => t.dependencies)])];
  const selected = s.tickets.filter(t => t.pr && (t.phase !== 'done' || jobs?.some(j => j.ticket === t.key || j.ticket === '$spec')));
  const fresh = gh.snapshot(s.repo, s.inputs.targetBranch, numbers, selected.map(t => t.pr));
  const prs: Record<string, engine.LivePR> = { ...s.facts.prs };
  for (const [n, p] of Object.entries(fresh.prs)) {
    const old = s.facts.prs[n];
    prs[n] = { ...p, checks: old?.head === p.head && old.base === p.base ? old.checks : [] };
  }
  const ci = selected.filter(t => jobs
    ? jobs.some(j => (j.ticket === t.key && ['accept', 'merge', 'cleanup'].includes(j.action)) || j.ticket === '$spec')
    : ['accept', 'merge'].includes(t.phase) || t.reason === 'waiting_ci');
  for (const t of ci) prs[t.pr] = gh.pr(s.repo, t.pr);
  for (const key of new Set(s.tickets.flatMap(t => t.externalDependencies || []))) {
    const marker = key.lastIndexOf('#');
    fresh.issueStates[key] = gh.issue({ ...s.repo, slug: key.slice(0, marker) }, Number(key.slice(marker + 1))).state;
  }
  s.telemetry ??= { ghInvocations: 0, retries: 0, observationMs: 0 };
  s.telemetry.ghInvocations += gh.observationMetrics.ghInvocations - before.ghInvocations;
  s.telemetry.retries += gh.observationMetrics.retries - before.retries;
  s.telemetry.observationMs += gh.observationMetrics.elapsedMs - before.elapsedMs;
  return { ...fresh, prs, at: new Date().toISOString() };
}
function excludeRuntime(root: string) {
  const common = path.resolve(root, git(root, 'rev-parse', '--git-common-dir'));
  const file = path.join(common, 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const entry of ['/.agents/workflow-runs/', '/.agents/worktrees/']) if (!contents.split('\n').includes(entry)) contents += `\n${entry}\n`;
  fs.writeFileSync(file, contents);
}
export function initialize(inputs: engine.Inputs, cwd = process.cwd()) {
  engine.ensure(Object.keys(inputs).every(k => ['spec', 'targetBranch', 'models'].includes(k)), '用户只需 spec、targetBranch、L1/L2/L3 模型；不接收仓库或资源参数');
  engine.ensure(inputs.targetBranch?.trim() && inputs.models && Object.keys(inputs.models).length === 3, '需要目标分支与三档模型');
  for (const tier of ['L1', 'L2', 'L3'] as const) engine.ensure(inputs.models[tier]?.trim(), `缺少 ${tier} 的具体模型`);
  const repo = gh.detectRepo(cwd);
  const match = String(inputs.spec).match(/(?:^#?|\/issues\/)(\d+)\/?$/);
  engine.ensure(match, 'spec 必须是 issue 编号或当前仓库的 issue URL');
  const spec = Number(match[1]);
  if (String(inputs.spec).startsWith('https://')) {
    const u = new URL(String(inputs.spec));
    engine.ensure(u.hostname === repo.host && u.pathname === `/${repo.slug}/issues/${spec}`, 'spec URL 不属于当前目录识别的仓库');
  }
  git(repo.root, 'check-ref-format', '--branch', inputs.targetBranch);
  const file = path.join(repo.root, '.agents', 'workflow-runs', `spec-${spec}-${sha(inputs.targetBranch).slice(0, 8)}`, 'state.json');
  if (fs.existsSync(file)) {
    const prior = read<engine.State>(file);
    engine.ensure(prior.status!=='retired','该运行已明确退役，不能由 init 自动复活；保留账本和资源');
    engine.ensure(JSON.stringify(prior.inputs.models) === JSON.stringify(inputs.models), '已有运行使用其他模型；先核对/停止旧任务后再重新配置，避免重复派发');
    return { statePath: file, resumed: true, next: 'inspect 后实时 reconcile；不得重新认领已有任务' };
  }
  const parent = gh.issue(repo, spec), children = gh.subIssues(repo, spec);
  engine.ensure(parent.state === 'OPEN', '目标 spec 已关闭'); engine.ensure(children.length, '目标 spec 尚无可读取的既有 sub-issues');
  const base = gh.targetHead(repo, inputs.targetBranch);
  excludeRuntime(repo.root);
  const s: engine.State = { schema: 1, protocol: 2, id: randomUUID(), revision: 0, inputs, spec, repo, status: 'planning', tickets: [], jobs: [],
    specCriteria: [], planEvidence: '', auditEpoch: 1, events: [],
    facts: { base, issueStates: Object.fromEntries([parent, ...children].map(i => [String(i.number), i.state])), prs: {}, at: new Date().toISOString() } };
  engine.event(s, '读取当前仓库和既有 spec/sub-issues；等待 L1 主 agent 制定执行安排');
  fs.mkdirSync(path.dirname(file), { recursive: true }); const release = lock(file);
  try { engine.ensure(!fs.existsSync(file), '另一个主控已启动这个 spec'); save(file, s); } finally { release(); }
  const snapshot = path.join(path.dirname(file), 'initial-sources.json'); write(snapshot, { parent, children });
  return { statePath: file, sourcesPath: snapshot, rolesPath, next: 'L1 主 agent 读取来源、判断人工边界、选择资源预算，生成 ExecutionPlan 后调用 plan',
    resources: { cpus: os.availableParallelism(), freeMemoryBytes: os.freemem(), loadAverage: os.loadavg() } };
}
export function packet(s: engine.State, j: engine.Job, statePath: string) {
  const t = s.tickets.find(t => t.key === j.ticket);
  const out = path.join(path.dirname(statePath), 'jobs', sha(j.id).slice(0, 20));
  const authored = ['implement', 'publish', 'integrate', 'replan'].includes(j.action);
  const prior = s.jobs.filter(x => x.ticket === j.ticket && x.status === 'done' && x.result &&
    (j.action === 'review-report' ? x.epoch === j.epoch && ['review-lens', 'confirm', 'adjudicate'].includes(x.action)
      : !j.fresh && (authored || ['review-lens', 'confirm', 'review-report'].includes(x.action))))
    .map(x => { archiveResult(statePath,x); return { action: x.action, epoch: x.epoch, head: x.head, base: x.base, status: x.result!.status,
      resultPath: resultPaths(statePath,x.id).result }; });
  // 旧结果保持完整归档；每次派发只带当前轮的索引，完整历史按需读取。
  const relevant = prior.filter(x => x.epoch === j.epoch || x.head === j.head);
  const priorPath = path.join(out, 'prior-index.json');
  write(priorPath, prior);
  const objective = j.fresh && ['review-lens', 'confirm'].includes(j.action)
    ? { tests: t?.evidence.tests, visual: t?.evidence.visual } : t?.evidence || {};
  return { jobId: j.id, action: j.action, tier: j.tier, model: j.model, executor: j.executor, fresh: j.fresh, contextKey: j.contextKey,
    repo: s.repo, spec: s.spec, issue: t?.number || s.spec, targetBranch: s.inputs.targetBranch,
    branch: t?.branch || '', worktree: t?.worktree || '', pr: t?.pr || 0, expectedHead: j.head, expectedBase: j.base,
    criteria: t?.criteria || s.specCriteria, visualRequired: t?.visual || false, closeout: t?.closeout || false,
    blockingReason: j.fresh && ['review-lens','confirm'].includes(j.action) ? '' : t?.reason || t?.lastProblem || '',
    planPath: j.fresh && j.action !== 'plan-check' ? '' : t?.planPath || '', checksPath: t?.checksPath || '',
    handoffPath: j.fresh ? '' : authored ? t?.handoffPath || '' : t?.reviewHandoff || '',
    sourceUrl: `https://${s.repo.host}/${s.repo.slug}/issues/${t?.number || s.spec}`,
    objectiveEvidence: objective, prior: relevant.slice(-20), historyIndexPath: j.fresh && j.action !== 'review-report' ? '' : priorPath, finding: j.finding || null,
    dispute: j.dispute ? Object.fromEntries(Object.entries(j.dispute).map(([key, id]) => [key, resultPaths(statePath, id).result])) : null,
    remainingWork: j.ticket === '$spec' ? s.tickets.map(x => ({number:x.number,phase:x.phase,dependencies:x.dependencies,reason:x.reason})) : [],
    lens: j.action === 'review-lens' ? engine.lenses[Number(j.part)] : '',
    rolesPath, outputDirectory: out, resultPath: path.join(out, 'result.json'),
    resourceGrant: { agentSlots: j.executor === 'agent' ? 1 : 0, testBatches: j.tests, nestedAgents: false },
    note: '读角色约束与来源；仅执行本 job。main loop 和并行审查由内核调度，agent 不自行派隐藏子 agent。' };
}
function claimLease(s: engine.State, j: engine.Job, statePath: string) {
  if (j.action !== 'claim') return true;
  const t = engine.ticket(s, j.ticket);
  const dir = path.join(s.repo.root, '.agents', 'workflow-runs', '.issue-leases'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(t.number) + '.json');
  if (fs.existsSync(file)) return read<{ stateId: string }>(file).stateId === s.id;
  try { fs.writeFileSync(file, JSON.stringify({ stateId: s.id, statePath, issue: t.number }), { flag: 'wx' }); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
}
function validateResult(s: engine.State, j: engine.Job, r: engine.Result) {
  safeFile(r.evidencePath);
  if (r.handoffPath) safeFile(r.handoffPath);
  const t = s.tickets.find(t => t.key === j.ticket); if (!t || !r.complete) return;
  if (j.action === 'claim') {
    const data = r.data || {}, worktree = path.resolve(String(data.worktree || ''));
    const ownedRoot = path.join(s.repo.root, '.agents', 'worktrees') + path.sep;
    engine.ensure(worktree.startsWith(ownedRoot), '任务 worktree 必须在当前仓库 .agents/worktrees 下');
    engine.ensure(fs.realpathSync(worktree).startsWith(fs.realpathSync(path.join(s.repo.root, '.agents', 'worktrees')) + path.sep), '任务 worktree 不能是指向其他目录的符号链接');
    const branch = String(data.branch || '');
    engine.ensure(branch && ![s.inputs.targetBranch, s.repo.defaultBranch].includes(branch), '任务分支不能是目标或默认分支');
    engine.ensure(git(worktree, 'branch', '--show-current') === branch, 'worktree 分支与回执不符');
    engine.ensure(path.resolve(worktree, git(worktree, 'rev-parse', '--git-common-dir')) === path.resolve(s.repo.root, git(s.repo.root, 'rev-parse', '--git-common-dir')), 'worktree 不属于当前仓库');
    engine.ensure(git(worktree, 'rev-parse', 'HEAD') === data.head && data.head === j.base, '认领必须从任务预期的目标基线 SHA 创建');
    engine.ensure(data.claimCommentUrl, '需要 GitHub 上的认领追溯记录'); return;
  }
  if (['plan', 'replan'].includes(j.action)) { safeFile(String(r.data?.planPath || '')); safeFile(String(r.data?.checksPath || '')); }
  if (j.action === 'plan-check' && r.data?.checksPath) safeFile(String(r.data.checksPath));
  if (j.action === 'accept' && r.status === 'gap') safeFile(String(r.data?.planPath || ''));
  if (r.data?.visualEvidence) safeFile(String(r.data.visualEvidence));
  if (t.worktree && !['cleanup', 'merge', 'close'].includes(j.action)) {
    const actual = localHead(t);
    engine.ensure(actual === (r.head || j.head), '本地候选 SHA 与回执不一致');
    if (!['implement', 'integrate'].includes(j.action)) engine.ensure(actual === j.head, '只读 actor 更改了候选；需要重新走实现与验证');
    engine.ensure(clean(t), 'worktree 有未提交变化，不能签发候选证据');
  }
  if (j.action === 'publish') {
    const pr = gh.pr(s.repo, Number(r.data?.pr));
    engine.ensure(pr.state === 'OPEN' && !pr.draft && pr.head === r.head && pr.baseRef === s.inputs.targetBranch && pr.base === r.base, '远端 PR 不是预期的可审查候选');
    s.facts.prs[String(pr.number)] = pr;
  }
}
function verify(s: engine.State, j: engine.Job, statePath: string): engine.Result {
  const t = engine.ticket(s, j.ticket);
  engine.ensure(j.action === 'verify' && active(j), '该 job 不是验证任务');
  engine.ensure(localHead(t) === j.head && clean(t), '验证前候选必须匹配且干净');
  const manifestBytes = fs.readFileSync(t.checksPath, 'utf8');
  const manifest = JSON.parse(manifestBytes) as { scopeReason: string; commands: { name: string; argv: string[]; env?: Record<string, string>; timeoutSeconds: number }[] };
  engine.ensure(manifest.scopeReason && manifest.commands?.length, 'L1 验证清单缺少范围理由或真实命令');
  const directory = path.join(path.dirname(statePath), 'checks', sha(j.id).slice(0, 16)); fs.mkdirSync(directory, { recursive: true });
  const rows: unknown[] = []; let passed = true;
  for (const [n, c] of manifest.commands.entries()) {
    engine.ensure(Array.isArray(c.argv) && c.argv.length && c.argv.every(a => typeof a === 'string') && Number.isFinite(c.timeoutSeconds) && c.timeoutSeconds > 0, '验证命令需要 argv 数组和有限超时');
    const stdout = path.join(directory, `${n}.stdout.log`), stderr = path.join(directory, `${n}.stderr.log`);
    const a = fs.openSync(stdout, 'w'), b = fs.openSync(stderr, 'w');
    try {
      const r = spawnSync(c.argv[0], c.argv.slice(1), { cwd: t.worktree, env: { ...process.env, ...c.env }, shell: false,
        timeout: c.timeoutSeconds * 1000, stdio: ['ignore', a, b] });
      rows.push({ name: c.name, argv: c.argv, exitCode: r.status, signal: r.signal, error: r.error?.message, stdout, stderr });
      if (r.status !== 0 || r.error) { passed = false; break; }
    } finally { fs.closeSync(a); fs.closeSync(b); }
  }
  passed = passed && localHead(t) === j.head && clean(t) && fs.readFileSync(t.checksPath, 'utf8') === manifestBytes;
  const evidencePath = path.join(directory, 'receipt.json');
  write(evidencePath, { jobId: j.id, head: j.head, base: j.base, manifestSha256: sha(manifestBytes), scopeReason: manifest.scopeReason, passed, rows });
  return { model: j.model, complete: true, status: passed ? 'pass' : 'fail', head: j.head, base: j.base, evidencePath,
    data: { failureSignature: passed ? '' : sha(JSON.stringify(rows.map((x: any) => [x.name, x.exitCode, x.signal]))) } };
}
function cleanup(s: engine.State, j: engine.Job, statePath: string): engine.Result {
  const t = engine.ticket(s, j.ticket), pr = gh.pr(s.repo, t.pr), issue = gh.issue(s.repo, t.number);
  engine.ensure(pr.state === 'MERGED' && issue.state === 'CLOSED', 'PR MERGED 且关联 issue CLOSED 后才能清理');
  engine.ensure(pr.baseRef === s.inputs.targetBranch && pr.mergedHead, 'PR 必须合入所选目标分支');
  engine.ensure(!s.jobs.some(x => x.id !== j.id && x.ticket === j.ticket && active(x)), '仍有任务使用资源');
  engine.ensure(t.worktree.startsWith(path.join(s.repo.root, '.agents', 'worktrees') + path.sep), 'worktree 不在本 workflow 的资源范围内');
  engine.ensure(t.branch && ![s.inputs.targetBranch, s.repo.defaultBranch].includes(t.branch), '禁止清理目标/默认分支');
  engine.ensure(pr.headRef === t.branch, '资源登记分支与已合并 PR 的源分支不符');
  const wtExists = fs.existsSync(t.worktree);
  if (wtExists) engine.ensure(clean(t) && localHead(t) === pr.head, 'worktree 有未保存或未合并的提交，保留待处理');
  const refs = git(s.repo.root, 'for-each-ref', '--format=%(objectname)', `refs/heads/${t.branch}`);
  engine.ensure(!refs || refs === pr.head, '本地分支包含 PR 候选外的提交，保留');
  const remote = selectRemote(s);
  const target = gh.targetHead(s.repo, s.inputs.targetBranch);
  git(s.repo.root, 'fetch', '--no-tags', remote, s.inputs.targetBranch);
  git(s.repo.root, 'merge-base', '--is-ancestor', pr.mergedHead, target);
  engine.ensure(gh.targetHead(s.repo, s.inputs.targetBranch) === target, '清理检查期间目标分支变化，先重新核对');
  const remoteHead = git(s.repo.root, 'ls-remote', '--heads', remote, `refs/heads/${t.branch}`).split(/\s+/)[0];
  engine.ensure(!remoteHead || remoteHead === pr.head, '远程分支已被更新，保留未合并工作');
  // 带期望 SHA 删除远程 ref；若远程在检查后被改动，Git 拒绝删除。
  if (remoteHead) git(s.repo.root, 'push', `--force-with-lease=refs/heads/${t.branch}:${remoteHead}`, remote, `:refs/heads/${t.branch}`);
  if (wtExists) git(s.repo.root, 'worktree', 'remove', t.worktree);
  if (refs) git(s.repo.root, 'update-ref', '-d', `refs/heads/${t.branch}`, refs);
  const evidencePath = path.join(path.dirname(statePath), 'cleanup', sha(j.id).slice(0, 16) + '.json');
  write(evidencePath, { issue: t.number, pr: t.pr, branch: t.branch, worktree: t.worktree, head: pr.head, mergedCommit: pr.mergedHead, cleaned: true });
  const lease = path.join(s.repo.root, '.agents', 'workflow-runs', '.issue-leases', `${t.number}.json`);
  if (fs.existsSync(lease) && read<{stateId: string}>(lease).stateId === s.id) fs.unlinkSync(lease);
  return { model: j.model, complete: true, status: 'cleaned', evidencePath };
}
function claim(s: engine.State, j: engine.Job, statePath: string): engine.Result {
  const t=engine.ticket(s,j.ticket), directory=path.join(path.dirname(statePath),'actions');
  const intentPath=path.join(directory,sha(j.id).slice(0,20)+'.json');
  const intent={jobId:j.id,branch:`codex/spec-${s.spec}-${s.id.slice(0,8)}/${t.key}`,worktree:path.join(s.repo.root,'.agents','worktrees',`spec-${s.spec}-${sha(s.id+t.key).slice(0,12)}`),base:j.base};
  if(fs.existsSync(intentPath)) engine.ensure(JSON.stringify(read(intentPath))===JSON.stringify(intent),'认领意图已改变，保留现有资源');
  else write(intentPath,intent);
  const remote=selectRemote(s);
  git(s.repo.root,'fetch','--no-tags',remote,s.inputs.targetBranch);
  git(s.repo.root,'cat-file','-e',`${j.base}^{commit}`);
  fs.mkdirSync(path.dirname(intent.worktree),{recursive:true});
  if(!fs.existsSync(intent.worktree)) {
    const exists=git(s.repo.root,'for-each-ref','--format=%(objectname)',`refs/heads/${intent.branch}`);
    engine.ensure(!exists || exists===j.base,'已有分支包含未交付变更，不能重建');
    if(exists) git(s.repo.root,'worktree','add',intent.worktree,intent.branch);
    else git(s.repo.root,'worktree','add','-b',intent.branch,intent.worktree,j.base);
  }
  engine.ensure(git(intent.worktree,'rev-parse','HEAD')===j.base && git(intent.worktree,'branch','--show-current')===intent.branch && git(intent.worktree,'status','--porcelain')==='','认领资源与预期基线不符或有未保存工作');
  const marker=`<!-- spec-delivery:${s.id}:${t.key}:claim -->`;
  const existing=gh.issue(s.repo,t.number).comments.find(c=>c.body.includes(marker));
  let commentUrl=existing?.url;
  if(!commentUrl) {
    const bodyPath=path.join(directory,sha(j.id).slice(0,20)+'.md');
    fs.writeFileSync(bodyPath,`${marker}\n已认领此工单。\n\n- 分支：\`${intent.branch}\`\n- 基线：\`${j.base}\`\n- worktree：\`${intent.worktree}\`\n`);
    // 不重试写请求；若响应不确定，下次执行先通过 marker 对账。
    commentUrl=command(s.repo.root,'gh',['issue','comment',String(t.number),'--repo',`https://${s.repo.host}/${s.repo.slug}`,'--body-file',bodyPath]);
  }
  const evidencePath=path.join(directory,sha(j.id).slice(0,20)+'.receipt.json');
  write(evidencePath,{...intent,commentUrl});
  return {model:j.model,complete:true,status:'claimed',evidencePath,data:{branch:intent.branch,worktree:intent.worktree,head:j.base,claimCommentUrl:commentUrl}};
}
function closeIssue(s:engine.State,j:engine.Job,statePath:string):engine.Result {
  const t=s.tickets.find(t=>t.key===j.ticket), number=t?.number || s.spec;
  if(j.action==='spec-close') engine.ensure(s.specAudit?.status==='complete' && s.specAudit.base===s.facts.base && j.base===s.facts.base,'spec 验收已过期');
  else engine.ensure(t && s.facts.prs[t.pr]?.state==='MERGED' && s.facts.prs[t.pr].baseRef===s.inputs.targetBranch && engine.freshEvidence(t,'accept'),'工单未合并或缺少有效验收，不能关闭');
  if(s.facts.issueStates[number]!=='CLOSED') command(s.repo.root,'gh',['issue','close',String(number),'--repo',`https://${s.repo.host}/${s.repo.slug}`,'--reason','completed']);
  const issue=gh.issue(s.repo,number);engine.ensure(issue.state==='CLOSED','尚未观察到 issue 关闭');
  const evidencePath=path.join(path.dirname(statePath),'actions',sha(j.id).slice(0,20)+'.close.json');
  write(evidencePath,{jobId:j.id,issue:number,state:issue.state,base:s.facts.base,acceptance:t?.evidence.accept || s.specAudit});
  return {model:j.model,complete:true,status:'closed',base:j.base,evidencePath};
}
function commandReceipt(statePath:string,id:string) {return path.join(path.dirname(statePath),'commands',sha(id).slice(0,20)+'.json');}
function hasCommandReceipt(statePath:string,j:engine.Job) {
  const file=commandReceipt(statePath,j.id);
  return fs.existsSync(file) && !!read<{result?:engine.Result}>(file).result;
}
function canRecoverCommand(statePath:string,j:engine.Job) {return hasCommandReceipt(statePath,j) || j.commandRecovery?.nativeId===j.nativeId;}
function executeCommand(statePath: string, id: string) {
  let release = lock(statePath); let s: engine.State; let j: engine.Job;
  const receiptPath=commandReceipt(statePath,id);
  try {
    s = read<engine.State>(statePath); requireProtocol(s); engine.ensure(s.status === 'running', 'workflow 未运行；暂停后不能执行命令任务');
    const found = s.jobs.find(job => job.id === id);
    engine.ensure(found && (found.executor === 'command' || found.action === 'claim') && active(found), '任务不是可执行命令'); j = found;
    if(j.nativeId) {
      const pid=Number(j.nativeId.match(/^command:(\d+):/)?.[1]);
      engine.ensure(pid && !processAlive(pid), '原命令进程仍可能执行，不能重入');
      engine.ensure(canRecoverCommand(statePath,j),'无命令结果；先 reconcile 核对整个进程树及不确定外部动作，不能只凭父 PID 消失重跑');
      if(j.commandRecovery)safeFile(j.commandRecovery.evidencePath);
      j.nativeId=''; j.status='leased';
      delete j.commandRecovery;
    }
    s.facts = observe(s,[j]); engine.bind(s, j.id, { nativeId: `command:${process.pid}:${s.revision}`, model: j.model });
    save(statePath, s);
  } finally { release(); }
  // 测试/清理时只保留资源租约，不持有整个状态文件锁；其他独立工单可以继续。
  const startedAt=new Date().toISOString();
  const recorded=fs.existsSync(receiptPath) ? read<{result?:engine.Result}>(receiptPath).result : undefined;
  const r = recorded || (j.action === 'verify' ? verify(s, j, statePath) : j.action === 'claim' ? claim(s,j,statePath) : ['close','spec-close'].includes(j.action) ? closeIssue(s,j,statePath) : cleanup(s, j, statePath));
  if(!recorded) write(receiptPath,{jobId:j.id,startedAt,finishedAt:new Date().toISOString(),result:r});
  release = lock(statePath);
  try {
    const latest = read<engine.State>(statePath); latest.facts = observe(latest,[j]);
    if(j.action==='claim') validateResult(latest,j,r);
    engine.submit(latest, j.id, r); archiveResult(statePath,latest.jobs.find(x=>x.id===j.id)!); save(statePath, latest);
    return { statePath, status: latest.status, revision: latest.revision, result: r };
  } finally { release(); }
}
function processAlive(pid:number) {
  try { process.kill(pid,0); return true; }
  catch(e) { return (e as NodeJS.ErrnoException).code!=='ESRCH'; }
}
function selectRemote(s: engine.State) {
  const candidates = git(s.repo.root, 'remote').split('\n').filter(Boolean).filter(name => {
    const value = git(s.repo.root, 'remote', 'get-url', '--push', name).replace(/\.git$/, '');
    let host = '', slug = '';
    if (value.includes('://')) { const u = new URL(value); host = u.host; slug = u.pathname.replace(/^\//, ''); }
    else { const m = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/); if (m) { host = m[1]; slug = m[2]; } }
    return host.toLowerCase() === s.repo.host.toLowerCase() && slug.toLowerCase() === s.repo.slug.toLowerCase();
  });
  engine.ensure(candidates.length === 1, '没有唯一匹配当前仓库的 push remote；由 L1 核对 remote 后继续'); return candidates[0];
}
export function renderZcode(s: engine.State, statePath: string) {
  const jobs = s.jobs.filter(j => j.status === 'leased' && j.executor === 'agent');
  const result: unknown[] = [];
  for (const model of new Set(jobs.map(j => j.model))) {
    const allJobs = jobs.filter(j => j.model === model);
    for (let offset = 0; offset < allJobs.length; offset += 128) {
    const group = allJobs.slice(offset, offset + 128);
    const tasks = group.map(j => ({ id: j.id, name: `${j.ticket} ${j.action} ${j.part} ${j.epoch}`, packet: path.join(path.dirname(statePath), 'packets', sha(j.id).slice(0, 20) + '.json'), resultPath: resultPaths(statePath, j.id).result }));
    const entry = fileURLToPath(import.meta.url);
    const script = `// Generated from spec-delivery.workflow.ts. 每个运行只使用一个实际模型。
interface ActorAnswer {
  /** Result 内容的 JSON 字符串；无需 model/jobId，证据文件必须真实存在。 */ resultJson: string;
  /** 简短摘要。 */ summary: string;
}
const tasks = ${JSON.stringify(tasks, null, 2)};
phase("执行与逐项登记本批次任务");
const outcomes = await Promise.allSettled(tasks.map(async task => {
  const actor = agent(task.name, "按 packet 和 roles.md 执行限定任务。不要派子 agent 或嵌套 workflow。遵守测试配额。证据与交接必须实际落盘。");
  const answer = await actor.ask<ActorAnswer>(\`读取 \${task.packet}。执行 action，返回 Result JSON 内容及摘要，不必创建 result.json，不填写 model/jobId。证据与交接文件仍须真实写出。不要修改主控状态。\`);
  const receipt = await world.run("node", [${JSON.stringify(entry)}, "stage", ${JSON.stringify(statePath)}, task.id, answer.resultJson]);
  if (receipt.exitCode !== 0) throw new Error(receipt.stderr);
  report({jobId: task.id, resultPath: task.resultPath, summary: answer.summary.slice(0, 1000)});
  return {jobId:task.id,resultPath:task.resultPath,summary:answer.summary.slice(0,1000)};
}));
const reportText = outcomes.map(x => x.status === "fulfilled" ? x.value.summary.slice(0,400) : "任务未完整执行，需要主控核对").join("\\n\\n");
await artifact.markdown("batch-results", reportText, {title:"阶段任务结果", primary:true});
return {conclusion:reportText,findings:[],verified:[],notCovered:["原生身份由主控 bind-batch 登记；报告不能代替真实门禁"],outcomes:outcomes.map(x => x.status === "fulfilled" ? {status:"fulfilled",receipt:x.value} : {status:"rejected",reason:String(x.reason)})};
`;
    const draft = path.join(path.dirname(statePath), 'zcode', `batch-${sha(group.map(j => j.id).join('\n')).slice(0, 20)}.dwf.ts`);
    fs.mkdirSync(path.dirname(draft), { recursive: true }); fs.writeFileSync(draft, script);
    result.push({ loadSkill: 'dynamic-workflows', tool: 'CreateWorkflow', arguments: { name: 'Spec 开发阶段任务', path: draft, subagent_model: model, max_concurrency: group.length }, jobIds: group.map(j => j.id),
      binding: { model, jobs: tasks.map(t => ({jobId:t.id,actorName:t.name})) },
      note: '调用 CreateWorkflow 后立即把实际 runId 与 binding 交给 bind-batch。每个 actor 完成后由宿主 stage 登记，不等整批完成。此命令不启动 ZCode；不确定是否已启动时先查询原生 run，不能重复启动同一批。' });
    }
  }
  return result;
}
export function consumeStaged(statePath: string, ids?: string[]) {
  const release = lock(statePath);
  try {
    let s = read<engine.State>(statePath); allowCompletion(s);
    const jobs = s.jobs.filter(j => active(j) && j.nativeId && j.executor === 'agent' && (!ids || ids.includes(j.id)) && fs.existsSync(resultPaths(statePath, j.id).ready));
    if (!jobs.length) return { submitted: [], rejected: [] };
    s.facts = observe(s, jobs);
    const submitted: string[] = [], rejected: {jobId:string; error:string}[] = [];
    for (const j of jobs) {
      try {
        const r = normalizeResult(s, j, read(resultPaths(statePath, j.id).result));
        const trial = structuredClone(s), job = trial.jobs.find(x => x.id === j.id)!;
        engine.ensure(!job.testExecution,'测试进程未完成，不能提交任务');
        job.timing ??= {leasedAt:''}; job.timing.resultAt=read<{at:string}>(resultPaths(statePath,j.id).ready).at;
        validateResult(trial, job, r); engine.submit(trial, job.id, r); s = trial; submitted.push(j.id);
      } catch (error) { rejected.push({jobId:j.id,error:(error as Error).message}); }
    }
    save(statePath, s); return { submitted, rejected };
  } finally { release(); }
}
export function stageResult(statePath: string, id: string, value: unknown) {
  const release = lock(statePath);
  try {
    const s = read<engine.State>(statePath), j = s.jobs.find(j => j.id === id); allowCompletion(s);
    engine.ensure(j && j.executor === 'agent' && (active(j) || j.status === 'done'), '只能接收已登记的 agent 任务结果');
    const r = normalizeResult(s, j, value), files = resultPaths(statePath, id);
    if(j.status==='done') engine.ensure(JSON.stringify(j.result)===JSON.stringify(r),'已完成任务的回执不能改变');
    safeFile(r.evidencePath); if (r.handoffPath) safeFile(r.handoffPath);
    if (fs.existsSync(files.ready)) engine.ensure(JSON.stringify(read(files.result)) === JSON.stringify(r), '同一任务的结果不能被覆盖');
    else {
      write(files.result, r);
      write(files.ready, {jobId:id,at:new Date().toISOString(),resultPath:files.result});
    }
  } finally { release(); }
  return { jobId:id, resultPath:resultPaths(statePath,id).result, ...consumeStaged(statePath,[id]) };
}
export function bindBatch(statePath: string, binding: {runId:string; model:string; jobs:{jobId:string; actorName:string}[]}) {
  const release = lock(statePath);
  try {
    const s = read<engine.State>(statePath); allowCompletion(s);
    engine.ensure(binding.runId && binding.jobs.length && new Set(binding.jobs.map(j=>j.jobId)).size === binding.jobs.length, '需要真实 runId 与不重复的任务清单');
    for (const item of binding.jobs) {
      engine.ensure(item.actorName, '需要原生 actor 的稳定名称');
      const j = s.jobs.find(j=>j.id===item.jobId), nativeId=`${binding.runId}/${item.actorName}`;
      engine.ensure(j && j.executor==='agent' && j.model===binding.model, '批次实际模型与任务不符');
      if (j.status==='done') engine.ensure(j.nativeId===nativeId, '已完成任务的身份不能被替换');
      else engine.bind(s,j.id,{nativeId,model:binding.model});
    }
    save(statePath,s);
  } finally { release(); }
  return consumeStaged(statePath,binding.jobs.map(j=>j.jobId));
}
function runTest(statePath:string,id:string,request:{argv:string[];timeoutSeconds:number;env?:Record<string,string>;reason:string}) {
  engine.ensure(Array.isArray(request.argv) && request.argv.length && request.argv.every(x=>typeof x==='string') && request.argv[0] && Number.isFinite(request.timeoutSeconds) && request.timeoutSeconds>0 && request.reason,'测试需要 argv 数组、有限超时与核验目的');
  const executionId=randomUUID(), out=path.join(path.dirname(statePath),'experiments',`${sha(id).slice(0,16)}-${executionId}`);
  let release=lock(statePath); let worktree='', base=''; let audit:engine.State|undefined;
  try {
    const s=read<engine.State>(statePath), j=s.jobs.find(j=>j.id===id); requireProtocol(s);
    engine.ensure(s.status==='running' && j && j.executor==='agent' && active(j),'只能为在途 agent 任务申请测试');
    engine.ensure(!j.testExecution,'此任务已有测试进程或未对账的中断；先核对整个进程树，不自动回收配额');
    engine.ensure(j.tests || s.jobs.filter(active).reduce((n,x)=>n+x.tests,0)<s.policy!.tests,'测试配额暂不可用；等待测试完成后重试，不改用旁路执行');
    if(j.ticket==='$spec') {
      engine.ensure(j.action==='spec-audit','仅 spec 审计可申请最终组合测试');
      audit=s;worktree=path.join(s.repo.root,'.agents','worktrees',`spec-${s.spec}-audit-${executionId}`);
    } else worktree=engine.ticket(s,j.ticket).worktree;
    engine.ensure(worktree,'任务尚无 worktree');base=j.base;
    j.testExecution={pid:process.pid,granted:j.tests===0,startedAt:new Date().toISOString(),worktree,evidenceDirectory:out};j.tests=1;
    engine.event(s,`${j.ticket} 获得测试配额`);save(statePath,s);
  } finally {release();}
  let a:number|undefined,b:number|undefined;
  try {
    if(audit) {
      try {git(audit.repo.root,'cat-file','-e',`${base}^{commit}`);}
      catch {git(audit.repo.root,'fetch','--no-tags',selectRemote(audit),audit.inputs.targetBranch);}
      fs.mkdirSync(path.dirname(worktree),{recursive:true});git(audit.repo.root,'worktree','add','--detach',worktree,base);
    }
    const head=git(worktree,'rev-parse','HEAD');
    fs.mkdirSync(out,{recursive:true});a=fs.openSync(path.join(out,'stdout.log'),'w');b=fs.openSync(path.join(out,'stderr.log'),'w');
    const r=spawnSync(request.argv[0],request.argv.slice(1),{cwd:worktree,env:{...process.env,...request.env},timeout:request.timeoutSeconds*1000,stdio:['ignore',a,b],shell:false});
    const candidateStable=git(worktree,'rev-parse','HEAD')===head && (!audit || git(worktree,'status','--porcelain')==='');
    const receipt={jobId:id,request,worktree,head,base,candidateStable,exitCode:r.status,signal:r.signal,error:r.error?.message,stdout:path.join(out,'stdout.log'),stderr:path.join(out,'stderr.log'),finishedAt:new Date().toISOString()};
    write(path.join(out,'receipt.json'),receipt);return {...receipt,evidencePath:path.join(out,'receipt.json')};
  } finally {
    if(a!==undefined)fs.closeSync(a);if(b!==undefined)fs.closeSync(b);
    // 临时审计目录没有 PR/任务分支；有改动或清理失败时保留目录及日志，主控对账。
    if(audit && fs.existsSync(worktree))try {
      if(git(worktree,'rev-parse','HEAD')===base && git(worktree,'status','--porcelain')==='')git(audit.repo.root,'worktree','remove',worktree);
    } catch { /* 回执/测试租约中已记录目录，不能因清理问题覆盖首次测试结果。 */ }
    release=lock(statePath);
    try {const s=read<engine.State>(statePath),j=s.jobs.find(j=>j.id===id)!;
      if(j.testExecution?.pid===process.pid){if(j.testExecution.granted)j.tests=0;delete j.testExecution;engine.event(s,`${j.ticket} 测试进程结束`);save(statePath,s);}
    } finally {release();}
  }
}
export async function main(argv: string[]): Promise<unknown> {
  const [op, file, extra, fourth] = argv;
  if(op==='version')return {workflow:'spec-delivery',version:workflowVersion};
  if (!op || op === 'help') return { workflow: 'spec-delivery', input: ['spec', 'targetBranch', 'models.L1', 'models.L2', 'models.L3'],
    version:workflowVersion,readme: path.join(home, 'spec-delivery', 'README.md'), commands: ['version','summary <state.json>', 'init <input.json>', 'inspect <state>', 'plan <state> <plan.json>', 'drive <state>', 'next <state>', 'bind <state> <jobId> <binding.json>', 'bind-batch <state> <binding.json>', 'stage <state> <jobId> <result-json>', 'collect <state>', 'submit <state> <jobId> <result.json>', 'execute <state> <jobId>', 'test <state> <jobId> <request.json>', 'guard <state> <jobId>', 'reconcile <state> <host-status.json>', 'resolve <state> <decisions.json>', 'reconfigure <state> <models.json>', 'upgrade <state> <evidence.json>', 'retire <state> <reason.json>', 'record-host <state> <observations.json>', 'metrics <state>', 'resume <state>', 'zcode <state>'] };
  engine.ensure(file, '缺少输入文件/状态路径');
  // summary 在 lock() 之前返回：既不创建/等待/恢复/删除状态锁，也不进入任何写路径或协议门禁。
  if (op === 'summary') return summarizeLedger(path.resolve(file));
  if (op === 'init') return initialize(read<engine.Inputs>(file));
  if (op === 'execute') { engine.ensure(extra, '需要 command jobId'); return executeCommand(path.resolve(file), extra); }
  if (op === 'test') {engine.ensure(extra && fourth,'需要 jobId 与测试请求文件');return runTest(path.resolve(file),extra,read(fourth));}
  if (op === 'stage') {
    engine.ensure(extra && fourth, '需要 jobId 与结果 JSON 内容');
    const receipt=stageResult(path.resolve(file),extra,JSON.parse(fourth));
    engine.ensure(!receipt.rejected.length,`回执已保留但未通过核验：${JSON.stringify(receipt.rejected)}；主控核对，不重跑外部动作`);
    return receipt;
  }
  if (op === 'collect') return consumeStaged(path.resolve(file));
  if (op === 'bind-batch') { engine.ensure(extra, '需要宿主批次绑定文件'); return bindBatch(path.resolve(file),read(extra)); }
  if (op === 'drive') {
    requireProtocol(read<engine.State>(path.resolve(file)));
    const statePath=path.resolve(file), collected=consumeStaged(statePath), completed:string[]=[];
    const limit=Math.min(32,(read<engine.State>(statePath).policy?.agents || 1));
    for(let n=0;n<limit;n++) {
      const next=await main(['next',statePath]) as {jobs?:engine.Job[]};
      const current=read<engine.State>(statePath);
      const dead=(j:engine.Job)=>/^command:\d+:/.test(j.nativeId) && !processAlive(Number(j.nativeId.split(':')[1]));
      const j=current.jobs.find(j=>j.executor!=='agent' && active(j) && (!j.nativeId || (dead(j) && canRecoverCommand(statePath,j))));
      if(!j) return {...next,collected,completed,recoveryRequired:current.jobs.filter(j=>active(j) && j.executor!=='agent' && dead(j) && !canRecoverCommand(statePath,j)).map(j=>({jobId:j.id,nativeId:j.nativeId,reason:'无命令结果，需核对子进程及外部动作后 reconcile'}))};
      executeCommand(statePath,j.id); completed.push(j.id);
    }
    return {...await main(['next',statePath]) as object,collected,completed};
  }
  const statePath = path.resolve(file), release = lock(statePath);
  try {
    const s = read<engine.State>(statePath); engine.ensure(s.schema === 1, '不支持的状态版本');
    if (op === 'inspect') return { ...s, rolesPath };
    if (op === 'metrics') return metrics(s);
    engine.ensure(s.status !== 'retired', '已退役运行只允许 inspect/metrics/summary，不能自动复活');
    if (op === 'upgrade') {
      engine.ensure(extra && !s.jobs.some(active), '升级前先对账并确认所有在途任务已停止或完整提交');
      const proof=read<{evidencePath:string}>(extra);safeFile(proof.evidencePath);
      if(s.protocol===2)return {statePath,status:s.status,upgraded:false};
      // 老轮次的确认 ID 与分组方法不同，不混用部分 regular/fresh 通过结果。
      for(const t of s.tickets) if(['self','verify','publish','review','fresh','accept','merge','integrate'].includes(t.phase) || t.reason==='waiting_ci') {
        t.phase='queued';t.epoch++;t.evidence={};t.reason='旧运行已迁移；从队首重新验证候选';
      }
      for(const j of s.jobs) if(j.result) {
        const output=resultPaths(statePath,j.id).result;
        if(!fs.existsSync(output))write(output,j.result);
      }
      if(s.status!=='complete'){s.specAudit=undefined;s.auditEpoch++;}
      s.validationOwner=undefined;s.protocol=2;
      engine.event(s,`迁移为运行协议 2；保留全部原结果和已完成工单。对账依据：${proof.evidencePath}`);
      save(statePath,s);return {statePath,status:s.status,upgraded:true};
    }
    if(!['bind','submit','reconcile','retire'].includes(op))requireProtocol(s);
    if (op === 'zcode') return renderZcode(s, statePath);
    if (op === 'guard') {
      engine.ensure(s.status === 'running', 'workflow 未运行，禁止合并或关闭');
      const j = s.jobs.find(j => j.id === extra); engine.ensure(j && active(j), '需要在途 job'); s.facts = observe(s,[j]);
      if (j.action === 'spec-close') {
        engine.ensure(s.specAudit?.status === 'complete' && s.specAudit.base === s.facts.base && j.base === s.facts.base, 'spec 验收已过期，需要新的 L1 验收');
        return { allowed: true, base: s.facts.base, at: s.facts.at };
      }
      const t = engine.ticket(s, j.ticket);
      engine.ensure(j.action === 'merge' && engine.mergeGate(s, t), '最新的合并门禁不满足，禁止合并');
      return { allowed: true, head: t.head, base: t.base, at: s.facts.at, note: '立即使用预期 head 约束合并；远端保护仍生效，目标分支由主控串行调度' };
    }
    if (op === 'plan') {
      engine.ensure(extra, '需要 L1 自行生成的 plan.json');
      s.facts = observe(s); const sources = gh.subIssues(s.repo, s.spec);
      const p = read<engine.ExecutionPlan>(extra); safeFile(p.evidencePath); engine.applyPlan(s, p, sources);
    } else if (op === 'next') {
      engine.reconcileFacts(s, observe(s));
      if (s.status !== 'running') { save(statePath, s); return { status: s.status, next: 'inspect 中的状态需要 L1 处理；用户暂停时保持暂停' }; }
      const js = engine.reserve(s).filter(j => {
        if (claimLease(s, j, statePath)) return true;
        const t = engine.ticket(s, j.ticket); t.phase = 'blocked'; t.reason = '工单由另一个运行持有'; j.status = 'cancelled'; return false;
      });
      const packets = s.jobs.filter(j=>j.status==='leased' && !j.nativeId).map(j => { const p = packet(s, j, statePath); const file = path.join(path.dirname(statePath), 'packets', sha(j.id).slice(0, 20) + '.json'); write(file, p); return { ...j, packetPath: file }; });
      save(statePath, s);
      return { status: s.status, jobs: packets, outstanding: s.jobs.filter(active).map(j => ({id:j.id, nativeId:j.nativeId, status:j.status})), instruction: 'L1 按实际模型派发；没有新任务时等待在途任务或处理明确阻塞，不循环空轮询' };
    } else if (op === 'bind') {
      engine.ensure(extra && fourth, '需要 jobId 与宿主 binding.json'); engine.bind(s, extra, read(fourth));
    } else if (op === 'reconfigure') {
      engine.ensure(extra && !s.jobs.some(active) && !['complete','retired'].includes(s.status),'先确认在途任务终止；不能改写已终结运行');
      const config=read<{models:engine.Inputs['models'];capabilities:engine.Capabilities;evidencePath:string}>(extra);
      safeFile(config.evidencePath);engine.ensure(config.capabilities.mainModel===config.models.L1,'实际主会话必须符合新 L1');
      engine.ensure(['per_agent','per_run'].includes(config.capabilities.modelRouting),'宿主必须支持指定模型路由');
      for(const tier of ['L1','L2','L3'] as const)engine.ensure(config.models[tier] && config.capabilities.models.includes(config.models[tier]),'宿主没有确认新模型可用');
      s.inputs.models=config.models;s.capabilities=config.capabilities;
      engine.event(s,'模型路由已重新配置；保留完成结果，仅下一次派发使用新模型');
    } else if (op === 'retire') {
      engine.ensure(extra && !s.jobs.some(active),'退役前必须对账并停止在途执行者');
      const r=read<{evidencePath:string;reason:string}>(extra);safeFile(r.evidencePath);engine.ensure(r.reason,'需要退役原因');
      s.retired={...r,at:new Date().toISOString()};s.status='retired';engine.event(s,'运行已退役，保留原始证据和未交付资源');
    } else if (op === 'record-host') {
      engine.ensure(extra,'需要真实宿主观测文件');
      const records=read<{jobId:string;nativeId:string;evidencePath:string;startedAt?:string;usage?:engine.Job['usage']}[]>(extra);
      for(const r of records) {
        const j=s.jobs.find(j=>j.id===r.jobId);engine.ensure(j && j.nativeId===r.nativeId,'宿主身份不符');safeFile(r.evidencePath);
        if(r.startedAt){engine.ensure(Number.isFinite(Date.parse(r.startedAt)),'开始时间无效');j.timing??={leasedAt:''};j.timing.startedAt=r.startedAt;}
        if(r.usage){for(const [k,v] of Object.entries(r.usage))if(k!=='currency')engine.ensure(typeof v==='number' && Number.isFinite(v) && v>=0,'用量必须来自非负真实观测');j.usage=r.usage;}
      }
      engine.event(s,'记录宿主真实时间与用量；未提供的字段保持未知');
    } else if (op === 'submit') {
      engine.ensure(extra && fourth, '需要 jobId 与结果 JSON');
      const j = s.jobs.find(j => j.id === extra); engine.ensure(j, '未知 job'); const r = read<engine.Result>(fourth);
      if (j.status !== 'done') {engine.ensure(!j.testExecution,'测试进程未完成');s.facts = observe(s,[j]); validateResult(s, j, r); }
      engine.submit(s, extra, r);
      archiveResult(statePath,j);
    } else if (op === 'reconcile') {
      engine.ensure(extra, '需要 L1 查询宿主后生成的 host-status.json');
      const statuses = read<{jobId:string; nativeId:string; state:'running'|'stopped'|'lost'|'completed'; evidencePath:string; userStopped?:boolean;processTreeStopped?:boolean;commandDisposition?:'recover'|'cancel'}[]>(extra);
      for (const observation of statuses) {
        const j = s.jobs.find(j => j.id === observation.jobId); engine.ensure(j && active(j), '只能对账在途任务');
        engine.ensure(j.nativeId === observation.nativeId, '宿主任务身份不符'); safeFile(observation.evidencePath);
        if (observation.userStopped) { s.status = 'paused'; continue; }
        if (observation.state === 'stopped' || observation.state === 'lost') {
          engine.ensure(!j.testExecution || !processAlive(j.testExecution.pid),'测试进程仍在运行，不能释放预算');
          engine.ensure(!j.testExecution || observation.processTreeStopped===true,'中断测试须核对整个进程树');
          if(j.executor!=='agent' && /^command:\d+:/.test(j.nativeId) && s.protocol===2) {
            engine.ensure(!processAlive(Number(j.nativeId.split(':')[1])) && observation.processTreeStopped===true,'命令恢复须确认父进程与整个进程树已停止');
            if(observation.commandDisposition==='recover') {
              j.commandRecovery={nativeId:j.nativeId,evidencePath:observation.evidencePath,at:new Date().toISOString()};
              continue;
            }
            delete j.commandRecovery;
          }
          j.status = 'cancelled';
          j.timing??={leasedAt:''};j.timing.cancelledAt=new Date().toISOString();delete j.testExecution;
          if (j.ticket === '$spec') s.specAudit = undefined;
          else engine.ticket(s, j.ticket).reason = '任务已终止；新执行者从持久证据恢复本阶段，不跳过中间验证';
        }
        // completed 必须读取并提交原结果，不重做外部动作；running 保留原租约。
      }
      const observed=observe(s);
      if(s.protocol===2)engine.reconcileFacts(s,observed);else s.facts=observed;
      engine.event(s, '实时核对宿主、GitHub 和候选；没有将 journal 回放当作新验证');
    } else if (op === 'resolve') {
      engine.ensure(extra, '需要 L1 根据已取得事实生成的解除阻塞决定');
      const decisions = read<{ticket:string; evidencePath:string; handoffPath:string}[]>(extra);
      s.facts = observe(s);
      for (const d of decisions) {
        const t = engine.ticket(s, d.ticket); safeFile(d.evidencePath); safeFile(d.handoffPath);
        engine.ensure(t.phase === 'blocked' && !s.jobs.some(j => j.ticket === t.key && active(j)), '只解除没有在途任务的阻塞工单');
        t.handoffPath = d.handoffPath; t.phase = t.worktree ? 'replan' : 'claim'; t.epoch++; t.reason = '';
      }
      if (s.status !== 'paused') s.status = 'running'; engine.event(s, 'L1 用已取得的新事实解除局部阻塞；重新规划而非跳过验证');
      s.specAudit = undefined; s.auditEpoch++;
    } else if (op === 'resume') {
      engine.ensure(!s.jobs.some(active), '恢复前先对账或停止已有任务'); engine.reconcileFacts(s, observe(s));
      engine.ensure(s.status !== 'complete', '本 workflow 已完成'); s.status = 'running'; s.specAudit = undefined; s.auditEpoch++;
      engine.event(s, 'L1 根据用户继续指令恢复执行；未自动清除工单阻塞');
    } else throw new Error(`未知命令 ${op}`);
    save(statePath, s); return { statePath, status: s.status, revision: s.revision };
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ error: error.message, note: '未满足的条件不会被当作成功；核对后由 L1 继续' }) + '\n'); process.exitCode = 1;
  });
}
