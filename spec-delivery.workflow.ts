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
export const workflowVersion = '0.3.0';
const rolesPath = path.join(home, 'spec-delivery', 'roles.md');
const active = (j: engine.Job) => j.status === 'leased' || j.status === 'running';
const recovering = (s: engine.State, j: engine.Job) => s.tickets.some(t => t.key === j.ticket && t.phase === 'recovery');
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
function gitRaw(root: string, ...argv: string[]) {
  return execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function worktreeFingerprint(root: string, status: string) {
  const hash = createHash('sha256');
  hash.update(status);
  hash.update(gitRaw(root, 'diff', '--binary'));
  hash.update(gitRaw(root, 'diff', '--cached', '--binary'));
  for (const relative of gitRaw(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort()) {
    const file = path.resolve(root, relative);
    engine.ensure(file.startsWith(path.resolve(root) + path.sep), 'Git 报告了工作区外的未跟踪路径');
    const stat = fs.lstatSync(file);
    hash.update(JSON.stringify({ relative, mode: stat.mode, type: stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'other' }));
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else if (stat.isFile()) hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}
function ancestor(root: string, earlier: string, later: string) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', earlier, later], { cwd: root, stdio: 'ignore' });
  return result.status === 0;
}
/** A real Git ref keeps a candidate reachable even if its branch is subsequently rewritten. */
function preserveHead(s: engine.State, t: engine.Ticket, head: string) {
  engine.ensure(/^[0-9a-f]{40,64}$/.test(head), '候选不是完整 Git commit SHA');
  git(s.repo.root, 'cat-file', '-e', `${head}^{commit}`);
  const ref = `refs/spec-delivery/recovery/${sha(s.id).slice(0, 12)}/${sha(t.key).slice(0, 12)}/${head}`;
  const existing = git(s.repo.root, 'for-each-ref', '--format=%(objectname)', ref);
  engine.ensure(!existing || existing === head, 'recovery ref 已指向另一提交');
  if (!existing) git(s.repo.root, 'update-ref', ref, head);
  return ref;
}
interface WorkspaceObservation {
  head: string | null; branch: string | null; status: string; unmerged: string;
  stagedDiff: string; worktreeDiff: string; untracked: string; error?: string;
}
function inspectWorktree(t: engine.Ticket): WorkspaceObservation {
  try {
    return {
      head: git(t.worktree, 'rev-parse', 'HEAD'), branch: git(t.worktree, 'branch', '--show-current'),
      status: gitRaw(t.worktree, 'status', '--porcelain=v1', '--untracked-files=all'),
      unmerged: gitRaw(t.worktree, 'ls-files', '-u'),
      stagedDiff: gitRaw(t.worktree, 'diff', '--cached', '--binary'),
      worktreeDiff: gitRaw(t.worktree, 'diff', '--binary'),
      untracked: gitRaw(t.worktree, 'ls-files', '--others', '--exclude-standard'),
    };
  } catch (error) {
    return { head: null, branch: null, status: '', unmerged: '', stagedDiff: '', worktreeDiff: '', untracked: '', error: (error as Error).message };
  }
}
function enterWorkspaceRecovery(s: engine.State, t: engine.Ticket, statePath: string, reason: string, sourceJobId?: string, observation = inspectWorktree(t)) {
  if (t.phase === 'recovery') return t.recovery;
  const kind: engine.WorkspaceRecovery['kind'] = observation.unmerged ? 'conflict' : observation.status ? 'wip' : 'unknown_candidate';
  const directory = path.join(path.dirname(statePath), 'recovery', sha(t.key).slice(0, 16), randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'status.txt'), observation.status);
  fs.writeFileSync(path.join(directory, 'unmerged-index.txt'), observation.unmerged);
  fs.writeFileSync(path.join(directory, 'staged.patch'), observation.stagedDiff);
  fs.writeFileSync(path.join(directory, 'worktree.patch'), observation.worktreeDiff);
  fs.writeFileSync(path.join(directory, 'untracked.txt'), observation.untracked);
  // A patch does not contain untracked files or the conflict-marker file as a
  // standalone artifact. Copy those exact bytes while leaving the worktree intact.
  const savedFiles = path.join(directory, 'saved-files');
  if (!observation.error) {
    const names = new Set([
      ...gitRaw(t.worktree, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean),
      ...gitRaw(t.worktree, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean),
    ]);
    for (const relative of names) {
      const source = path.resolve(t.worktree, relative), destination = path.resolve(savedFiles, relative);
      engine.ensure(source.startsWith(path.resolve(t.worktree) + path.sep) && destination.startsWith(savedFiles + path.sep), 'Git 报告了工作区外的恢复文件');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { recursive: true, dereference: false });
    }
  }
  const observedRef = observation.head ? preserveHead(s, t, observation.head) : null;
  if (t.head && t.head !== observation.head) preserveHead(s, t, t.head);
  const snapshotPath = path.join(directory, 'snapshot.json');
  const recovery: engine.WorkspaceRecovery = {
    kind, reason: observation.error ? `${reason}；Git 观测失败：${observation.error}` : reason,
    sourceJobId, activeJobIds: s.jobs.filter(j => j.ticket === t.key && active(j)).map(j => j.id),
    expectedHead: t.head, observedHead: observation.head, base: t.base,
    recoveryRef: observedRef, snapshotPath, at: new Date().toISOString(),
  };
  write(snapshotPath, { ...recovery, branch: observation.branch, worktree: t.worktree,
    statusPath: path.join(directory, 'status.txt'), unmergedPath: path.join(directory, 'unmerged-index.txt'),
    stagedPatchPath: path.join(directory, 'staged.patch'), worktreePatchPath: path.join(directory, 'worktree.patch'),
    untrackedPath: path.join(directory, 'untracked.txt'), savedFilesPath: savedFiles });
  t.recovery = recovery; t.phase = 'recovery'; t.reason = recovery.reason; t.epoch++; t.evidence = {};
  s.specAudit = undefined; s.auditEpoch++;
  engine.event(s, `${t.key} 工作区进入 ${kind} 恢复；已保留现有工作、冲突索引与候选引用`);
  return recovery;
}
/** Only inspect idle worktrees. A running writer may legitimately have temporary WIP. */
function inspectIdleWorkspaces(s: engine.State, facts: engine.LiveFacts, statePath: string) {
  if (s.protocol !== engine.currentProtocol) return;
  for (const t of s.tickets) {
    if (!t.worktree || ['claim', 'done', 'human', 'close', 'cleanup', 'recovery'].includes(t.phase) || s.jobs.some(j => j.ticket === t.key && active(j))) continue;
    const observed = inspectWorktree(t), pr = facts.prs[String(t.pr)];
    if (observed.unmerged || observed.status || observed.error || observed.branch !== t.branch || observed.head !== t.head) {
      enterWorkspaceRecovery(s, t, statePath,
        observed.unmerged ? '工作区存在未解决合并冲突' : observed.status ? '工作区存在未提交工作' : '本地候选来源或任务分支与账本不一致', undefined, observed);
      continue;
    }
    if (pr && pr.state === 'OPEN' && pr.head !== t.head &&
      !(t.pendingPushHead === t.head && observed.head && ancestor(s.repo.root, pr.head, observed.head))) {
      enterWorkspaceRecovery(s, t, statePath, '远端 PR 候选与本地候选分叉，需核对来源', undefined, observed);
    }
  }
}
function recoverOnRejectedResult(s: engine.State, j: engine.Job, statePath: string, error: Error) {
  if (s.protocol !== engine.currentProtocol) return;
  const t = s.tickets.find(t => t.key === j.ticket);
  if (!t?.worktree || t.phase === 'recovery') return;
  const observed = inspectWorktree(t);
  if (observed.unmerged || observed.status || observed.error || observed.branch !== t.branch || observed.head !== t.head)
    enterWorkspaceRecovery(s, t, statePath, `回执无法采用：${error.message}`, j.id, observed);
}
function recordRejectedReceipt(s: engine.State, j: engine.Job, statePath: string, error: Error, immutable = false) {
  const t = s.tickets.find(t => t.key === j.ticket);
  if (t && active(j) && t.epoch === j.epoch && s.status !== 'retired') {
    const recorded = engine.recordFailure(s, t, { id: `${j.id}:receipt_validation`, category: 'receipt_validation',
      reason: error.message, jobId: j.id, next: t.phase, invariant: immutable, preservePhase: !immutable });
    // A corrected direct submission may reuse its lease. Once a staged receipt is immutable,
    // the same previously recorded failure must still stop the unusable lease.
    if (!recorded && immutable && t.phase !== 'recovery' && t.epoch === j.epoch) {
      t.phase = t.failureBudget?.replans ? 'blocked' : 'replan'; t.epoch++; t.evidence = {};
    }
  }
  recoverOnRejectedResult(s, j, statePath, error);
}
function recoverWorkspace(s: engine.State, statePath: string, key: string, decision: {
  expectedRevision: number; expectedRecoveryHead: string | null; resolvedHead: string; resolvedBase: string;
  evidencePath: string; handoffPath: string; reason: string; sourceEvidencePath?: string;
}) {
  engine.ensure(s.protocol === engine.currentProtocol, '工作区恢复只支持运行协议 3');
  engine.ensure(['running', 'paused', 'blocked'].includes(s.status), '已完成或等待人工的运行不能恢复工作区派发');
  const t = engine.ticket(s, key), recovery = t.recovery;
  engine.ensure(t.phase === 'recovery' && recovery, '工单不在工作区恢复状态');
  engine.ensure(decision.expectedRevision === s.revision && decision.expectedRecoveryHead === recovery.observedHead, '恢复决定已过期；重新 inspect 后生成决定');
  engine.ensure(typeof decision.reason === 'string' && decision.reason.trim(), '恢复需要明确原因');
  safeFile(decision.evidencePath); safeFile(decision.handoffPath);
  for (const id of recovery.activeJobIds) {
    const j = s.jobs.find(j => j.id === id);
    engine.ensure(j && (j.status === 'done' || (j.status === 'cancelled' && j.stopConfirmation?.processTreeStopped === true)), `执行者 ${id} 尚未确认停止或完成`);
  }
  engine.ensure(!s.jobs.some(j => j.ticket === t.key && (active(j) || j.testExecution)), '相关执行者或测试进程仍可能运行，先 reconcile');
  const observed = inspectWorktree(t);
  engine.ensure(!observed.error && !observed.status && !observed.unmerged, '先保全并解决 WIP/冲突；恢复时工作区必须干净');
  const ownedRoot = path.join(s.repo.root, '.agents', 'worktrees') + path.sep;
  engine.ensure(path.resolve(t.worktree).startsWith(ownedRoot) &&
    fs.realpathSync(t.worktree).startsWith(fs.realpathSync(path.join(s.repo.root, '.agents', 'worktrees')) + path.sep),
    '恢复 worktree 必须仍在本仓库管理的 .agents/worktrees 下');
  engine.ensure(observed.branch === t.branch && observed.head === decision.resolvedHead, '恢复候选必须是原任务分支的真实 HEAD');
  engine.ensure(path.resolve(t.worktree, git(t.worktree, 'rev-parse', '--git-common-dir')) === path.resolve(s.repo.root, git(s.repo.root, 'rev-parse', '--git-common-dir')), '恢复 worktree 不属于当前仓库');
  const origin = recovery.observedHead || recovery.expectedHead;
  if (origin && !ancestor(s.repo.root, origin, decision.resolvedHead)) {
    engine.ensure(decision.sourceEvidencePath, '候选不继承保全提交；需独立来源核对证据');
    safeFile(decision.sourceEvidencePath);
  }
  engine.ensure(ancestor(s.repo.root, decision.resolvedBase, decision.resolvedHead), '恢复候选没有包含声明的目标基线');
  if (decision.resolvedBase !== recovery.base) engine.ensure(decision.resolvedBase === s.facts.base, '新集成基线必须是实时目标分支 SHA');
  const ref = preserveHead(s, t, decision.resolvedHead);
  t.recoveryHistory ??= [];
  t.recoveryHistory.push({ ...recovery, resolvedAt: new Date().toISOString(), resolvedHead: decision.resolvedHead,
    resolutionPath: decision.evidencePath, sourceEvidencePath: decision.sourceEvidencePath });
  t.recovery = undefined; t.recoveryRef = ref; t.head = decision.resolvedHead; t.base = decision.resolvedBase;
  t.handoffPath = decision.handoffPath; t.pendingPushHead = decision.resolvedHead;
  if (decision.resolvedBase !== recovery.base) t.integrationHead = decision.resolvedHead;
  t.phase = 'replan'; t.reason = decision.reason; t.epoch++; t.evidence = {};
  if (s.validationOwner === t.key) s.validationOwner = undefined;
  engine.event(s, `${t.key} 根据 ${decision.evidencePath} 恢复已保全候选，交给 L1 重规划`);
  return { ticket: t.key, head: t.head, base: t.base, recoveryRef: ref, phase: t.phase };
}
function supportedLedger(s: engine.State) {
  engine.ensure(s.schema === 1, '不支持的状态版本');
  engine.ensure(s.protocol === undefined || s.protocol === 2 || s.protocol === engine.currentProtocol,
    `不支持的运行协议：${String(s.protocol)}`);
  if (s.protocol === engine.currentProtocol) {
    engine.ensure(s.v3?.executionPath === 'legacy-v02' && Array.isArray(s.v3.decisionRecords) &&
      Array.isArray(s.v3.skillInvocations) && Array.isArray(s.v3.dispatchRecords),
      '运行协议 3 缺少过渡执行路径或记录边界');
  }
}
function allowCompletion(s: engine.State) {
  supportedLedger(s);
  engine.ensure(s.status !== 'retired', '已退役运行不能接收执行结果');
}
function requireProtocol(s: engine.State) {
  supportedLedger(s);
  engine.ensure(s.status !== 'retired', '运行已退役；只允许 inspect/metrics/summary，保留账本和资源');
  engine.ensure(s.protocol === engine.currentProtocol,
    '旧版运行须先核对并停止在途任务，再执行 upgrade 迁移到协议 3；inspect/metrics/summary 可直接读取');
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
  engine.ensure(isRecord(raw), '不支持的状态版本');
  supportedLedger(raw as unknown as engine.State);
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
    supportedLedger(prior);
    engine.ensure(prior.status!=='retired','该运行已明确退役，不能由 init 自动复活；保留账本和资源');
    engine.ensure(JSON.stringify(prior.inputs.models) === JSON.stringify(inputs.models), '已有运行使用其他模型；先核对/停止旧任务后再重新配置，避免重复派发');
    return { statePath: file, resumed: true, protocol: prior.protocol ?? 1,
      migrationRequired: prior.protocol !== engine.currentProtocol,
      next: prior.protocol === engine.currentProtocol
        ? 'inspect 后实时 reconcile；不得重新认领已有任务'
        : '旧运行只读；继续派发前先对账、停止在途任务并显式 upgrade' };
  }
  const parent = gh.issue(repo, spec), children = gh.subIssues(repo, spec);
  engine.ensure(parent.state === 'OPEN', '目标 spec 已关闭'); engine.ensure(children.length, '目标 spec 尚无可读取的既有 sub-issues');
  const base = gh.targetHead(repo, inputs.targetBranch);
  excludeRuntime(repo.root);
  const s: engine.State = { schema: 1, protocol: engine.currentProtocol, v3: engine.initialProtocolV3(), id: randomUUID(), revision: 0, inputs, spec, repo, status: 'planning', tickets: [], jobs: [],
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
    handoffPath: j.fresh && j.action !== 'replan' ? '' : authored ? t?.handoffPath || '' : t?.reviewHandoff || '',
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
  engine.ensure(t.phase !== 'recovery', '工作区尚在恢复，原任务回执不能签发新候选证据');
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
    if (!['implement', 'integrate'].includes(j.action)) engine.ensure(r.head === j.head, '过期候选 SHA：只读回执必须使用派发时的 head');
    engine.ensure(actual === (r.head || j.head), '本地候选 SHA 与回执不一致');
    if (!['implement', 'integrate'].includes(j.action)) engine.ensure(actual === j.head, '只读 actor 更改了候选；需要重新走实现与验证');
    engine.ensure(clean(t), 'worktree 有未提交变化，不能签发候选证据');
    if (['implement', 'integrate'].includes(j.action) && ['implemented', 'replan'].includes(r.status)) {
      engine.ensure(r.head && r.base && r.handoffPath, '写任务必须交接真实候选 head/base');
      if (r.status === 'replan') engine.ensure(typeof r.data?.reason === 'string' && r.data.reason.trim(), '重规划必须说明原因');
      engine.ensure(ancestor(s.repo.root, j.head, r.head), '新候选不继承原候选；先进入工作区恢复核对来源');
      engine.ensure(ancestor(s.repo.root, r.base, r.head), '新候选没有包含声明的基线');
      t.recoveryRef = preserveHead(s, t, r.head);
    }
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
  const testedTree = git(t.worktree, 'rev-parse', 'HEAD^{tree}');
  const prHead = s.facts.prs[String(t.pr)]?.head || null;
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
  write(evidencePath, { jobId: j.id, candidate: { prHead, targetBase: s.facts.base,
    localHead: j.head, testedHead: j.head, testedTree, integrationHead: t.integrationHead || null },
    manifestSha256: sha(manifestBytes), scopeReason: manifest.scopeReason, passed, rows });
  return { model: j.model, complete: true, status: passed ? 'pass' : 'fail', head: j.head, base: j.base, evidencePath,
    data: { prHead, targetBase: s.facts.base, testedHead: j.head, testedTree,
      failureSignature: passed ? '' : sha(JSON.stringify(rows.map((x: any) => [x.name, x.exitCode, x.signal]))) } };
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
    engine.ensure(!recovering(s, j), '工作区正在恢复，禁止执行原命令任务');
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
  const jobs = s.jobs.filter(j => j.status === 'leased' && j.executor === 'agent' && !recovering(s, j));
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
    const jobs = s.jobs.filter(j => active(j) && j.nativeId && j.executor === 'agent' &&
      s.tickets.find(t => t.key === j.ticket)?.phase !== 'recovery' && (!ids || ids.includes(j.id)) && fs.existsSync(resultPaths(statePath, j.id).ready));
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
      } catch (error) {
        recordRejectedReceipt(s, j, statePath, error as Error, true);
        rejected.push({jobId:j.id,error:(error as Error).message});
      }
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
  } catch (error) {
    const s = read<engine.State>(statePath), j = s.jobs.find(j => j.id === id);
    if (j && active(j)) {
      recordRejectedReceipt(s, j, statePath, error as Error);
      save(statePath, s);
    }
    throw error;
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
    engine.ensure(!recovering(s,j), '工作区正在恢复，不能启动新测试');
    s.facts = observe(s, [j]);
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
    const statusBefore=gitRaw(worktree,'status','--porcelain=v1','--untracked-files=all');
    const testedTree=statusBefore ? null : git(worktree,'rev-parse','HEAD^{tree}');
    const beforeFingerprint=worktreeFingerprint(worktree,statusBefore);
    const workingTreeFingerprint=statusBefore ? beforeFingerprint : null;
    fs.mkdirSync(out,{recursive:true});a=fs.openSync(path.join(out,'stdout.log'),'w');b=fs.openSync(path.join(out,'stderr.log'),'w');
    const r=spawnSync(request.argv[0],request.argv.slice(1),{cwd:worktree,env:{...process.env,...request.env},timeout:request.timeoutSeconds*1000,stdio:['ignore',a,b],shell:false});
    const statusAfter=gitRaw(worktree,'status','--porcelain=v1','--untracked-files=all');
    const afterFingerprint=worktreeFingerprint(worktree,statusAfter);
    const candidateStable=git(worktree,'rev-parse','HEAD')===head && afterFingerprint===beforeFingerprint;
    const current=read<engine.State>(statePath), ticket=current.jobs.find(x=>x.id===id)?.ticket;
    const related=ticket && ticket!=='$spec' ? current.tickets.find(x=>x.key===ticket) : undefined;
    const receipt={jobId:id,request,worktree,candidate:{prHead:related ? current.facts.prs[String(related.pr)]?.head || null : null,
      targetBase:base,targetBaseAtFinish:current.facts.base,localHead:head,testedHead:head,testedTree,workingTreeFingerprint,
      integrationHead:related?.integrationHead || null},head,base,candidateStable,
      statusBefore,statusAfter,exitCode:r.status,signal:r.signal,error:r.error?.message,
      stdout:path.join(out,'stdout.log'),stderr:path.join(out,'stderr.log'),finishedAt:new Date().toISOString()};
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
    version:workflowVersion,readme: path.join(home, 'spec-delivery', 'README.md'), commands: ['version','summary <state.json>', 'init <input.json>', 'inspect <state>', 'plan <state> <plan.json>', 'drive <state>', 'next <state>', 'bind <state> <jobId> <binding.json>', 'bind-batch <state> <binding.json>', 'stage <state> <jobId> <result-json>', 'collect <state>', 'submit <state> <jobId> <result.json>', 'execute <state> <jobId>', 'test <state> <jobId> <request.json>', 'guard <state> <jobId>', 'reconcile <state> <host-status.json>', 'recover-workspace <state> <ticket> <decision.json>', 'resolve <state> <decisions.json>', 'reconfigure <state> <models.json>', 'upgrade <state> <evidence.json>', 'retire <state> <reason.json>', 'record-host <state> <observations.json>', 'metrics <state>', 'resume <state>', 'zcode <state>'] };
  engine.ensure(file, '缺少输入文件/状态路径');
  // summary 在 lock() 之前返回：只验证可读协议，不创建/等待/恢复/删除状态锁，也不进入写路径。
  if (op === 'summary') return summarizeLedger(path.resolve(file));
  if (op === 'init') return initialize(read<engine.Inputs>(file));
  // 历史读取不触发锁恢复、GitHub 观测或状态写入。
  if (op === 'inspect' || op === 'metrics') {
    const state = read<engine.State>(path.resolve(file)); supportedLedger(state);
    return op === 'inspect' ? { ...state, rolesPath } : metrics(state);
  }
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
      const j=current.jobs.find(j=>j.executor!=='agent' && active(j) && !recovering(current,j) && (!j.nativeId || (dead(j) && canRecoverCommand(statePath,j))));
      if(!j) return {...next,collected,completed,recoveryRequired:current.jobs.filter(j=>active(j) && j.executor!=='agent' && !recovering(current,j) && dead(j) && !canRecoverCommand(statePath,j)).map(j=>({jobId:j.id,nativeId:j.nativeId,reason:'无命令结果，需核对子进程及外部动作后 reconcile'}))};
      executeCommand(statePath,j.id); completed.push(j.id);
    }
    return {...await main(['next',statePath]) as object,collected,completed};
  }
  const statePath = path.resolve(file), release = lock(statePath);
  try {
    let s = read<engine.State>(statePath); supportedLedger(s);
    engine.ensure(s.status !== 'retired', '已退役运行只允许 inspect/metrics/summary，不能自动复活');
    if (op === 'upgrade') {
      engine.ensure(extra && !s.jobs.some(active), '升级前先对账并确认所有在途任务已停止或完整提交');
      const proof=read<{evidencePath:string}>(extra);safeFile(proof.evidencePath);
      if(s.protocol===engine.currentProtocol)return {statePath,status:s.status,upgraded:false};
      const backup = path.join(path.dirname(statePath), 'migrations', `pre-v3-${randomUUID()}.json`);
      fs.mkdirSync(path.dirname(backup), {recursive:true});
      fs.copyFileSync(statePath, backup, fs.constants.COPYFILE_EXCL);
      // 老轮次的确认 ID 与分组方法不同，不混用部分 regular/fresh 通过结果。
      for(const t of s.tickets) if(['self','verify','publish','review','fresh','accept','merge','integrate'].includes(t.phase) || t.reason==='waiting_ci') {
        t.phase='queued';t.epoch++;t.evidence={};t.reason='旧运行已迁移；从队首重新验证候选';
      }
      for(const j of s.jobs) if(j.result) {
        const output=resultPaths(statePath,j.id).result;
        if(!fs.existsSync(output))write(output,j.result);
      }
      if(s.status!=='complete'){s.specAudit=undefined;s.auditEpoch++;}
      s.validationOwner=undefined;s.protocol=engine.currentProtocol;s.v3=engine.initialProtocolV3();
      engine.event(s,`迁移为运行协议 3；原账本备份：${backup}；保留全部原结果和已完成工单。对账依据：${proof.evidencePath}`);
      save(statePath,s);return {statePath,status:s.status,upgraded:true,backupPath:backup};
    }
    if(!['bind','submit','reconcile','retire'].includes(op))requireProtocol(s);
    if (op === 'recover-workspace') {
      engine.ensure(extra && fourth, '需要工单 key 与恢复决定文件');
      s.facts = observe(s);
      const result = recoverWorkspace(s, statePath, extra, read(fourth));
      save(statePath, s);
      return { statePath, status: s.status, revision: s.revision, ...result };
    }
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
      const observed = observe(s);
      inspectIdleWorkspaces(s, observed, statePath);
      engine.reconcileFacts(s, observed);
      if (s.status !== 'running') { save(statePath, s); return { status: s.status, next: 'inspect 中的状态需要 L1 处理；用户暂停时保持暂停' }; }
      const js = engine.reserve(s).filter(j => {
        if (claimLease(s, j, statePath)) return true;
        const t = engine.ticket(s, j.ticket); t.phase = 'blocked'; t.reason = '工单由另一个运行持有'; j.status = 'cancelled'; return false;
      });
      const packets = s.jobs.filter(j=>j.status==='leased' && !j.nativeId && !recovering(s,j)).map(j => { const p = packet(s, j, statePath); const file = path.join(path.dirname(statePath), 'packets', sha(j.id).slice(0, 20) + '.json'); write(file, p); return { ...j, packetPath: file }; });
      save(statePath, s);
      return { status: s.status, jobs: packets, outstanding: s.jobs.filter(active).map(j => ({id:j.id, nativeId:j.nativeId, status:j.status})),
        recoveries: s.tickets.filter(t => t.phase === 'recovery').map(t => ({ticket:t.key,...t.recovery})),
        instruction: 'L1 按实际模型派发；工作区恢复先核对执行者并调用 recover-workspace；没有新任务时等待在途任务或处理明确阻塞' };
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
      const trial = structuredClone(s), trialJob = trial.jobs.find(x => x.id === extra)!;
      try {
        if (trialJob.status !== 'done') {engine.ensure(!trialJob.testExecution,'测试进程未完成');trial.facts = observe(trial,[trialJob]); validateResult(trial, trialJob, r); }
        engine.submit(trial, extra, r);
      } catch (error) {
        recordRejectedReceipt(s, j, statePath, error as Error);
        save(statePath, s);
        throw error;
      }
      s = trial; archiveResult(statePath,s.jobs.find(x=>x.id===extra)!);
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
          if(j.executor==='agent' && s.tickets.some(t => t.key === j.ticket && t.worktree))
            engine.ensure(observation.processTreeStopped===true,'工作区执行者须核对整个进程树后才能释放写权');
          if(j.executor!=='agent' && /^command:\d+:/.test(j.nativeId) && s.protocol!==undefined) {
            engine.ensure(!processAlive(Number(j.nativeId.split(':')[1])) && observation.processTreeStopped===true,'命令恢复须确认父进程与整个进程树已停止');
            if(observation.commandDisposition==='recover') {
              j.commandRecovery={nativeId:j.nativeId,evidencePath:observation.evidencePath,at:new Date().toISOString()};
              continue;
            }
            delete j.commandRecovery;
          }
          j.status = 'cancelled';
          j.stopConfirmation = {state:observation.state,evidencePath:observation.evidencePath,processTreeStopped:observation.processTreeStopped===true,at:new Date().toISOString()};
          j.timing??={leasedAt:''};j.timing.cancelledAt=new Date().toISOString();delete j.testExecution;
          if (j.ticket === '$spec') s.specAudit = undefined;
          else {
            const t = engine.ticket(s, j.ticket);
            if (t.failures?.some(f => f.jobId === j.id)) engine.finalizeRejectedReceipt(s, t, j);
            else if (j.nativeId)
              engine.recordFailure(s, t, { id: `${j.id}:host`, category: 'host', jobId: j.id,
                reason: `宿主执行 ${observation.state}；${observation.evidencePath}`, signature: `${j.action}:${observation.state}`,
                next: t.phase, preservePhase: t.phase === 'recovery' });
          }
        }
        // completed 必须读取并提交原结果，不重做外部动作；running 保留原租约。
      }
      const observed=observe(s);
      inspectIdleWorkspaces(s, observed, statePath);
      if(s.protocol!==undefined)engine.reconcileFacts(s,observed);else s.facts=observed;
      engine.event(s, '实时核对宿主、GitHub 和候选；没有将 journal 回放当作新验证');
    } else if (op === 'resolve') {
      engine.ensure(extra, '需要 L1 根据已取得事实生成的解除阻塞决定');
      const decisions = read<{ticket:string; evidencePath:string; handoffPath:string; newFacts?:string; failureEventId?:string}[]>(extra);
      s.facts = observe(s);
      for (const d of decisions) {
        const t = engine.ticket(s, d.ticket); safeFile(d.evidencePath); safeFile(d.handoffPath);
        engine.ensure(t.phase === 'blocked' && !s.jobs.some(j => j.ticket === t.key && active(j)), '只解除没有在途任务的阻塞工单');
        engine.ensure(!s.jobs.some(j => j.ticket === t.key && j.testExecution), '测试进程树未对账，不能解除阻塞');
        if (t.failureBudget?.totalRetries) {
          engine.ensure(typeof d.newFacts === 'string' && d.newFacts.trim() &&
            d.failureEventId === t.failures?.at(-1)?.id, '失败预算解除阻塞须指出最新失败事件及有证据的新事实');
          t.failureBudget.consecutiveNoProgress = 0; t.failureBudget.lastSignature = '';
        }
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
