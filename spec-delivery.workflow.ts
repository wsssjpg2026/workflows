/**
 * spec-delivery — 通用 TypeScript workflow，由宿主主会话转发，真实 L1 会话决策。
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
import * as skills from './spec-delivery/skills.ts';
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
function sourceVersion(parent: gh.IssueFact, children: gh.IssueFact[]) {
  const normalized = (issue: gh.IssueFact) => ({ number: issue.number, title: issue.title, body: issue.body, url: issue.url,
    blockedBy: issue.blockedBy.map(b => `${b.repo}#${b.number}`).sort(),
    comments: issue.comments.filter(c => !c.body.includes('<!-- spec-delivery:'))
      .map(c => ({ url: c.url, body: c.body })).sort((a, b) => a.url.localeCompare(b.url)) });
  return sha(JSON.stringify({ parent: normalized(parent), children: children.map(normalized).sort((a, b) => a.number - b.number) }));
}
function nativeSession(statePath: string, nativeId: string, jobId: string): engine.NativeSession {
  const observer = process.env.SPEC_DELIVERY_HOST_OBSERVER;
  engine.ensure(observer && path.isAbsolute(observer) && fs.statSync(observer).isFile(),
    '宿主未提供可信原生会话查询适配器 SPEC_DELIVERY_HOST_OBSERVER');
  const output = command(path.dirname(statePath), observer, ['observe', nativeId, jobId]);
  const raw = JSON.parse(output) as engine.NativeSession;
  engine.ensure(raw?.source === 'native_host' && raw.jobId === jobId && !!raw.observationId &&
    raw.nativeId === nativeId && !!raw.provider && !!raw.model && Number.isFinite(Date.parse(raw.observedAt)),
    '宿主适配器未返回当前原生会话的可核对观测');
  if (raw.context) engine.ensure(!!raw.context.contextId && !!raw.context.proofId &&
    ['new','resumed'].includes(raw.context.mode) &&
    (raw.context.mode !== 'resumed' || !!raw.context.resumedFromContextId),
    '宿主上下文观测不完整');
  const evidenceDigest = sha(output);
  const directory = path.join(path.dirname(statePath), 'host-observations');
  fs.mkdirSync(directory, { recursive: true });
  const evidencePath = path.join(directory, `${sha(jobId + ':' + nativeId).slice(0, 20)}-${evidenceDigest.slice(0, 20)}.json`);
  if (!fs.existsSync(evidencePath)) fs.writeFileSync(evidencePath, output + '\n', { flag: 'wx', mode: 0o444 });
  else engine.ensure(fs.readFileSync(evidencePath, 'utf8').trimEnd() === output, '原生会话观测归档发生冲突');
  return { source: 'native_host', observationId: raw.observationId, jobId, nativeId: raw.nativeId,
    provider: raw.provider, model: raw.model, observedAt: raw.observedAt, evidencePath, evidenceDigest,
    context: raw.context };
}
function verifySessionArtifact(session: engine.NativeSession) {
  engine.ensure(sha(fs.readFileSync(safeFile(session.evidencePath), 'utf8').trimEnd()) === session.evidenceDigest,
    '宿主原生会话观测归档已改变');
}
function skillObservation(statePath: string, operation: 'capabilities' | 'result', id: string, jobId: string) {
  const observer = process.env.SPEC_DELIVERY_SKILL_OBSERVER;
  engine.ensure(observer && path.isAbsolute(observer) && fs.statSync(observer).isFile(),
    '宿主未提供可信技能调用查询适配器 SPEC_DELIVERY_SKILL_OBSERVER');
  const output = command(path.dirname(statePath), observer, [operation, id, jobId]);
  const raw = JSON.parse(output) as Record<string, unknown>;
  engine.ensure(raw?.source === 'native_host' && raw.jobId === jobId, '技能宿主观测不属于当前 job');
  const directory = path.join(path.dirname(statePath), 'skill-observations');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${sha(`${operation}:${id}:${jobId}`).slice(0, 20)}-${sha(output).slice(0, 20)}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, output + '\n', { flag: 'wx', mode: 0o444 });
  else engine.ensure(fs.readFileSync(file, 'utf8').trimEnd() === output, '技能宿主观测归档发生冲突');
  return { raw, file };
}
function artifactFingerprint(files: string[]) {
  const unique = [...new Set(files.map(file => path.resolve(file)))];
  return { files: unique, digest: sha(JSON.stringify(unique.map(file => ({ file, digest: sha(fs.readFileSync(safeFile(file))) })))) };
}
function verifyHandoffRef(j: engine.Job) {
  if (!j.handoffRef) return;
  const ref=j.handoffRef;
  engine.ensure(ref.appliedCandidateVersion===j.candidateVersion && sha(fs.readFileSync(safeFile(ref.path)))===ref.sha256 &&
    sha(fs.readFileSync(safeFile(ref.verificationPath)))===ref.verificationDigest,
    '已转发的交接原文或 L1 核验记录已改变');
  verifySessionArtifact(ref.verifiedBy);
}
function handoffSuccessor(s:engine.State,id:string) {
  const j=s.jobs.find(x=>x.id===id);
  engine.ensure(j && active(j) && j.executor==='agent' && j.contextIntent?.kind==='continue' &&
    j.contextObservation?.mode==='new' && !j.fresh, '只有未续接的在途后继 actor 需要交接');
  const previous=s.jobs.find(x=>x.id===(j.contextIntent!.predecessorJobId || j.contextIntent!.parentJobId));
  engine.ensure(previous && previous.session, '前序 actor 身份缺失');
  engine.ensure(!j.handoffRef, '此后继 actor 已取得交接；不能覆盖原记录');
  engine.ensure(j.candidateVersion===engine.candidateVersion(s,j.ticket==='$spec'?undefined:s.tickets.find(t=>t.key===j.ticket)),
    '交接目标候选已过期');
  return {j,previous};
}
function verifiedHandoffL1(s:engine.State,statePath:string,j:engine.Job,nativeId:string) {
  const session=nativeSession(statePath,nativeId,`$handoff:${j.id}`);
  engine.verifyNativeSession(s,session,nativeId,'L1');verifySessionArtifact(session);
  engine.ensure(session.context?.mode==='new' && !s.jobs.some(x=>x.contextObservation?.contextId===session.context?.contextId),
    '交接核验须由独立的新 L1 上下文完成');
  engine.ensure(s.mainSession?.source!=='native_host'||s.mainSession.context?.contextId!==session.context.contextId,
    '主会话不能冒充独立 L1 交接核验');
  return session;
}
function handoffSourceLinks(links:unknown, original:string) {
  engine.ensure(Array.isArray(links)&&links.length>0&&links.every(x=>typeof x==='string'&&x.length>0),
    '交接须指向可定位的原始依据');
  for(const link of links as string[]) {
    engine.ensure(original.includes(link),'交接原文缺少所声明的原始依据引用');
    if(/^https:\/\//.test(link)) {const url=new URL(link);engine.ensure(!url.username&&!url.password&&!url.search,
      '交接引用不能携带凭据或查询参数');}
    else safeFile(link);
  }
}
function forwardOriginalHandoff(s:engine.State,statePath:string,id:string,request:{invocationId:string;decisionNativeId:string;
  verificationPath:string;expectedCandidateVersion:string}) {
  const {j,previous}=handoffSuccessor(s,id);
  engine.ensure(request.expectedCandidateVersion===j.candidateVersion,'L1 交接核验使用过期候选');
  const invocation=s.v3?.skillInvocations.find(i=>i.id===request.invocationId);
  engine.ensure(invocation && invocation.jobId===previous.id && invocation.capability==='handoff' &&
    invocation.session.nativeId===previous.nativeId && invocation.result?.status==='pass' &&
    !invocation.result.blocking && !!invocation.result.rawOutputPath,
    '原 actor 未实际完成已绑定的 handoff 技能调用');
  skills.verifySkillResultFiles(s,previous,[invocation.id],invocation.result.rawOutputPath);
  const original=fs.readFileSync(invocation.result.rawOutputPath,'utf8');
  engine.ensure(/suggested skills/i.test(original),'原始 handoff 缺少 suggested skills 章节');
  const verificationPath=path.resolve(request.verificationPath), verification=read<{jobId:string;candidateVersion:string;
    head:string;base:string;sourceJobId:string;sourceHead:string;sourceBase:string;originalPath:string;
    originalSha256:string;sourceLinks:string[]}>(safeFile(verificationPath));
  engine.ensure(verification.jobId===j.id&&verification.candidateVersion===j.candidateVersion&&
    verification.head===j.head&&verification.base===j.base&&verification.sourceJobId===previous.id&&
    verification.sourceHead===previous.head&&verification.sourceBase===previous.base&&
    verification.originalPath===invocation.result.rawOutputPath&&
    verification.originalSha256===invocation.result.rawOutputSha256,
    'L1 交接核验未绑定来源、原文及当前候选');
  handoffSourceLinks(verification.sourceLinks,original);
  const session=verifiedHandoffL1(s,statePath,j,request.decisionNativeId);
  const at=new Date().toISOString();
  j.handoffRef={kind:'original',sourceJobId:previous.id,sourceCandidateVersion:previous.candidateVersion || '',
    appliedCandidateVersion:j.candidateVersion!,path:invocation.result.rawOutputPath,
    sha256:invocation.result.rawOutputSha256,verificationPath,
    verificationDigest:sha(fs.readFileSync(verificationPath)),verifiedBy:session,at,invocationId:invocation.id};
  const artifact=artifactFingerprint([j.handoffRef.path,verificationPath]);
  engine.recordL1Decision(s,{id:`handoff:${j.id}:${randomUUID()}`,kind:'handoff-verification',scope:j.id,
    inputVersion:engine.inputVersion(s),sourceVersion:s.planSourceVersion,candidateVersion:j.candidateVersion!,
    artifactPath:verificationPath,artifactFiles:artifact.files,artifactDigest:artifact.digest,session,at});
  write(path.join(path.dirname(statePath),'jobs',sha(j.id).slice(0,20),'context-reference.json'),j.handoffRef);
  engine.event(s,`${j.id} 转发原 actor handoff 原文及 L1 核验引用`);
  return j.handoffRef;
}
function unavailableOriginal(statePath:string,previous:engine.Job) {
  const observer=process.env.SPEC_DELIVERY_HOST_OBSERVER;
  engine.ensure(observer&&path.isAbsolute(observer)&&fs.statSync(observer).isFile(),
    '缺少可信宿主状态查询，不能宣称原 actor 已不可恢复');
  const output=command(path.dirname(statePath),observer,['availability',previous.nativeId,previous.id]);
  const raw=JSON.parse(output) as {source:string;nativeId:string;jobId:string;state:string;observationId:string;observedAt:string};
  engine.ensure(raw.source==='native_host'&&raw.nativeId===previous.nativeId&&raw.jobId===previous.id&&
    raw.state==='unavailable'&&!!raw.observationId&&Number.isFinite(Date.parse(raw.observedAt)),
    '宿主未证实原 actor 不可恢复');
  const file=path.join(path.dirname(statePath),'host-observations',`unavailable-${sha(previous.id+output).slice(0,24)}.json`);
  if(!fs.existsSync(file))fs.writeFileSync(file,output+'\n',{flag:'wx',mode:0o444});
  else engine.ensure(fs.readFileSync(file,'utf8').trimEnd()===output,'原 actor 状态证据已改变');
  return file;
}
function reconstructHandoff(s:engine.State,statePath:string,id:string,request:{decisionNativeId:string;
  expectedCandidateVersion:string;reconstructedPath:string}) {
  const {j,previous}=handoffSuccessor(s,id);
  engine.ensure(request.expectedCandidateVersion===j.candidateVersion,'L1 重建交接使用过期候选');
  engine.ensure(!s.v3?.skillInvocations.some(i=>i.jobId===previous.id&&i.capability==='handoff'&&
    i.result?.status==='pass'&&!i.result.blocking), '原 actor handoff 原文已归档，应核验并转发原文');
  const unavailableEvidencePath=unavailableOriginal(statePath,previous);
  const reconstructedPath=path.resolve(request.reconstructedPath);
  const raw=read<{kind:string;jobId:string;sourceJobId:string;candidateVersion:string;head:string;base:string;
    sourceLinks:string[];unknowns:string[];suggestedSkills:string[];reason:string}>(safeFile(reconstructedPath));
  engine.ensure(raw.kind==='l1_reconstructed'&&raw.jobId===j.id&&raw.sourceJobId===previous.id&&
    raw.candidateVersion===j.candidateVersion&&raw.head===j.head&&raw.base===j.base&&raw.reason&&
    Array.isArray(raw.unknowns)&&raw.unknowns.length>0&&raw.unknowns.every(x=>typeof x==='string'&&x.trim())&&
    Array.isArray(raw.suggestedSkills)&&raw.suggestedSkills.length>0,
    'L1 重建必须标明未知项、当前候选和建议技能，不能冒称原 actor 交接');
  handoffSourceLinks(raw.sourceLinks,fs.readFileSync(reconstructedPath,'utf8'));
  const session=verifiedHandoffL1(s,statePath,j,request.decisionNativeId);
  const archived=path.join(path.dirname(statePath),'handoffs',`${sha(j.id).slice(0,20)}-reconstructed.json`);
  fs.mkdirSync(path.dirname(archived),{recursive:true});
  if(!fs.existsSync(archived))fs.copyFileSync(reconstructedPath,archived,fs.constants.COPYFILE_EXCL);
  else engine.ensure(fs.readFileSync(archived).equals(fs.readFileSync(reconstructedPath)),'重建交接归档不能覆盖');
  const at=new Date().toISOString();
  j.handoffRef={kind:'reconstructed',sourceJobId:previous.id,sourceCandidateVersion:previous.candidateVersion || '',
    appliedCandidateVersion:j.candidateVersion!,path:archived,sha256:sha(fs.readFileSync(archived)),
    verificationPath:reconstructedPath,verificationDigest:sha(fs.readFileSync(reconstructedPath)),
    verifiedBy:session,unavailableEvidencePath,unknowns:raw.unknowns,at};
  const artifact=artifactFingerprint([archived,reconstructedPath,unavailableEvidencePath]);
  engine.recordL1Decision(s,{id:`handoff-reconstructed:${j.id}:${randomUUID()}`,kind:'handoff-verification',scope:j.id,
    inputVersion:engine.inputVersion(s),sourceVersion:s.planSourceVersion,candidateVersion:j.candidateVersion!,
    artifactPath:reconstructedPath,artifactFiles:artifact.files,artifactDigest:artifact.digest,session,at});
  write(path.join(path.dirname(statePath),'jobs',sha(j.id).slice(0,20),'context-reference.json'),j.handoffRef);
  engine.event(s,`${j.id} 原 actor 不可恢复；L1 依据持久证据重建并标明未知项`);
  return j.handoffRef;
}
function decisionArtifacts(s: engine.State, j: engine.Job, r: engine.Result) {
  const t = s.tickets.find(t => t.key === j.ticket);
  const files = [r.evidencePath];
  if (r.complete && ['plan', 'replan'].includes(j.action)) files.push(String(r.data?.planPath || ''), String(r.data?.checksPath || ''));
  if (r.complete && j.action === 'plan-check') files.push(t?.planPath || '', String(r.data?.checksPath || t?.checksPath || ''));
  return artifactFingerprint(files);
}
function ensureDecisionArtifacts(s: engine.State, t: engine.Ticket, kind: engine.L1DecisionRecord['kind'], current = true) {
  if (s.protocol !== engine.currentProtocol || !s.planEvidence) return;
  const record = s.v3?.decisionRecords.findLast(d => d.kind === kind && d.scope === t.key &&
    d.inputVersion === engine.inputVersion(s) && d.sourceVersion === s.planSourceVersion &&
    (!current || (d.appliesToCandidateVersion || d.candidateVersion) === engine.candidateVersion(s, t)));
  engine.ensure(record && artifactFingerprint(record.artifactFiles).digest === record.artifactDigest,
    `#${t.number} 的 ${kind} 决策产物已过期或被修改`);
}
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
  if (j.action === 'skill-child') {
    engine.event(s, `${j.id} 技能子任务回执待修复：${error.message}`);
    return;
  }
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
  const v3 = engine.initialProtocolV3();
  v3.skillBindings = skills.defaultSkillBindings();
  const s: engine.State = { schema: 1, protocol: engine.currentProtocol, v3, id: randomUUID(), revision: 0, inputs, spec, repo, status: 'planning', tickets: [], jobs: [],
    specCriteria: [], planEvidence: '', auditEpoch: 1, events: [], mainSession: { source: 'unknown', at: new Date().toISOString() },
    facts: { base, issueStates: Object.fromEntries([parent, ...children].map(i => [String(i.number), i.state])), prs: {}, at: new Date().toISOString() } };
  if (process.env.SPEC_DELIVERY_MAIN_NATIVE_ID) {
    try { s.mainSession = nativeSession(file, process.env.SPEC_DELIVERY_MAIN_NATIVE_ID, '$main'); }
    catch { s.mainSession = { source: 'unknown', at: new Date().toISOString() }; }
  }
  engine.event(s, '读取当前仓库和既有 spec/sub-issues；等待真实 L1 会话制定执行安排');
  fs.mkdirSync(path.dirname(file), { recursive: true }); const release = lock(file);
  try { engine.ensure(!fs.existsSync(file), '另一个主控已启动这个 spec'); save(file, s); } finally { release(); }
  const snapshot = path.join(path.dirname(file), 'initial-sources.json'); write(snapshot, { parent, children });
  return { statePath: file, sourcesPath: snapshot, rolesPath,
    decisionContext: { inputVersion: engine.inputVersion(s), sourceVersion: sourceVersion(parent, children) },
    next: '宿主转发给真实 L1 会话；L1 读取来源并生成 ExecutionPlan 后调用 plan',
    resources: { cpus: os.availableParallelism(), freeMemoryBytes: os.freemem(), loadAverage: os.loadavg() } };
}
export function packet(s: engine.State, j: engine.Job, statePath: string) {
  const t = s.tickets.find(t => t.key === j.ticket);
  const child = j.childRequestId ? s.v3?.skillChildren?.find(x => x.id === j.childRequestId) : undefined;
  const resumableSkill=s.v3?.skillInvocations.find(i=>!i.result && i.jobId!==j.id &&
    s.jobs.some(old=>old.id===i.jobId&&old.status==='cancelled'&&old.ticket===j.ticket&&
      old.epoch===j.epoch&&old.action===j.action&&old.candidateVersion===j.candidateVersion));
  const out = path.join(path.dirname(statePath), 'jobs', sha(j.id).slice(0, 20));
  const authored = ['implement', 'publish', 'integrate', 'replan'].includes(j.action);
  const freshInitial = j.fresh && j.action === 'review-lens';
  const freshChild = !!child && j.fresh;
  const prior = (child || freshInitial ? [] : s.jobs.filter(x => x.ticket === j.ticket && x.status === 'done' && x.result &&
    (j.action === 'review-report' ? x.epoch === j.epoch && ['review-lens', 'confirm', 'adjudicate'].includes(x.action)
      : !j.fresh && (authored || ['review-lens', 'confirm', 'review-report'].includes(x.action)))))
    .map(x => { archiveResult(statePath,x); return { action: x.action, epoch: x.epoch, head: x.head, base: x.base, status: x.result!.status,
      resultPath: resultPaths(statePath,x.id).result }; });
  // 旧结果保持完整归档；每次派发只带当前轮的索引，完整历史按需读取。
  const relevant = prior.filter(x => x.epoch === j.epoch || x.head === j.head);
  const priorPath = path.join(out, 'prior-index.json');
  if (!freshInitial && !freshChild) write(priorPath, prior);
  const objective = j.fresh && (child || ['review-lens', 'confirm'].includes(j.action))
    ? { tests: t?.evidence.tests, visual: t?.evidence.visual } : t?.evidence || {};
  return { jobId: j.id, action: j.action, tier: j.tier, model: j.model, executor: j.executor, fresh: j.fresh, contextKey: j.contextKey,
    contextIntent:j.contextIntent || null, contextObservation:j.contextObservation || null,
    contextReferencePath:path.join(out,'context-reference.json'),
    handoffRef:freshInitial || freshChild ? null : j.handoffRef || null,
    skillChild: child ? { requestId: child.id, parentInvocationId: child.parentInvocationId,
      instruction: child.instruction, required: child.required, independent: child.independent,
      candidateVersion: child.candidateVersion, inputVersion: child.inputVersion,
      skillCapability: child.skillCapability || null, dependencyFingerprint: child.dependencyFingerprint || null,
      resultStatuses: ['completed', 'failed', 'incomplete'] } : null,
    skillResume: resumableSkill ? { invocationId: resumableSkill.id, command: 'skill-resume',
      sourceArchivePath: resumableSkill.sourceArchivePath,
      note: '旧宿主已确认停止；先以新原生会话及宿主能力续接此调用，读取已完成子结果，不重跑。' } : null,
    dispatchToken: j.dispatchToken || '',
    inputVersion: j.inputVersion || '', candidateVersion: j.candidateVersion || '',
    repo: s.repo, spec: s.spec, issue: t?.number || s.spec, targetBranch: s.inputs.targetBranch,
    branch: t?.branch || '', worktree: t?.worktree || '', pr: t?.pr || 0, expectedHead: j.head, expectedBase: j.base,
    criteria: t?.criteria || s.specCriteria, visualRequired: t?.visual || false, closeout: t?.closeout || false,
    blockingReason: j.fresh && (child || ['review-lens','confirm'].includes(j.action)) ? '' : t?.reason || t?.lastProblem || '',
    planPath: j.fresh && j.action !== 'plan-check' ? '' : t?.planPath || '',
    checksPath: freshInitial || freshChild ? '' : t?.checksPath || '',
    handoffPath: j.fresh && j.action !== 'replan' ? '' : authored ? t?.handoffPath || '' : t?.reviewHandoff || '',
    sourceUrl: `https://${s.repo.host}/${s.repo.slug}/issues/${t?.number || s.spec}`,
    objectiveEvidence: objective, prior: relevant.slice(-20), historyIndexPath: freshInitial || j.fresh && j.action !== 'review-report' ? '' : priorPath,
    rawSources: freshInitial ? {specUrl:`https://${s.repo.host}/${s.repo.slug}/issues/${s.spec}`,
      issueUrl:`https://${s.repo.host}/${s.repo.slug}/issues/${t?.number || s.spec}`,
      candidate:{head:j.head,base:j.base,worktree:t?.worktree || ''},tests:t?.evidence.tests || null,
      visual:t?.evidence.visual || null,standards:['AGENTS.md','CLAUDE.md'].map(name=>path.join(s.repo.root,name)).filter(fs.existsSync)} : null,
    finding: freshInitial ? null : j.finding || null,
    dispute: freshInitial ? null : j.dispute ? Object.fromEntries(Object.entries(j.dispute).map(([key, id]) => [key, resultPaths(statePath, id).result])) : null,
    remainingWork: j.ticket === '$spec' ? s.tickets.map(x => ({number:x.number,phase:x.phase,dependencies:x.dependencies,reason:x.reason})) : [],
    lens: j.action === 'review-lens' ? engine.lenses[Number(j.part)] : '',
    skillBindings: s.v3?.skillBindings?.map(b => ({ capability: b.capability, name: b.name,
      sourcePath: b.sourcePath, fingerprint: b.fingerprint })) || [],
    skillCall: child?.skillCapability
      ? { capabilities: [child.skillCapability], command: 'skill-start', finishCommand: 'skill-finish',
          resultField: 'data.skillInvocationIds', note: '通过已固定的能力绑定调用引用技能，并提交原始宿主回执。' }
      : j.action === 'implement'
      ? { capabilities: ['implementation', 'diagnosis', 'handoff'], command: 'skill-start',
          finishCommand: 'skill-finish', resultField: 'data.skillInvocationIds',
          note: '按计划显式调用已绑定 implement 或 diagnosing-bugs；完成候选后显式调用原始 handoff。宿主执行真实技能后提交外围回执。' }
      : null,
    rolesPath, outputDirectory: out, resultPath: path.join(out, 'result.json'),
    resourceGrant: { agentSlots: j.executor === 'agent' ? 1 : 0, testBatches: j.tests, nestedAgents: false },
    note: child ? '执行技能请求的本子任务；独立上下文要求由宿主证明。不要派隐藏 agent；以 completed、failed 或 incomplete 返回结果。' :
      '读角色约束与来源；仅执行本 job。main loop 和并行审查由内核调度，agent 不自行派隐藏子 agent。' };
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
  verifyHandoffRef(j);
  safeFile(r.evidencePath);
  if (r.handoffPath) safeFile(r.handoffPath);
  if (s.v3?.skillBindings && r.data?.skillInvocationIds) {
    engine.ensure(Array.isArray(r.data.skillInvocationIds) && r.data.skillInvocationIds.every(x => typeof x === 'string'),
      '技能调用引用必须是 ID 数组');
    skills.verifySkillResultFiles(s, j, r.data.skillInvocationIds as string[], r.handoffPath);
  }
  const t = s.tickets.find(t => t.key === j.ticket); if (!t || !r.complete) return;
  engine.ensure(t.phase !== 'recovery', '工作区尚在恢复，原任务回执不能签发新候选证据');
  if (j.action === 'plan-check' && s.planEvidence) {
    const planned = s.v3?.decisionRecords.findLast(d => ['ticket-plan', 'replan'].includes(d.kind) &&
      d.scope === t.key && d.inputVersion === engine.inputVersion(s) && d.sourceVersion === s.planSourceVersion &&
      (d.appliesToCandidateVersion || d.candidateVersion) === engine.candidateVersion(s, t));
    engine.ensure(planned && artifactFingerprint(planned.artifactFiles).digest === planned.artifactDigest,
      `#${t.number} 的 L1 计划产物已过期或被修改`);
  }
  if (j.action === 'implement') ensureDecisionArtifacts(s, t, 'plan-check');
  if (j.action === 'verify') ensureDecisionArtifacts(s, t, 'plan-check', false);
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
  ensureDecisionArtifacts(s, t, 'plan-check', false);
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
type HostState = 'not_found' | 'running' | 'completed' | 'cancelled' | 'unknown';
interface HostReply {
  token: string; jobId: string; targetHost: string; state: HostState;
  nativeId?: string; authoritative?: boolean; result?: unknown; startedAt?: string; completedAt?: string;
  cancelledAt?: string; usage?: engine.Json;
}
interface HostCall { ref: engine.HostEventRef; reply?: HostReply; error?: string }
/** The adapter is a trusted host process. Its raw reply is archived before it can change the ledger. */
function callHost(statePath: string, d: engine.DispatchRecord, kind: engine.HostEventRef['kind']): HostCall {
  engine.ensure(sha(fs.readFileSync(safeFile(d.requestPath)))===d.requestDigest,
    '持久派发请求已改变；禁止向宿主发送未签发的 token/model/job');
  const adapter = process.env.SPEC_DELIVERY_HOST_ADAPTER;
  engine.ensure(adapter && path.isAbsolute(adapter) && fs.statSync(adapter).isFile(),
    '宿主未提供可信派发适配器 SPEC_DELIVERY_HOST_ADAPTER');
  const run = spawnSync(adapter, [kind, d.requestPath], { cwd: path.dirname(statePath), encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const at = new Date().toISOString();
  const raw = { kind, requestPath: d.requestPath, at, exitCode: run.status, signal: run.signal,
    stdout: run.stdout || '', stderr: run.stderr || '', spawnError: run.error?.message || null };
  const bytes = JSON.stringify(raw, null, 2) + '\n', digest = sha(bytes);
  const evidencePath = path.join(path.dirname(statePath), 'host-events', sha(d.token).slice(0, 20), `${at.replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const fd = fs.openSync(evidencePath, 'wx', 0o444);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const ref = { kind, evidencePath, digest, at };
  if (run.status !== 0) return { ref, error: `宿主 ${kind} 未确认：${run.error?.message || run.stderr || run.status}` };
  try { return { ref, reply: JSON.parse(run.stdout) as HostReply }; }
  catch { return { ref, error: `宿主 ${kind} 响应不是 JSON` }; }
}
function journalBoundSession(s: engine.State, j: engine.Job) {
  const d = s.v3?.dispatchRecords.find(x => x.jobId === j.id); if (!d || !j.session) return;
  const at = new Date().toISOString();
  let instance = d.instances.find(x => x.nativeId === j.nativeId);
  if (!instance) { instance = { key: `native:${j.nativeId}`, nativeId: j.nativeId, state: 'running',
    firstSeenAt: at, lastSeenAt: at, events: [] }; d.instances.push(instance); }
  instance.session = j.session; instance.state = j.status === 'done' ? 'completed' : 'running'; instance.lastSeenAt = at;
  const observationRef: engine.HostEventRef = {kind:'query',evidencePath:j.session.evidencePath,
    digest:sha(fs.readFileSync(j.session.evidencePath)),at:j.session.observedAt};
  if(!instance.events.some(x=>x.evidencePath===observationRef.evidencePath))instance.events.push(observationRef);
  d.nativeId = j.nativeId; d.status = j.status === 'done' ? 'completed' : 'running'; d.updatedAt = at;
}
/** A bad or unbound host reply is still an instance/event in the journal. */
function applyHostCall(statePath: string, jobId: string, call: HostCall): {state: HostState | 'uncertain'; nativeId?: string; result?: unknown; error?: string} {
  const release = lock(statePath);
  try {
    const s = read<engine.State>(statePath); requireProtocol(s);
    const d = s.v3!.dispatchRecords.find(x => x.jobId === jobId), j = s.jobs.find(x => x.id === jobId);
    engine.ensure(d && j, '派发任务不存在');
    d.events.push(call.ref); d.updatedAt = call.ref.at;
    const reply = call.reply;
    const key = reply?.nativeId ? `native:${reply.nativeId}` : `token:${d.token}`;
    let instance = d.instances.find(x => x.key === key);
    if (!instance) { instance = { key, nativeId: reply?.nativeId || null, state: 'unknown',
      firstSeenAt: call.ref.at, lastSeenAt: call.ref.at, events: [] }; d.instances.push(instance); }
    instance.events.push(call.ref); instance.lastSeenAt = call.ref.at;
    if (reply?.usage !== undefined) instance.rawUsage = reply.usage;
    for(const field of ['startedAt','completedAt','cancelledAt'] as const) if(reply?.[field]) {
      if(Number.isFinite(Date.parse(reply[field]!))) instance[field] ||= reply[field];
    }
    let error = call.error;
    if (!error) {
      if (!reply || reply.token !== d.token || reply.jobId !== d.jobId || reply.targetHost !== d.targetHost ||
        !['not_found','running','completed','cancelled','unknown'].includes(reply.state))
        error = '宿主响应的 token、job、目标宿主或状态与持久请求不符';
      else if (['running','completed','cancelled'].includes(reply.state) && !reply.nativeId)
        error = '宿主终态缺少原生实例身份';
      else if (reply.nativeId && d.nativeId && reply.nativeId !== d.nativeId)
        error = '同一派发 token 返回了另一原生身份';
      else if (reply.state === 'not_found' && (!reply.authoritative || !!d.nativeId || d.instances.some(i=>!!i.nativeId)))
        error = '宿主不能权威确认 token 未启动，或此前已观测的实例消失';
      else if (reply.state === 'unknown') error = '宿主无法判明派发是否已启动';
    }
    if (!error && reply && ['running','completed','cancelled'].includes(reply.state)) {
      instance.state = reply.state as engine.HostInstanceRecord['state'];
      try {
        const session = j.session && j.nativeId === reply.nativeId ? j.session : nativeSession(statePath, reply.nativeId!, j.id);
        verifySessionArtifact(session);
        if (j.status === 'leased' || j.status === 'running') engine.bind(s, j.id, { nativeId: reply.nativeId!, session });
        else engine.ensure(j.nativeId === reply.nativeId, '已完成任务的宿主身份不能改变');
        instance.session = session; d.nativeId = reply.nativeId;
        if (reply.startedAt && Number.isFinite(Date.parse(reply.startedAt))) {
          j.timing ??= { leasedAt: '' }; j.timing.startedAt ??= reply.startedAt;
        }
      } catch (e) { error = (e as Error).message; instance.bindingError = error; }
    }
    if (error) { d.status = 'uncertain'; d.uncertainty = error; instance.bindingError = error;
      instance.state = reply && ['running','completed','cancelled'].includes(reply.state)
        ? reply.state as engine.HostInstanceRecord['state'] : 'unknown'; }
    else if (reply) { d.status = reply.state === 'not_found' ? 'prepared' : reply.state === 'unknown' ? 'uncertain' : reply.state;
      d.uncertainty = undefined; if (reply.state === 'not_found') instance.state = 'requested'; }
    if (reply?.state === 'completed' && !error) instance.state = 'completed';
    engine.event(s, error ? `${jobId} 宿主派发状态不确定：${error}` : `${jobId} 宿主 ${call.ref.kind}：${reply!.state}`);
    save(statePath, s);
    return error ? { state: 'uncertain', nativeId: reply?.nativeId, error } : { state: reply!.state, nativeId: reply!.nativeId, result: reply!.result };
  } finally { release(); }
}
function dispatchRound(statePath: string, jobId: string, launch: boolean) {
  const release = lock(statePath);
  let request: engine.DispatchRecord;
  try {
    const s = read<engine.State>(statePath); requireProtocol(s);
    const j = s.jobs.find(x => x.id === jobId), d = s.v3!.dispatchRecords.find(x => x.jobId === jobId);
    engine.ensure(j && d && j.executor === 'agent', '任务尚未预留派发意图');
    if (j.status === 'done') return { jobId, status: 'completed', nativeId: j.nativeId };
    engine.ensure(active(j) && !recovering(s,j), '任务已终止或工作区正在恢复');
    if (j.nativeId && !d.managed) return {jobId,status:'running',nativeId:j.nativeId,manualBinding:true};
    if (launch && d.status === 'cancelled') return {jobId,status:'cancelled',nativeId:d.nativeId || null};
    if (!launch && !d.managed) return { jobId, status: d.status, nativeId: d.nativeId || null };
    if (d.operationPid && d.operationPid !== process.pid && processAlive(d.operationPid))
      return { jobId, status: d.status, inProgress: true };
    d.operationPid = process.pid; d.managed = true; d.updatedAt = new Date().toISOString();
    if (launch && d.status === 'prepared') d.status = 'starting';
    engine.event(s, `${jobId} 派发查询已登记；先按持久 token 查找宿主实例`);
    save(statePath, s); request = structuredClone(d);
  } finally { release(); }
  try {
    let outcome = applyHostCall(statePath, jobId, callHost(statePath, request!, 'query'));
    if (outcome.state === 'not_found' && launch) {
      // Only an authoritative negative token lookup permits another start after a lost acknowledgement.
      const rel = lock(statePath);
      try { const s = read<engine.State>(statePath), d = s.v3!.dispatchRecords.find(x => x.jobId === jobId)!;
        engine.ensure(d.operationPid === process.pid && d.status === 'prepared', '派发查询期间状态已改变');
        d.status = 'starting'; d.updatedAt = new Date().toISOString();
        engine.event(s, `${jobId} 已确认 token 不存在；启动请求前持久化 starting`); save(statePath,s);
      } finally { rel(); }
      outcome = applyHostCall(statePath, jobId, callHost(statePath, request!, 'start'));
    }
    if (outcome.state === 'completed') {
      if (outcome.result === undefined) outcome = applyHostCall(statePath, jobId, callHost(statePath, request!, 'collect'));
      if (outcome.state === 'completed' && outcome.result !== undefined) {
        try {
          const receipt = stageResult(statePath, jobId, outcome.result);
          engine.ensure(!receipt.rejected.length, `宿主完成结果未通过回执核验：${JSON.stringify(receipt.rejected)}`);
        }
        catch (e) {
          const rel = lock(statePath);
          try { const s = read<engine.State>(statePath), d = s.v3!.dispatchRecords.find(x => x.jobId === jobId)!;
            d.status = 'uncertain'; d.uncertainty = `宿主结果已归档但回执未被接受：${(e as Error).message}`;
            engine.event(s, `${jobId} 结果待核对：${d.uncertainty}`); save(statePath, s);
          } finally { rel(); }
          return { jobId, status: 'uncertain', error: (e as Error).message };
        }
      } else if (outcome.state === 'completed') {
        const rel=lock(statePath);
        try {const s=read<engine.State>(statePath),d=s.v3!.dispatchRecords.find(x=>x.jobId===jobId)!;
          d.status='uncertain';d.uncertainty='宿主报告完成但未返回任务结果';
          engine.event(s,`${jobId} 完成回执待查询`);save(statePath,s);
        } finally {rel();}
        return {jobId,status:'uncertain',error:'宿主报告完成但未返回任务结果'};
      }
    }
    return { jobId, status: outcome.state, nativeId: outcome.nativeId || null, error: outcome.error || null };
  } catch (e) {
    const rel = lock(statePath);
    try { const s = read<engine.State>(statePath), d = s.v3?.dispatchRecords.find(x => x.jobId === jobId);
      if (d) { d.status = 'uncertain'; d.uncertainty = `宿主操作中断：${(e as Error).message}`;
        engine.event(s, `${jobId} 派发状态不确定：${d.uncertainty}`); save(statePath,s); }
    } finally { rel(); }
    return { jobId, status: 'uncertain', error: (e as Error).message };
  } finally {
    const rel = lock(statePath);
    try { const s = read<engine.State>(statePath), d = s.v3?.dispatchRecords.find(x => x.jobId === jobId);
      if (d?.operationPid === process.pid) { delete d.operationPid; save(statePath, s); }
    } finally { rel(); }
  }
}
function cancelDispatch(statePath:string,jobId:string) {
  const observed=dispatchRound(statePath,jobId,false);
  if(observed.status!=='running')return observed;
  const release=lock(statePath);let request:engine.DispatchRecord;
  try {const s=read<engine.State>(statePath),d=s.v3?.dispatchRecords.find(x=>x.jobId===jobId);
    engine.ensure(d && d.managed && d.status==='running','取消前须查询到当前运行实例');
    engine.ensure(!d.operationPid || !processAlive(d.operationPid),'另一个宿主操作仍在进行');
    d.operationPid=process.pid;d.updatedAt=new Date().toISOString();save(statePath,s);request=structuredClone(d);
  } finally {release();}
  try {const outcome=applyHostCall(statePath,jobId,callHost(statePath,request!,'cancel'));
    return {jobId,status:outcome.state,nativeId:outcome.nativeId||null,error:outcome.error||null,
      note:'取消请求已归档；释放任务和写权仍须 reconcile 的进程树停止证据'};
  } finally {const rel=lock(statePath);try {const s=read<engine.State>(statePath),d=s.v3?.dispatchRecords.find(x=>x.jobId===jobId);
    if(d?.operationPid===process.pid){delete d.operationPid;save(statePath,s);}
  } finally {rel();}}
}
export function renderZcode(s: engine.State, statePath: string) {
  const jobs = s.jobs.filter(j => j.status === 'leased' && j.executor === 'agent' && !recovering(s, j) &&
    (!s.v3 || s.v3.dispatchRecords.find(d => d.jobId === j.id)?.status === 'prepared'));
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
    const jobs = s.jobs.filter(j => active(j) && j.nativeId && j.executor === 'agent' && engine.contextReady(j) &&
      s.tickets.find(t => t.key === j.ticket)?.phase !== 'recovery' && (!ids || ids.includes(j.id)) &&
      (!s.v3?.dispatchRecords.find(d => d.jobId === j.id)?.managed ||
        s.v3.dispatchRecords.find(d => d.jobId === j.id)?.status === 'completed') &&
      fs.existsSync(resultPaths(statePath, j.id).ready));
    if (!jobs.length) return { submitted: [], rejected: [] };
    s.facts = observe(s, jobs);
    const submitted: string[] = [], rejected: {jobId:string; error:string}[] = [];
    for (const j of jobs) {
      try {
        const r = normalizeResult(s, j, read(resultPaths(statePath, j.id).result));
        const trial = structuredClone(s), job = trial.jobs.find(x => x.id === j.id)!;
        if (trial.protocol === engine.currentProtocol) { engine.ensure(job.session, '模型任务缺少原生会话观测'); verifySessionArtifact(job.session); verifyHandoffRef(job); }
        engine.ensure(!job.testExecution,'测试进程未完成，不能提交任务');
        job.timing ??= {leasedAt:''}; job.timing.resultAt=read<{at:string}>(resultPaths(statePath,j.id).ready).at;
        if (trial.protocol === engine.currentProtocol && job.tier === 'L1') {
          const artifact = decisionArtifacts(trial, job, r);
          job.decisionArtifactDigest = artifact.digest; job.decisionArtifactFiles = artifact.files;
        }
        validateResult(trial, job, r); engine.submit(trial, job.id, r); journalBoundSession(trial, job); s = trial; submitted.push(j.id);
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
    if(engine.contextReady(j))verifyHandoffRef(j);
    const r = normalizeResult(s, j, value), files = resultPaths(statePath, id);
    if(j.status==='done') engine.ensure(JSON.stringify(j.result)===JSON.stringify(r),'已完成任务的回执不能改变');
    safeFile(r.evidencePath); if (r.handoffPath) safeFile(r.handoffPath);
    if (fs.existsSync(files.ready)) engine.ensure(JSON.stringify(normalizeResult(s,j,read(files.result))) === JSON.stringify(r),
      '同一任务的结果不能被覆盖');
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
export function bindBatch(statePath: string, binding: {runId:string; model?:string; jobs:{jobId:string; actorName:string}[]}) {
  const release = lock(statePath);
  try {
    const s = read<engine.State>(statePath); allowCompletion(s);
    engine.ensure(binding.runId && binding.jobs.length && new Set(binding.jobs.map(j=>j.jobId)).size === binding.jobs.length, '需要真实 runId 与不重复的任务清单');
    for (const item of binding.jobs) {
      engine.ensure(item.actorName, '需要原生 actor 的稳定名称');
      const j = s.jobs.find(j=>j.id===item.jobId), nativeId=`${binding.runId}/${item.actorName}`;
      engine.ensure(j && j.executor==='agent', '批次任务不属于模型 actor');
      const dispatch=s.v3?.dispatchRecords.find(d=>d.jobId===j.id);
      if(dispatch?.managed)engine.ensure(!dispatch.instances.some(i=>i.nativeId && i.nativeId!==nativeId),
        '持久 token 的原生实例身份不符；不能用批次模板覆盖');
      if (j.status === 'done') {
        engine.ensure(j.nativeId === nativeId, '已完成任务的身份不能被替换');
        if (j.session) verifySessionArtifact(j.session);
        continue;
      }
      if (j.nativeId && (s.protocol !== engine.currentProtocol || j.session)) {
        engine.ensure(j.nativeId === nativeId, '同一租约不能重复绑定另一任务');
        if (j.session) verifySessionArtifact(j.session);
        continue;
      }
      const session = s.protocol === engine.currentProtocol ? nativeSession(statePath, nativeId, j.id) : undefined;
      if (session) engine.ensure(session.nativeId === nativeId, '原生批次/actor 身份与宿主观测不符');
      else engine.ensure(j.model === binding.model, '批次实际模型与任务不符');
      engine.bind(s,j.id,{nativeId,model:binding.model,session});
      journalBoundSession(s,j);
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
    version:workflowVersion,readme: path.join(home, 'spec-delivery', 'README.md'), commands: ['version','summary <state.json>', 'init <input.json>', 'inspect <state>', 'plan-context <state>', 'decision-context <state>', 'plan <state> <plan.json>', 'observe-main <state> <native-id>', 'drive <state>', 'next <state>', 'dispatch <state> <jobId>', 'dispatch-cancel <state> <jobId>', 'bind <state> <jobId> <binding.json>', 'bind-batch <state> <binding.json>', 'context-handoff <state> <jobId> <verification.json>', 'context-reconstruct <state> <jobId> <reconstruction.json>', 'skill-start <state> <jobId> <host-capabilities.json>', 'skill-delegate <state> <invocationId> <children.json>', 'skill-continue <state> <invocationId>', 'skill-retry <state> <invocationId> <keys.json>', 'skill-resume <state> <invocationId> <resume.json>', 'skill-finish <state> <invocationId> <outcome.json>', 'migrate-skills <state> <migration.json>', 'stage <state> <jobId> <result-json>', 'collect <state> [jobId]', 'submit <state> <jobId> <result.json>', 'execute <state> <jobId>', 'test <state> <jobId> <request.json>', 'guard <state> <jobId>', 'reconcile <state> <host-status.json>', 'recover-workspace <state> <ticket> <decision.json>', 'resolve <state> <decisions.json>', 'reconfigure <state> <models.json>', 'upgrade <state> <evidence.json>', 'retire <state> <reason.json>', 'record-host <state> <observations.json>', 'metrics <state>', 'resume <state>', 'zcode <state>'] };
  engine.ensure(file, '缺少输入文件/状态路径');
  // summary 在 lock() 之前返回：只验证可读协议，不创建/等待/恢复/删除状态锁，也不进入写路径。
  if (op === 'summary') return summarizeLedger(path.resolve(file));
  if (op === 'init') return initialize(read<engine.Inputs>(file));
  // 历史读取不触发锁恢复、GitHub 观测或状态写入。
  if (op === 'inspect' || op === 'metrics') {
    const state = read<engine.State>(path.resolve(file)); supportedLedger(state);
    return op === 'inspect' ? { ...state, rolesPath } : metrics(state);
  }
  if (op === 'plan-context') {
    const s = read<engine.State>(path.resolve(file)); requireProtocol(s);
    engine.ensure(s.status === 'planning', '只在规划前读取来源版本');
    return { inputVersion: engine.inputVersion(s), sourceVersion: sourceVersion(gh.issue(s.repo, s.spec), gh.subIssues(s.repo, s.spec)) };
  }
  if (op === 'decision-context') {
    const s = read<engine.State>(path.resolve(file)); requireProtocol(s);
    return { inputVersion: engine.inputVersion(s), sourceVersion: s.planSourceVersion || null,
      tickets: s.tickets.map(t => ({ ticket: t.key, phase: t.phase, candidateVersion: engine.candidateVersion(s, t) })) };
  }
  if (op === 'execute') { engine.ensure(extra, '需要 command jobId'); return executeCommand(path.resolve(file), extra); }
  if (op === 'test') {engine.ensure(extra && fourth,'需要 jobId 与测试请求文件');return runTest(path.resolve(file),extra,read(fourth));}
  if (op === 'stage') {
    engine.ensure(extra && fourth, '需要 jobId 与结果 JSON 内容');
    const receipt=stageResult(path.resolve(file),extra,JSON.parse(fourth));
    engine.ensure(!receipt.rejected.length,`回执已保留但未通过核验：${JSON.stringify(receipt.rejected)}；主控核对，不重跑外部动作`);
    return receipt;
  }
  if (op === 'dispatch') { engine.ensure(extra, '需要 jobId'); return dispatchRound(path.resolve(file), extra, true); }
  if (op === 'dispatch-cancel') { engine.ensure(extra, '需要 jobId'); return cancelDispatch(path.resolve(file),extra); }
  if (op === 'collect') {
    const statePath = path.resolve(file), state = read<engine.State>(statePath); requireProtocol(state);
    const records = state.v3!.dispatchRecords.filter(d => d.managed && (!extra || d.jobId === extra) &&
      ['starting','running','completed','uncertain'].includes(d.status));
    const polled = records.map(d => dispatchRound(statePath, d.jobId, false));
    return { polled, ...consumeStaged(statePath, extra ? [extra] : undefined) };
  }
  if (op === 'bind-batch') { engine.ensure(extra, '需要宿主批次绑定文件'); return bindBatch(path.resolve(file),read(extra)); }
  if (op === 'drive') {
    requireProtocol(read<engine.State>(path.resolve(file)));
    const statePath=path.resolve(file);
    const collected = await main(['collect', statePath]);
    const completed:string[] = [], dispatched: unknown[] = [];
    const limit=Math.min(32,(read<engine.State>(statePath).policy?.agents || 1));
    for(let n=0;n<limit;n++) {
      const next=await main(['next',statePath]) as {jobs?:engine.Job[]};
      if (process.env.SPEC_DELIVERY_HOST_ADAPTER) for (const j of next.jobs || []) if (j.executor === 'agent')
        dispatched.push(dispatchRound(statePath, j.id, true));
      const current=read<engine.State>(statePath);
      const dead=(j:engine.Job)=>/^command:\d+:/.test(j.nativeId) && !processAlive(Number(j.nativeId.split(':')[1]));
      const j=current.jobs.find(j=>j.executor!=='agent' && active(j) && !recovering(current,j) && (!j.nativeId || (dead(j) && canRecoverCommand(statePath,j))));
      if(!j) return {...next,collected,completed,dispatched,recoveryRequired:current.jobs.filter(j=>active(j) && j.executor!=='agent' && !recovering(current,j) && dead(j) && !canRecoverCommand(statePath,j)).map(j=>({jobId:j.id,nativeId:j.nativeId,reason:'无命令结果，需核对子进程及外部动作后 reconcile'}))};
      executeCommand(statePath,j.id); completed.push(j.id);
    }
    const next = await main(['next',statePath]) as {jobs?:engine.Job[]};
    if (process.env.SPEC_DELIVERY_HOST_ADAPTER) for (const j of next.jobs || []) if (j.executor === 'agent')
      dispatched.push(dispatchRound(statePath, j.id, true));
    return {...next,collected,completed,dispatched};
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
      s.v3.skillBindings=skills.defaultSkillBindings();
      engine.event(s,`迁移为运行协议 3；原账本备份：${backup}；保留全部原结果和已完成工单。对账依据：${proof.evidencePath}`);
      save(statePath,s);return {statePath,status:s.status,upgraded:true,backupPath:backup};
    }
    if(!['bind','submit','reconcile','retire'].includes(op))requireProtocol(s);
    if (op === 'context-handoff') {
      engine.ensure(extra&&fourth,'需要后继 jobId 与 L1 核验请求');
      const ref=forwardOriginalHandoff(s,statePath,extra,read(fourth));save(statePath,s);
      return {jobId:extra,handoffRef:ref,revision:s.revision};
    }
    if (op === 'context-reconstruct') {
      engine.ensure(extra&&fourth,'需要后继 jobId 与 L1 重建请求');
      const ref=reconstructHandoff(s,statePath,extra,read(fourth));save(statePath,s);
      return {jobId:extra,handoffRef:ref,revision:s.revision};
    }
    if (op === 'skill-start') {
      engine.ensure(extra && fourth, '需要 jobId 与宿主技能能力文件');
      const j = s.jobs.find(j => j.id === extra); engine.ensure(j, '未知技能执行 job');
      engine.ensure(j.session, '技能调用需要真实宿主会话观测'); verifySessionArtifact(j.session);
      const request = read<{capability:engine.SkillCapability}>(fourth);
      engine.ensure(skills.skillCapabilities.includes(request.capability), '未知技能能力，不能查询宿主或启动调用');
      if (j.action === 'skill-child') {
        const child=s.v3?.skillChildren?.find(x=>x.id===j.childRequestId);
        engine.ensure(child?.skillCapability===request.capability, '子任务只能调用已声明并固定版本的引用技能');
      }
      if(request.capability!=='handoff')engine.ensure(engine.contextReady(j),'新会话尚未取得 L1 核验的交接引用');
      verifyHandoffRef(j);
      const observation = skillObservation(statePath, 'capabilities', request.capability, j.id);
      engine.ensure(observation.raw.capability === request.capability && observation.raw.capabilities,
        '技能宿主未返回当前能力的实际调用入口');
      const prepared = skills.prepareSkillCall(s, j, request.capability,
        observation.raw.capabilities as skills.SkillHostCapabilities, statePath);
      if (!prepared.alreadyStarted) {
        prepared.invocation.hostCapabilityPath=observation.file;
        prepared.invocation.hostCapabilitySha256=sha(fs.readFileSync(observation.file,'utf8'));
      }
      save(statePath, s);
      return { invocationId: prepared.invocation.id, mode: prepared.invocation.mode,
        nativeEntry: prepared.nativeEntry || null, sourceArchivePath: prepared.invocation.sourceArchivePath,
        bindingFingerprint: prepared.invocation.bindingFingerprint, alreadyStarted: prepared.alreadyStarted,
        instruction: prepared.alreadyStarted ? '已登记调用；先查询宿主状态，不重复启动' :
          '宿主按 mode 执行已授权技能；native_explicit 调原生入口，source_execution 加载 sourceArchivePath 的原始文件。终态后提交 skill-finish。' };
    }
    if (op === 'skill-delegate') {
      engine.ensure(extra && fourth, '需要父调用 ID 与子任务请求文件');
      const request=read<{children:skills.SkillChildSpec[]}>(fourth);
      const invocation=s.v3?.skillInvocations.find(i=>i.id===extra);
      const parent=invocation && s.jobs.find(j=>j.id===invocation.jobId);
      const ticket=parent && s.tickets.find(t=>t.key===parent.ticket);
      for(const child of request.children || []) if(child.head && child.head!==parent?.head) {
        engine.ensure(parent && ticket?.worktree && localHead(ticket)===child.head && clean(ticket),
          '技能子任务候选 head 必须是当前已提交且干净的工作区');
      }
      skills.delegateSkillChildren(s,extra,request.children);
      const snapshot=skills.skillChildrenSnapshot(s,extra);
      save(statePath,s); return snapshot;
    }
    if (op === 'skill-retry') {
      engine.ensure(extra && fourth, '需要父调用 ID 与失败子任务 key 文件');
      const request=read<{keys:string[]}>(fourth);
      skills.retrySkillChildren(s,extra,request.keys);
      const snapshot=skills.skillChildrenSnapshot(s,extra);
      save(statePath,s); return snapshot;
    }
    if (op === 'skill-resume') {
      engine.ensure(extra && fourth, '需要旧调用 ID 与续接请求文件');
      const request=read<{jobId:string;evidencePath:string}>(fourth);
      safeFile(request.evidencePath);
      const invocation=s.v3?.skillInvocations.find(i=>i.id===extra);
      const replacement=s.jobs.find(j=>j.id===request.jobId);
      engine.ensure(invocation && replacement?.session, '旧调用或新原生执行者不存在');
      verifySessionArtifact(replacement.session);
      const observation=skillObservation(statePath,'capabilities',invocation.capability,replacement.id);
      engine.ensure(observation.raw.capability===invocation.capability && observation.raw.capabilities,
        '续接宿主没有确认技能调用能力');
      skills.resumeSkillCall(s,extra,replacement,observation.raw.capabilities as skills.SkillHostCapabilities,
        path.resolve(request.evidencePath));
      invocation.hostCapabilityPath=observation.file;
      invocation.hostCapabilitySha256=sha(fs.readFileSync(observation.file,'utf8'));
      const snapshot=skills.skillChildrenSnapshot(s,extra);
      save(statePath,s);return {...snapshot, sourceArchivePath:invocation.sourceArchivePath};
    }
    if (op === 'skill-continue') {
      engine.ensure(extra, '需要父调用 ID');
      return skills.skillChildrenSnapshot(s,extra);
    }
    if (op === 'skill-finish') {
      engine.ensure(extra && fourth, '需要技能调用 ID 与外围回执文件');
      const invocation=s.v3?.skillInvocations.find(i=>i.id===extra);
      engine.ensure(invocation, '未知技能调用'); verifySessionArtifact(invocation.session);
      const observation=skillObservation(statePath,'result',extra,invocation.jobId);
      const outcome=read<Omit<skills.SkillOutcome,'hostReceiptPath'>>(fourth);
      const result = skills.finishSkillCall(s, extra, {...outcome,hostReceiptPath:observation.file});
      save(statePath, s);
      return { invocationId: extra, status: result.status, blocking: result.blocking, result };
    }
    if (op === 'migrate-skills') {
      engine.ensure(extra, '需要显式技能迁移文件');
      const request=read<{expectedRevision:number;evidencePath:string;replacements:Partial<Record<engine.SkillCapability,string>>}>(extra);
      engine.ensure(request.expectedRevision===s.revision, '技能迁移决定已过期；重新 inspect 当前账本');
      const changed=skills.migrateSkillBindings(s,request.replacements || {},path.resolve(request.evidencePath));
      save(statePath,s);
      return {statePath,changed,revision:s.revision,status:s.status};
    }
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
      s.facts = observe(s); const parent = gh.issue(s.repo, s.spec), sources = gh.subIssues(s.repo, s.spec);
      const p = read<engine.ExecutionPlan & { decisionNativeId?: string }>(extra); safeFile(p.evidencePath);
      engine.ensure(p.inputVersion === engine.inputVersion(s) && p.sourceVersion === sourceVersion(parent, sources),
        'L1 执行计划的输入或 spec/sub-issue 来源版本已过期');
      engine.ensure(p.decisionNativeId, '执行图与资源策略需要真实 L1 原生会话');
      const session = nativeSession(statePath, p.decisionNativeId, '$spec:execution-plan');
      engine.verifyNativeSession(s, session, p.decisionNativeId, 'L1'); verifySessionArtifact(session);
      engine.applyPlan(s, p, sources);
      s.planSourceVersion = p.sourceVersion; s.planArtifactPath = path.resolve(extra);
      const artifact = artifactFingerprint([extra, p.evidencePath]);
      engine.recordL1Decision(s, { id: `execution-plan:${s.revision}`, kind: 'execution-plan', scope: '$spec',
        inputVersion: engine.inputVersion(s), sourceVersion: p.sourceVersion, candidateVersion: engine.globalDecisionVersion(s),
        artifactPath: path.resolve(extra), artifactFiles: artifact.files, artifactDigest: artifact.digest, session, at: new Date().toISOString() });
    } else if (op === 'next') {
      const observed = observe(s);
      inspectIdleWorkspaces(s, observed, statePath);
      engine.reconcileFacts(s, observed);
      if (s.status !== 'running') { save(statePath, s); return { status: s.status, next: 'inspect 中的状态需要 L1 处理；用户暂停时保持暂停' }; }
      if (s.planEvidence) {
        const global = s.v3?.decisionRecords.findLast(d => d.kind === 'execution-plan' && d.scope === '$spec' &&
          d.inputVersion === engine.inputVersion(s) && d.sourceVersion === s.planSourceVersion &&
          d.candidateVersion === engine.globalDecisionVersion(s));
        engine.ensure(global && artifactFingerprint(global.artifactFiles).digest === global.artifactDigest,
          'L1 执行图或资源策略产物已过期或被修改');
      }
      const js = engine.reserve(s).filter(j => {
        if (claimLease(s, j, statePath)) return true;
        const t = engine.ticket(s, j.ticket); t.phase = 'blocked'; t.reason = '工单由另一个运行持有'; j.status = 'cancelled'; return false;
      });
      const packets = s.jobs.filter(j=>j.status==='leased' && !j.nativeId && !recovering(s,j)).flatMap(j => {
        if (j.action === 'implement') ensureDecisionArtifacts(s, engine.ticket(s, j.ticket), 'plan-check');
        const record = s.v3?.dispatchRecords.find(d => d.jobId === j.id);
        if (j.executor === 'agent' && s.protocol === engine.currentProtocol) j.dispatchToken ||= record?.token || randomUUID();
        const p = packet(s, j, statePath); const file = path.join(path.dirname(statePath), 'packets', sha(j.id).slice(0, 20) + '.json'); write(file, p);
        if (j.executor === 'agent' && s.protocol === engine.currentProtocol && !record) {
          const requestPath = path.join(path.dirname(statePath), 'dispatch', `${sha(j.id).slice(0, 20)}.json`);
          const previous = s.jobs.find(x=>x.id===j.contextIntent?.predecessorJobId || x.id===j.contextIntent?.parentJobId);
          const request = { token: j.dispatchToken!, jobId: j.id, attempt: Number(j.id.match(/try-(\d+)$/)?.[1] || 1),
            targetHost: s.capabilities?.framework || 'unknown', requestedModel: j.model, packetPath: file,
            contextIntent:j.contextIntent || null,
            resumeFrom: previous?.contextObservation ? {jobId:previous.id,nativeId:previous.nativeId,
              contextId:previous.contextObservation.contextId} : null };
          write(requestPath, request);
          const at = new Date().toISOString();
          s.v3!.dispatchRecords.push({ ...request, requestPath, requestDigest:sha(fs.readFileSync(requestPath)),
            status: 'prepared', createdAt: at,
            updatedAt: at, events: [], instances: [{ key: `token:${request.token}`, nativeId: null, state: 'requested',
              firstSeenAt: at, lastSeenAt: at, events: [] }] });
        }
        const current = s.v3?.dispatchRecords.find(d => d.jobId === j.id);
        return current && current.status !== 'prepared' ? [] : [{ ...j, packetPath: file }];
      });
      save(statePath, s);
      return { status: s.status, jobs: packets, outstanding: s.jobs.filter(active).map(j => ({id:j.id, nativeId:j.nativeId, status:j.status})),
        recoveries: s.tickets.filter(t => t.phase === 'recovery').map(t => ({ticket:t.key,...t.recovery})),
        dispatches: s.v3?.dispatchRecords.filter(d => ['starting', 'running', 'completed', 'uncertain'].includes(d.status)).map(d =>
          ({ jobId: d.jobId, token: d.token, status: d.status, nativeId: d.nativeId || null, uncertainty: d.uncertainty || null })) || [],
        instruction: '宿主按角色路由到真实模型并查询原生身份；工作区恢复先核对执行者并调用 recover-workspace；没有新任务时等待在途任务或处理明确阻塞' };
    } else if (op === 'bind') {
      engine.ensure(extra && fourth, '需要 jobId 与宿主 binding.json');
      const ref = read<{ nativeId: string; model?: string }>(fourth);
      const j = s.jobs.find(j => j.id === extra); engine.ensure(j, '未知任务');
      const dispatch = s.v3?.dispatchRecords.find(d=>d.jobId===extra);
      if(dispatch?.managed) engine.ensure(!dispatch.instances.some(i=>i.nativeId && i.nativeId!==ref.nativeId),
        '持久 token 的原生实例身份不符；需要先对账，不能用手填绑定覆盖');
      if (j.nativeId) engine.ensure(j.nativeId === ref.nativeId, '同一租约不能重复绑定另一任务');
      const session = s.protocol === engine.currentProtocol && j.executor === 'agent'
        ? j.session && j.nativeId === ref.nativeId ? j.session : nativeSession(statePath, ref.nativeId, j.id)
        : undefined;
      if (session) verifySessionArtifact(session);
      engine.bind(s, extra, { ...ref, session });
      journalBoundSession(s,j);
    } else if (op === 'observe-main') {
      engine.ensure(extra, '需要主会话的原生身份');
      const session = nativeSession(statePath, extra, '$main'); verifySessionArtifact(session);
      s.mainSession = session; engine.event(s, '记录当前宿主主会话观测身份；不作为 L1 决策证明');
    } else if (op === 'reconfigure') {
      engine.ensure(extra && !s.jobs.some(active) && !['complete','retired'].includes(s.status),'先确认在途任务终止；不能改写已终结运行');
      const config=read<{models:engine.Inputs['models'];capabilities:engine.Capabilities;evidencePath:string;decisionNativeId:string;sourceVersion?:string}>(extra);
      safeFile(config.evidencePath);
      if (s.planSourceVersion) engine.ensure(config.sourceVersion === s.planSourceVersion &&
        config.sourceVersion === sourceVersion(gh.issue(s.repo, s.spec), gh.subIssues(s.repo, s.spec)),
        '重新配置时 spec/sub-issue 来源已改变；需要新的 L1 执行图');
      engine.ensure(['per_agent','per_run'].includes(config.capabilities.modelRouting),'宿主必须支持指定模型路由');
      for(const tier of ['L1','L2','L3'] as const)engine.ensure(config.models[tier] && config.capabilities.models.includes(config.models[tier]),'宿主没有确认新模型可用');
      s.inputs.models=config.models;s.capabilities=config.capabilities;
      engine.ensure(config.decisionNativeId, '重新配置资源和模型需要真实 L1 会话');
      const session = nativeSession(statePath, config.decisionNativeId, '$spec:execution-plan');
      engine.verifyNativeSession(s, session, config.decisionNativeId, 'L1'); verifySessionArtifact(session);
      const artifact = artifactFingerprint([extra, config.evidencePath, ...(s.planArtifactPath ? [s.planArtifactPath] : [])]);
      engine.recordL1Decision(s, { id: `reconfigure:${s.revision}:${randomUUID()}`, kind: 'execution-plan', scope: '$spec',
        inputVersion: engine.inputVersion(s), sourceVersion: s.planSourceVersion, candidateVersion: engine.globalDecisionVersion(s),
        artifactPath: path.resolve(extra), artifactFiles: artifact.files, artifactDigest: artifact.digest, session, at: new Date().toISOString() });
      // Existing ticket plans and checks were approved for the previous role routing.
      for (const t of s.tickets) if (!['done', 'human', 'blocked', 'close', 'cleanup', 'recovery'].includes(t.phase)) {
        t.epoch++; t.evidence = {}; t.phase = t.worktree ? 'replan' : 'claim';
        t.reason = '模型路由改变；需真实 L1 更新工单计划和独立复核';
      }
      s.validationOwner = undefined;
      s.mainSession = { source: 'unknown', at: new Date().toISOString() };
      if (process.env.SPEC_DELIVERY_MAIN_NATIVE_ID) {
        try { s.mainSession = nativeSession(statePath, process.env.SPEC_DELIVERY_MAIN_NATIVE_ID, '$main'); } catch { /* 无法观察时保持未知。 */ }
      }
      engine.event(s,'模型路由由真实 L1 重新配置；旧工单决策失效，保留完成结果');
    } else if (op === 'retire') {
      engine.ensure(extra && !s.jobs.some(active),'退役前必须对账并停止在途执行者');
      const r=read<{evidencePath:string;reason:string}>(extra);safeFile(r.evidencePath);engine.ensure(r.reason,'需要退役原因');
      s.retired={...r,at:new Date().toISOString()};s.status='retired';engine.event(s,'运行已退役，保留原始证据和未交付资源');
    } else if (op === 'record-host') {
      engine.ensure(extra,'需要真实宿主观测文件');
      const records=read<{jobId:string;nativeId:string;evidencePath:string;startedAt?:string;usage?:engine.Job['usage'];dispatchToken?:string;state?:engine.HostInstanceRecord['state']}[]>(extra);
      for(const r of records) {
        const j=s.jobs.find(j=>j.id===r.jobId); engine.ensure(j && !!r.nativeId, '宿主任务不存在'); safeFile(r.evidencePath);
        const d=s.v3?.dispatchRecords.find(x=>x.jobId===r.jobId);
        engine.ensure(j.nativeId===r.nativeId || (!!d && r.dispatchToken===d.token &&
          d.instances.some(i=>i.nativeId===r.nativeId && i.events.some(e=>e.evidencePath===r.evidencePath))),
          '未绑定实例须引用已归档的宿主事件；身份或派发 token 不符');
        if(r.startedAt)engine.ensure(Number.isFinite(Date.parse(r.startedAt)),'开始时间无效');
        if(r.usage)for(const [k,v] of Object.entries(r.usage))if(k!=='currency')engine.ensure(typeof v==='number' && Number.isFinite(v) && v>=0,'用量必须来自非负真实观测');
        if(d) {
          const at=new Date().toISOString(); let instance=d.instances.find(x=>x.nativeId===r.nativeId);
          if(!instance){instance={key:`native:${r.nativeId}`,nativeId:r.nativeId,state:r.state||'unknown',firstSeenAt:at,lastSeenAt:at,events:[]};d.instances.push(instance);}
          instance.lastSeenAt=at; if(r.state)instance.state=r.state;
          const digest=sha(fs.readFileSync(r.evidencePath));const ref:engine.HostEventRef={kind:'query',evidencePath:r.evidencePath,digest,at};
          if(!instance.events.some(x=>x.evidencePath===ref.evidencePath&&x.digest===ref.digest))instance.events.push(ref);
          if(!d.events.some(x=>x.evidencePath===ref.evidencePath&&x.digest===ref.digest))d.events.push(ref);
          if(r.startedAt)instance.startedAt ||= r.startedAt;
          if(r.usage)instance.rawUsage=r.usage as engine.Json;
        }
        if(j.nativeId===r.nativeId){
          if(r.startedAt){j.timing??={leasedAt:''};j.timing.startedAt=r.startedAt;}
          if(r.usage)j.usage=r.usage;
        }
      }
      engine.event(s,'记录宿主真实时间与用量；未提供的字段保持未知');
    } else if (op === 'submit') {
      engine.ensure(extra && fourth, '需要 jobId 与结果 JSON');
      const j = s.jobs.find(j => j.id === extra); engine.ensure(j, '未知 job'); const r = read<engine.Result>(fourth);
      const trial = structuredClone(s), trialJob = trial.jobs.find(x => x.id === extra)!;
      try {
        if (trialJob.status !== 'done') {
          engine.ensure(!trialJob.testExecution,'测试进程未完成');
          if (trial.protocol === engine.currentProtocol && trialJob.executor === 'agent') {
          engine.ensure(trialJob.session, '缺少原生会话观测'); verifySessionArtifact(trialJob.session);
          verifyHandoffRef(trialJob);
            if (trialJob.tier === 'L1') {
              const artifact = decisionArtifacts(trial, trialJob, r);
              trialJob.decisionArtifactDigest = artifact.digest; trialJob.decisionArtifactFiles = artifact.files;
            }
          }
          trial.facts = observe(trial,[trialJob]); validateResult(trial, trialJob, r);
        }
        engine.submit(trial, extra, r); journalBoundSession(trial, trialJob);
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
          if (j.action === 'skill-child') {
            engine.event(s, `${j.id} 技能子任务已由宿主确认停止；父调用等待显式 skill-retry`);
          } else if (s.v3?.skillInvocations.some(i=>i.jobId===j.id&&!i.result)) {
            engine.event(s, `${j.id} 父技能执行者已停止；保留调用与子任务证据，等待新角色通过 skill-resume 续接`);
          } else if (j.ticket === '$spec') s.specAudit = undefined;
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
      const decisions = read<{ticket:string; evidencePath:string; handoffPath:string;
        decisionNativeId?:string; inputVersion?:string; candidateVersion?:string; newFacts?:string; failureEventId?:string}[]>(extra);
      s.facts = observe(s);
      for (const d of decisions) {
        const t = engine.ticket(s, d.ticket); safeFile(d.evidencePath); safeFile(d.handoffPath);
        engine.ensure(t.phase === 'blocked' && !s.jobs.some(j => j.ticket === t.key && active(j)), '只解除没有在途任务的阻塞工单');
        engine.ensure(!s.jobs.some(j => j.ticket === t.key && j.testExecution), '测试进程树未对账，不能解除阻塞');
        let session: engine.NativeSession | undefined;
        const originalCandidate = engine.candidateVersion(s, t);
        if (s.protocol === engine.currentProtocol) {
          engine.ensure(d.inputVersion === engine.inputVersion(s) && d.candidateVersion === originalCandidate,
            '解除阻塞决定的输入或候选版本已过期');
          engine.ensure(d.decisionNativeId, '解除阻塞需要真实 L1 原生会话');
          session = nativeSession(statePath, d.decisionNativeId, `$resolve:${t.key}:${t.epoch}`);
          engine.verifyNativeSession(s, session, d.decisionNativeId, 'L1'); verifySessionArtifact(session);
        }
        if (t.failureBudget?.totalRetries) {
          engine.ensure(typeof d.newFacts === 'string' && d.newFacts.trim() &&
            d.failureEventId === t.failures?.at(-1)?.id, '失败预算解除阻塞须指出最新失败事件及有证据的新事实');
          t.failureBudget.consecutiveNoProgress = 0; t.failureBudget.lastSignature = '';
        }
        t.handoffPath = d.handoffPath; t.phase = t.worktree ? 'replan' : 'claim'; t.epoch++; t.reason = '';
        if (session) {
          const artifact = artifactFingerprint([d.evidencePath, d.handoffPath]);
          engine.recordL1Decision(s, { id: `resolve:${t.key}:${t.epoch}:${randomUUID()}`, kind: 'resolve', scope: t.key,
            inputVersion: engine.inputVersion(s), sourceVersion: s.planSourceVersion,
            candidateVersion: originalCandidate, appliesToCandidateVersion: engine.candidateVersion(s, t),
            artifactPath: path.resolve(d.evidencePath), artifactFiles: artifact.files, artifactDigest: artifact.digest,
            session, at: new Date().toISOString() });
        }
      }
      if (s.status !== 'paused') s.status = 'running'; engine.event(s, 'L1 用已取得的新事实解除局部阻塞；重新规划而非跳过验证');
      s.specAudit = undefined; s.auditEpoch++;
    } else if (op === 'resume') {
      engine.ensure(!s.jobs.some(active), '恢复前先对账或停止已有任务'); engine.reconcileFacts(s, observe(s));
      engine.ensure(s.status !== 'complete', '本 workflow 已完成'); s.status = 'running'; s.specAudit = undefined; s.auditEpoch++;
      s.mainSession = { source: 'unknown', at: new Date().toISOString() };
      const mainId = extra || process.env.SPEC_DELIVERY_MAIN_NATIVE_ID;
      if (mainId) try { s.mainSession = nativeSession(statePath, mainId, '$main'); } catch { /* 当前主会话不可观测。 */ }
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
