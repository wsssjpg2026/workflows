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
export * from './spec-delivery/core.ts';

const home = path.dirname(fileURLToPath(import.meta.url));
const rolesPath = path.join(home, 'spec-delivery', 'roles.md');
const workflowVersion = '0.1.0';
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
function lock(file: string) {
  const dir = file + '.lock';
  try { fs.mkdirSync(dir); }
  catch (error) {
    engine.ensure((error as NodeJS.ErrnoException).code === 'EEXIST', String(error));
    const infoPath = path.join(dir, 'owner.json');
    engine.ensure(fs.existsSync(infoPath), '状态锁缺少 owner，先确认前一次写入进程已经终止');
    const owner = read<{ pid: number; host: string }>(infoPath);
    engine.ensure(owner.host === os.hostname(), '状态被其他机器占用；本版只支持同机恢复');
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    engine.ensure(!alive, '另一个主控正在修改状态，请稍后重试');
    fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir);
  }
  write(path.join(dir, 'owner.json'), { pid: process.pid, host: os.hostname() });
  return () => fs.rmSync(dir, { recursive: true });
}
function save(file: string, s: engine.State) {
  // 先保存完整历史，再原子替换当前状态；重复提交不会覆盖历史证据。
  write(path.join(path.dirname(file), 'history', `${String(s.revision).padStart(6, '0')}-${randomUUID()}.json`), s);
  write(file, s);
}
export function observe(s: engine.State): engine.LiveFacts {
  const base = gh.targetHead(s.repo, s.inputs.targetBranch);
  const numbers = [...new Set([s.spec, ...s.tickets.map(t => t.number), ...s.tickets.flatMap(t => t.dependencies)])];
  const issueStates: Record<string, string> = {};
  for (const n of numbers) issueStates[String(n)] = gh.issue(s.repo, n).state;
  for (const key of new Set(s.tickets.flatMap(t => t.externalDependencies || []))) {
    const marker = key.lastIndexOf('#');
    issueStates[key] = gh.issue({ ...s.repo, slug: key.slice(0, marker) }, Number(key.slice(marker + 1))).state;
  }
  const prs: Record<string, gh.PrFact> = {};
  for (const n of new Set(s.tickets.map(t => t.pr).filter(Boolean))) prs[String(n)] = gh.pr(s.repo, n);
  return { base, issueStates, prs, at: new Date().toISOString() };
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
    engine.ensure(JSON.stringify(prior.inputs.models) === JSON.stringify(inputs.models), '已有运行使用其他模型；先核对/停止旧任务后再重新配置，避免重复派发');
    return { statePath: file, resumed: true, next: 'inspect 后实时 reconcile；不得重新认领已有任务' };
  }
  const parent = gh.issue(repo, spec), children = gh.subIssues(repo, spec);
  engine.ensure(parent.state === 'OPEN', '目标 spec 已关闭'); engine.ensure(children.length, '目标 spec 尚无可读取的既有 sub-issues');
  const base = gh.targetHead(repo, inputs.targetBranch);
  excludeRuntime(repo.root);
  const s: engine.State = { schema: 1, id: randomUUID(), revision: 0, inputs, spec, repo, status: 'planning', tickets: [], jobs: [],
    specCriteria: [], planEvidence: '', auditEpoch: 1, events: [],
    facts: { base, issueStates: Object.fromEntries([parent, ...children].map(i => [String(i.number), i.state])), prs: {}, at: new Date().toISOString() } };
  engine.event(s, '读取当前仓库和既有 spec/sub-issues；等待 L1 主 agent 制定执行安排');
  fs.mkdirSync(path.dirname(file), { recursive: true }); const release = lock(file);
  try { engine.ensure(!fs.existsSync(file), '另一个主控已启动这个 spec'); save(file, s); } finally { release(); }
  const snapshot = path.join(path.dirname(file), 'initial-sources.json'); write(snapshot, { parent, children });
  return { statePath: file, sourcesPath: snapshot, rolesPath, next: 'L1 主 agent 读取来源、判断人工边界、选择资源预算，生成 ExecutionPlan 后调用 plan',
    resources: { cpus: os.availableParallelism(), freeMemoryBytes: os.freemem(), loadAverage: os.loadavg() } };
}
function packet(s: engine.State, j: engine.Job, statePath: string) {
  const t = s.tickets.find(t => t.key === j.ticket);
  const out = path.join(path.dirname(statePath), 'jobs', sha(j.id).slice(0, 20));
  const authored = ['implement', 'publish', 'integrate', 'replan'].includes(j.action);
  const prior = s.jobs.filter(x => x.ticket === j.ticket && x.status === 'done' && x.result &&
    (j.action === 'review-report' ? x.epoch === j.epoch && ['review-lens', 'confirm'].includes(x.action)
      : !j.fresh && (authored || ['review-lens', 'confirm', 'review-report'].includes(x.action))))
    .map(x => ({ action: x.action, result: x.result }));
  const objective = j.fresh && ['review-lens', 'confirm'].includes(j.action)
    ? { tests: t?.evidence.tests, visual: t?.evidence.visual } : t?.evidence || {};
  return { jobId: j.id, action: j.action, tier: j.tier, model: j.model, executor: j.executor, fresh: j.fresh, contextKey: j.contextKey,
    repo: s.repo, spec: s.spec, issue: t?.number || s.spec, targetBranch: s.inputs.targetBranch,
    branch: t?.branch || '', worktree: t?.worktree || '', pr: t?.pr || 0, expectedHead: j.head, expectedBase: j.base,
    criteria: t?.criteria || s.specCriteria, visualRequired: t?.visual || false, closeout: t?.closeout || false,
    planPath: j.fresh && j.action !== 'plan-check' ? '' : t?.planPath || '', checksPath: t?.checksPath || '',
    handoffPath: j.fresh ? '' : authored ? t?.handoffPath || '' : t?.reviewHandoff || '',
    sourceUrl: `https://${s.repo.host}/${s.repo.slug}/issues/${t?.number || s.spec}`,
    objectiveEvidence: objective, prior, finding: j.finding || null,
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
    engine.ensure(git(worktree, 'rev-parse', 'HEAD') === data.head, '认领回执的本地 SHA 不符');
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
function executeCommand(statePath: string, id: string) {
  let release = lock(statePath); let s: engine.State; let j: engine.Job;
  try {
    s = read<engine.State>(statePath); engine.ensure(s.status === 'running', 'workflow 未运行；暂停后不能执行命令任务');
    const found = s.jobs.find(job => job.id === id);
    engine.ensure(found && found.executor === 'command' && found.status === 'leased' && !found.nativeId, 'command job 已执行或在执行；先对账，不能重入'); j = found;
    s.facts = observe(s); engine.bind(s, j.id, { nativeId: j.nativeId || `command:${process.pid}:${s.revision}`, model: j.model });
    save(statePath, s);
  } finally { release(); }
  // 测试/清理时只保留资源租约，不持有整个状态文件锁；其他独立工单可以继续。
  const r = j.action === 'verify' ? verify(s, j, statePath) : cleanup(s, j, statePath);
  release = lock(statePath);
  try {
    const latest = read<engine.State>(statePath); latest.facts = observe(latest);
    engine.submit(latest, j.id, r); save(statePath, latest);
    return { statePath, status: latest.status, revision: latest.revision, result: r };
  } finally { release(); }
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
function renderZcode(s: engine.State, statePath: string) {
  const jobs = s.jobs.filter(j => j.status === 'leased' && j.executor === 'agent');
  const result: unknown[] = [];
  for (const model of new Set(jobs.map(j => j.model))) {
    const allJobs = jobs.filter(j => j.model === model);
    for (let offset = 0; offset < allJobs.length; offset += 128) {
    const group = allJobs.slice(offset, offset + 128);
    const tasks = group.map(j => ({ id: j.id, name: `${j.ticket} ${j.action} ${j.part}`, packet: path.join(path.dirname(statePath), 'packets', sha(j.id).slice(0, 20) + '.json') }));
    const script = `// Generated from spec-delivery.workflow.ts. 每个运行只使用一个实际模型。\ninterface Receipt {\n/** 对应已分配的 job。 */ jobId: string;\n/** 完整结果 JSON 的工作区相对路径。 */ resultPath: string;\n/** 本次执行的摘要，不把候选发现当作已确认结论。 */ summary: string;\n}\nconst tasks = ${JSON.stringify(tasks, null, 2)};\nphase("执行本批次已分配的任务");\nconst outcomes = await Promise.allSettled(tasks.map(async task => {\n  const actor = agent(task.name, "按 packet 和 roles.md 执行限定任务。不要派子 agent，不调用嵌套 workflow。中文记录。输出真实证据与结果文件。");\n  const receipt = await actor.ask<Receipt>(\`读取 \${task.packet}，按照指定 action 执行。将完整 Result JSON 写到 packet.resultPath（具体字段见 packet 和 roles.md），不要修改主控状态。返回 jobId、工作区相对的 resultPath 和简短摘要。\`);\n  report({jobId: receipt.jobId, resultPath: receipt.resultPath, summary: receipt.summary.slice(0, 1000)});\n  return receipt;\n}));\nconst reportText = outcomes.map(x => x.status === "fulfilled" ? x.value.summary.slice(0, 400) : "任务未完整执行，需要主控核对").join("\\n\\n");\nawait artifact.markdown("batch-results", reportText, {title:"阶段任务结果", primary:true});\nreturn {conclusion:reportText, findings:[], verified:[], notCovered:["工单是否完成由主控读取真实回执与远端事实后判定"], outcomes: outcomes.map(x => x.status === "fulfilled" ? {status: "fulfilled", receipt:x.value} : {status:"rejected", reason:String(x.reason)})};\n`;
    const draft = path.join(path.dirname(statePath), 'zcode', `batch-${s.revision}-${sha(model).slice(0, 8)}-${offset}.dwf.ts`);
    fs.mkdirSync(path.dirname(draft), { recursive: true }); fs.writeFileSync(draft, script);
    result.push({ loadSkill: 'dynamic-workflows', tool: 'CreateWorkflow', arguments: { name: 'Spec 开发阶段任务', path: draft, subagent_model: model, max_concurrency: group.length }, jobIds: group.map(j => j.id),
      note: '调用成功后，用实际 runId/actor 身份逐 job bind；收到结果再 submit。此生成命令未调用 ZCode。' });
    }
  }
  return result;
}
async function main(argv: string[]) {
  const [op, file, extra, fourth] = argv;
  if (!op || op === 'help') return { workflow: 'spec-delivery', input: ['spec', 'targetBranch', 'models.L1', 'models.L2', 'models.L3'],
    readme: path.join(home, 'spec-delivery', 'README.md'), commands: ['init <input.json>', 'inspect <state>', 'plan <state> <plan.json>', 'next <state>', 'bind <state> <jobId> <binding.json>', 'submit <state> <jobId> <result.json>', 'execute <state> <jobId>', 'guard <state> <jobId>', 'reconcile <state> <host-status.json>', 'resolve <state> <decisions.json>', 'resume <state>', 'zcode <state>', 'version'] };
  if (op === 'version') return { workflow: 'spec-delivery', version: workflowVersion };
  engine.ensure(file, '缺少输入文件/状态路径');
  if (op === 'init') return initialize(read<engine.Inputs>(file));
  if (op === 'execute') { engine.ensure(extra, '需要 command jobId'); return executeCommand(path.resolve(file), extra); }
  const statePath = path.resolve(file), release = lock(statePath);
  try {
    const s = read<engine.State>(statePath); engine.ensure(s.schema === 1, '不支持的状态版本');
    if (op === 'inspect') return { ...s, rolesPath };
    if (op === 'zcode') return renderZcode(s, statePath);
    if (op === 'guard') {
      engine.ensure(s.status === 'running', 'workflow 未运行，禁止合并或关闭');
      const j = s.jobs.find(j => j.id === extra); engine.ensure(j && active(j), '需要在途 job'); s.facts = observe(s);
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
      const packets = js.map(j => { const p = packet(s, j, statePath); const file = path.join(path.dirname(statePath), 'packets', sha(j.id).slice(0, 20) + '.json'); write(file, p); return { ...j, packetPath: file }; });
      save(statePath, s);
      return { status: s.status, jobs: packets, outstanding: s.jobs.filter(active).map(j => ({id:j.id, nativeId:j.nativeId, status:j.status})), instruction: 'L1 按实际模型派发；没有新任务时等待在途任务或处理明确阻塞，不循环空轮询' };
    } else if (op === 'bind') {
      engine.ensure(extra && fourth, '需要 jobId 与宿主 binding.json'); engine.bind(s, extra, read(fourth));
    } else if (op === 'submit') {
      engine.ensure(extra && fourth, '需要 jobId 与结果 JSON');
      const j = s.jobs.find(j => j.id === extra); engine.ensure(j, '未知 job'); const r = read<engine.Result>(fourth);
      if (j.status !== 'done') { s.facts = observe(s); validateResult(s, j, r); }
      engine.submit(s, extra, r);
    } else if (op === 'reconcile') {
      engine.ensure(extra, '需要 L1 查询宿主后生成的 host-status.json');
      const statuses = read<{jobId:string; nativeId:string; state:'running'|'stopped'|'lost'|'completed'; evidencePath:string; userStopped?:boolean}[]>(extra);
      for (const observation of statuses) {
        const j = s.jobs.find(j => j.id === observation.jobId); engine.ensure(j && active(j), '只能对账在途任务');
        engine.ensure(j.nativeId === observation.nativeId, '宿主任务身份不符'); safeFile(observation.evidencePath);
        if (observation.userStopped) { s.status = 'paused'; continue; }
        if (observation.state === 'stopped' || observation.state === 'lost') {
          j.status = 'cancelled';
          if (j.ticket === '$spec') s.specAudit = undefined;
          else engine.ticket(s, j.ticket).reason = '任务已终止；新执行者从持久证据恢复本阶段，不跳过中间验证';
        }
        // completed 必须读取并提交原结果，不重做外部动作；running 保留原租约。
      }
      engine.reconcileFacts(s, observe(s)); engine.event(s, '实时核对宿主、GitHub 和候选；没有将 journal 回放当作新验证');
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
