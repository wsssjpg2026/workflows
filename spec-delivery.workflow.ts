/**
 * spec-delivery — 通用 TypeScript workflow，由宿主主会话转发，真实 L1 会话决策。
 * 用户输入仅 spec、targetBranch、models.L1/L2/L3。
 * 参考 dynamic-workflows 的显式 actors、类型化结果、有界循环与证据门禁。
 * 这是 portable host 协议入口，不是 ZCode 原生 facade 脚本；zcode 命令生成按 job 的原生运行描述。
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
import { compareMetrics } from './spec-delivery/metrics.ts';
import { rawSourcesForJob, type RawSourceIndex } from './spec-delivery/raw-sources.ts';
import * as skills from './spec-delivery/skills.ts';
import { summarize } from './spec-delivery/summary.ts';
import {prepareJob as prepareZcodeJob} from './spec-delivery/adapters/zcode.mjs';
export * from './spec-delivery/core.ts';

const home = path.dirname(fileURLToPath(import.meta.url));
export const workflowVersion = '0.3.0';
const rolesPath = path.join(home, 'spec-delivery', 'roles.md');
const active = (j: engine.Job) => j.status === 'leased' || j.status === 'running';
const recovering = (s: engine.State, j: engine.Job) => s.tickets.some(t => t.key === j.ticket && t.phase === 'recovery');
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
function testCommandEnv(explicit?:Record<string,string>) {
  const inherited={...process.env};
  const controllerKeys=new Set(['DSH_HOME','DSH_SESSION_ID','DSH_ADAPTER_WORKER','DSH_PERMISSION_MODE']);
  for(const name of Object.keys(inherited))
    if(name.startsWith('SPEC_DELIVERY_')||controllerKeys.has(name))delete inherited[name];
  return {...inherited,...explicit};
}
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
function authorReviewSources(s: engine.State, t: engine.Ticket, head: string, base: string): engine.ReviewSources {
  engine.ensure(t.worktree && t.planPath && t.checksPath, '作者自检需要已批准计划、检查范围及任务 worktree');
  const tracked=git(t.worktree,'ls-files','-z','--','*.md','*.markdown','*.MD').split('\0').filter(Boolean);
  const standardsPaths=tracked.filter(relative=>fs.existsSync(path.join(t.worktree,relative)))
    .map(relative=>path.join(t.worktree,relative)).sort();
  const standardsDigest=sha(JSON.stringify(standardsPaths.map(file=>[path.relative(t.worktree,file),sha(fs.readFileSync(file))])));
  const source=sourceVersion(gh.issue(s.repo,s.spec),gh.subIssues(s.repo,s.spec));
  const issueUrl=`https://${s.repo.host}/${s.repo.slug}/issues/${t.number}`;
  const planDigest=sha(fs.readFileSync(safeFile(t.planPath)));
  const checksDigest=sha(fs.readFileSync(safeFile(t.checksPath)));
  const fingerprint=sha(JSON.stringify({issueUrl,source,standardsDigest,planDigest,checksDigest,head,base}));
  return {issueUrl,sourceVersion:source,standardsDigest,standardsPaths,planDigest,checksDigest,head,base,fingerprint};
}
function requireCurrentAuthorReview(s: engine.State, t: engine.Ticket) {
  const proof=t.authorReview;
  engine.ensure(proof && proof.head===t.head && proof.base===t.base &&
    proof.sources.fingerprint===authorReviewSources(s,t,t.head,t.base).fingerprint,
    '作者自检候选、spec/规范来源或计划检查范围已改变；重新运行 authorReview');
  const invocation=s.v3?.skillInvocations.find(i=>i.id===proof.invocationId);
  engine.ensure(invocation && invocation.result?.status==='pass' && !invocation.result.blocking &&
    invocation.bindingFingerprint===s.v3?.skillBindings?.find(b=>b.capability==='authorReview')?.fingerprint,
    '作者自检调用缺失、未通过或技能版本已改变');
  const actor=s.jobs.find(j=>j.id===proof.jobId);
  engine.ensure(actor, '作者自检缺少真实执行者');
  skills.verifySkillResultFiles(s,actor,[invocation.id]);
}
function refreshAuthorReviews(s: engine.State) {
  if (!s.v3?.skillBindings) return;
  for(const t of s.tickets) {
    if (!t.authorReview || ['done','human','recovery'].includes(t.phase)) continue;
    const fresh=t.authorReview.head===t.head && t.authorReview.base===t.base &&
      t.authorReview.sources.fingerprint===authorReviewSources(s,t,t.head,t.base).fingerprint;
    if(fresh) continue;
    // A revised plan must still pass its independent plan-check and implementation.
    // The old proof is kept in the invocation journal; it is no longer current.
    if(['claim','plan','plan_check','implement','integrate','replan'].includes(t.phase)) {
      t.authorReview=undefined;delete t.evidence.self;
      engine.event(s,`#${t.number} 修复阶段的旧作者自检失效；继续当前计划与实现`);
      continue;
    }
    if(s.jobs.some(j=>j.ticket===t.key && (j.status==='leased'||j.status==='running'))) {
      t.phase='blocked';t.reason='作者自检来源已变化；先对账在途任务';
    } else {
      t.phase='self';t.epoch++;t.evidence={};t.authorReview=undefined;
      t.reason='作者自检候选或来源变化；重新审查';
    }
    engine.event(s,`#${t.number} 作者自检来源变化，旧结果失效`);
  }
}
function nativeSession(statePath: string, nativeId: string, jobId: string): engine.NativeSession {
  const observer = jobId === '$main'
    ? process.env.SPEC_DELIVERY_MAIN_OBSERVER || process.env.SPEC_DELIVERY_HOST_OBSERVER
    : process.env.SPEC_DELIVERY_HOST_OBSERVER;
  engine.ensure(observer && path.isAbsolute(observer) && fs.statSync(observer).isFile(),
    jobId === '$main' ? '宿主未提供可信主会话查询适配器 SPEC_DELIVERY_MAIN_OBSERVER'
      : '宿主未提供可信原生会话查询适配器 SPEC_DELIVERY_HOST_OBSERVER');
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
  if (s.protocol === engine.currentProtocol && j.action === 'adjudicate' && t) {
    const dispute = engine.activeReviewDisagreement(s,t);
    engine.ensure(dispute, '裁决缺少当前审查分歧');
    for (const id of [dispute.regularInvocationId,dispute.freshInvocationId]) {
      const invocation=s.v3?.skillInvocations.find(i=>i.id===id);
      engine.ensure(invocation?.result, '裁决缺少两轮原始技能产物');
      files.push(invocation.result.rawOutputPath,invocation.sourceArchivePath,...invocation.result.evidencePaths);
    }
  }
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
  t.recovery = recovery; t.phase = 'recovery'; t.reason = recovery.reason; t.epoch++; t.evidence = {}; t.reviewDisagreementId=undefined;
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
      t.phase = t.failureBudget?.replans ? 'blocked' : 'replan'; t.epoch++; t.evidence = {}; t.reviewDisagreementId=undefined;
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
  t.phase = 'replan'; t.reason = decision.reason; t.epoch++; t.evidence = {}; t.reviewDisagreementId=undefined;
  if (s.validationOwner === t.key) s.validationOwner = undefined;
  engine.event(s, `${t.key} 根据 ${decision.evidencePath} 恢复已保全候选，交给 L1 重规划`);
  return { ticket: t.key, head: t.head, base: t.base, recoveryRef: ref, phase: t.phase };
}
function supportedLedger(s: engine.State) {
  engine.ensure(s.schema === 1, '不支持的状态版本');
  engine.ensure(s.protocol === undefined || s.protocol === 2 || s.protocol === engine.currentProtocol,
    `不支持的运行协议：${String(s.protocol)}`);
  if (s.protocol === engine.currentProtocol) {
    engine.ensure(['legacy-v02','unified-v03'].includes(s.v3?.executionPath || '') && Array.isArray(s.v3?.decisionRecords) &&
      Array.isArray(s.v3.skillInvocations) && Array.isArray(s.v3.dispatchRecords),
      '运行协议 3 缺少执行路径或记录边界');
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
function requireUnified(s: engine.State) {
  requireProtocol(s);
  engine.ensure(engine.unifiedSkillsReady(s),
    '统一执行路径缺少完整技能绑定；先 inspect 并显式 migrate-skills，不能回退固定审查调度');
}
function requireBoundV3(s: engine.State) {
  if(s.protocol===engine.currentProtocol)requireUnified(s);
}
function unifiedDispatchRequired(s:engine.State,j:engine.Job) {
  return s.protocol===engine.currentProtocol&&s.v3?.executionPath==='unified-v03'&&
    j.executor==='agent'&&!j.legacyManualLease;
}
function verifiedDispatchCompletion(s:engine.State,j:engine.Job) {
  const d=s.v3?.dispatchRecords.find(x=>x.jobId===j.id);
  engine.ensure(d?.managed&&!!j.dispatchToken&&d.token===j.dispatchToken&&
    d.status==='completed'&&d.nativeId===j.nativeId&&
    d.events.some(e=>['query','collect','start'].includes(e.kind)&&fs.existsSync(e.evidencePath)&&
      sha(fs.readFileSync(e.evidencePath))===e.digest)&&
    d.instances.some(i=>i.nativeId===j.nativeId&&i.state==='completed'&&
      i.events.some(e=>fs.existsSync(e.evidencePath)&&sha(fs.readFileSync(e.evidencePath))===e.digest)),
    '统一运行的任务须经持久 token 的可信宿主派发和终态查询，不能手动提交结果');
  return d;
}
function migrationInventory(s: engine.State) {
  return {revision:s.revision,status:s.status,
    jobs:s.jobs.map(j=>({id:j.id,status:j.status,nativeId:j.nativeId,
      testPid:j.testExecution?.pid||null,testProcessHistory:j.testProcessHistory||[],
      stopConfirmed:!!j.stopConfirmation?.processTreeStopped})),
    dispatches:(s.v3?.dispatchRecords||[]).map(d=>({token:d.token,jobId:d.jobId,status:d.status,
      operationPid:d.operationPid||null,instances:d.instances.map(i=>({key:i.key,nativeId:i.nativeId,state:i.state}))})),
    detached:(s.v3?.detachedInstances||[]).map(i=>({key:i.key,nativeId:i.nativeId,state:i.state})),
    children:(s.v3?.skillChildren||[]).map(c=>({id:c.id,pending:c.pending,jobIds:c.jobIds})),
    openWaits:(s.waitIntervals||[]).filter(w=>!w.endedAt).map(w=>({id:w.id,kind:w.kind}))};
}
function migrationContext(s: engine.State,statePath:string) {
  const inventory=migrationInventory(s);
  return {...inventory,inventorySha256:sha(JSON.stringify(inventory)),
    ledgerSha256:sha(fs.readFileSync(statePath))};
}
interface MigrationDecision {
  schemaVersion: 1; expectedRevision: number; inventorySha256: string; ledgerSha256:string;
  evidencePath: string; observedAt: string; statusIntent: 'preserve';
  processTreeStopped: true; externalActionsSettled: true;
}
interface MigrationHostObservation {
  source:'native_host'; schemaVersion:1; challenge:string; runId:string; inventorySha256:string;
  ledgerSha256:string; observedAt:string;
  actors:{jobId:string;nativeId:string;state:'completed'|'cancelled'|'running'|'unknown';observationId:string}[];
  dispatches:{token:string;jobId:string;targetHost:string;state:'not_found'|'completed'|'cancelled'|'running'|'unknown';
    nativeId?:string;authoritative?:boolean;observationId:string}[];
  instances:{key:string;nativeId:string;state:'completed'|'cancelled'|'running'|'unknown';observationId:string}[];
  processes:{jobId:string;kind:'command'|'test'|'dispatch';pid:number;state:'stopped'|'running'|'unknown';
    descendantsStopped:boolean;observationId:string}[];
  processTree:{state:'stopped'|'running'|'unknown';unknownChildren:number;observationId:string};
  externalActions:{state:'settled'|'pending'|'unknown';unknown:number;observationId:string};
}
function migrationHostQuiescence(s:engine.State,statePath:string,context:ReturnType<typeof migrationContext>) {
  const observer=process.env.SPEC_DELIVERY_MIGRATION_OBSERVER;
  engine.ensure(observer&&path.isAbsolute(observer)&&fs.statSync(observer).isFile(),
    '迁移缺少可信宿主逐项查询适配器 SPEC_DELIVERY_MIGRATION_OBSERVER');
  const challenge=randomUUID(),started=Date.now();
  const result=spawnSync(observer,['quiescence',statePath],{cwd:path.dirname(statePath),
    input:JSON.stringify({schemaVersion:1,challenge,runId:s.id,...context}),encoding:'utf8',
    maxBuffer:32*1024*1024,timeout:30_000,stdio:['pipe','pipe','pipe']});
  engine.ensure(result.status===0,`迁移宿主查询失败：${result.error?.message||result.stderr||result.status}`);
  const output=result.stdout.trim();
  let observed:MigrationHostObservation;
  try {observed=JSON.parse(output);}catch{throw Error('迁移宿主查询未返回结构化 JSON');}
  const at=Date.parse(observed?.observedAt);
  engine.ensure(observed?.source==='native_host'&&observed.schemaVersion===1&&observed.challenge===challenge&&
    observed.runId===s.id&&observed.inventorySha256===context.inventorySha256&&
    observed.ledgerSha256===context.ledgerSha256&&Number.isFinite(at)&&
    at>=started-60_000&&at<=Date.now()+60_000,
    '迁移宿主观测不是针对当前运行、清单和账本的即时查询');
  const proof=(value:{observationId?:string})=>typeof value?.observationId==='string'&&!!value.observationId.trim();
  const exact=<E extends {observationId:string},A extends {observationId:string}>(
    expected:E[],actual:A[],key:(x:E|A)=>string,valid:(x:E,y:A)=>boolean,kind:string)=>{
    engine.ensure(Array.isArray(actual)&&actual.length===expected.length&&
      new Set(actual.map(key)).size===actual.length&&actual.every(proof)&&
      new Set(actual.map(x=>x.observationId)).size===actual.length,
      `迁移宿主 ${kind} 查询缺失、重复或没有原始观测 ID`);
    for(const item of expected) {
      const match=actual.find(x=>key(x)===key(item));
      engine.ensure(match&&valid(item,match),`迁移宿主 ${kind} ${key(item)} 未证明终态`);
    }
  };
  const actors=s.jobs.filter(j=>j.executor==='agent'&&!!j.nativeId).map(j=>({jobId:j.id,nativeId:j.nativeId,
    state:j.status==='done'?'completed':'cancelled',legacyLogicalCancellation:j.status==='cancelled'&&
      s.v3?.executionPath!=='unified-v03',observationId:''}));
  exact(actors,observed.actors,x=>x.jobId,(a,b)=>b.nativeId===a.nativeId&&
    (b.state===a.state || a.legacyLogicalCancellation&&b.state==='completed'),'actor');
  const dispatches=(s.v3?.dispatchRecords||[]).map(d=>({token:d.token,jobId:d.jobId,targetHost:d.targetHost,
    state:d.status==='prepared'?'not_found':d.status,nativeId:d.nativeId,observationId:''}));
  exact(dispatches,observed.dispatches,x=>x.token,(a,b)=>b.jobId===a.jobId&&b.targetHost===a.targetHost&&
    b.state===a.state&&(a.state==='not_found'?b.authoritative===true:b.nativeId===a.nativeId), 'dispatch token');
  const instances=[...(s.v3?.dispatchRecords||[]).flatMap(d=>d.instances),...(s.v3?.detachedInstances||[])]
    .filter(i=>!!i.nativeId).map(i=>({key:i.key,nativeId:i.nativeId!,state:i.state,observationId:''}));
  exact(instances,observed.instances,x=>x.key,(a,b)=>b.nativeId===a.nativeId&&b.state===a.state,
    '原生实例');
  const processes=s.jobs.flatMap(j=>{
    const rows:{jobId:string;kind:'command'|'test'|'dispatch';pid:number;state:'stopped';descendantsStopped:true;observationId:string}[]=[];
    const commandPid=Number(j.nativeId.match(/^command:(\d+):/)?.[1]);
    if(commandPid)rows.push({jobId:j.id,kind:'command',pid:commandPid,state:'stopped',descendantsStopped:true,observationId:''});
    if(j.testExecution?.pid)rows.push({jobId:j.id,kind:'test',pid:j.testExecution.pid,state:'stopped',descendantsStopped:true,observationId:''});
    for(const history of j.testProcessHistory||[])rows.push({jobId:j.id,kind:'test',pid:history.pid,
      state:'stopped',descendantsStopped:true,observationId:''});
    return rows;
  });
  for(const d of s.v3?.dispatchRecords||[])if(d.operationPid)processes.push({jobId:d.jobId,kind:'dispatch',
    pid:d.operationPid,state:'stopped',descendantsStopped:true,observationId:''});
  exact(processes,observed.processes,x=>`${x.jobId}:${x.kind}:${x.pid}`,(a,b)=>b.state==='stopped'&&
    b.descendantsStopped===true,'进程树 PID');
  engine.ensure(observed.processTree?.state==='stopped'&&observed.processTree.unknownChildren===0&&
    proof(observed.processTree),'迁移宿主未证明运行目录内全部子进程停止');
  engine.ensure(observed.externalActions?.state==='settled'&&observed.externalActions.unknown===0&&
    proof(observed.externalActions),'迁移宿主未证明外部动作和未知派发已结清');
  return {raw:output+'\n',challenge};
}
function verifyMigrationQuiescence(s: engine.State, statePath:string, decision: MigrationDecision) {
  const context=migrationContext(s,statePath);
  engine.ensure(decision?.schemaVersion===1 && decision.expectedRevision===s.revision &&
    decision.inventorySha256===context.inventorySha256 &&
    decision.ledgerSha256===context.ledgerSha256,
    '迁移清单或 revision 已过期；重新读取 migration-context 并查询宿主');
  engine.ensure(decision.statusIntent==='preserve' && decision.processTreeStopped===true &&
    decision.externalActionsSettled===true && Number.isFinite(Date.parse(decision.observedAt)) &&
    Math.abs(Date.now()-Date.parse(decision.observedAt))<=10*60_000,
    '迁移需要十分钟内的进程树停止、外部动作已结清与保持原状态的显式证明');
  safeFile(decision.evidencePath);
  engine.ensure(fs.readFileSync(decision.evidencePath,'utf8').trim(), '迁移对账依据不能为空');
  engine.ensure(!s.jobs.some(j=>active(j)), '迁移前先收取或停止全部在途任务');
  engine.ensure(!s.jobs.some(j=>j.testExecution), '迁移前测试进程树必须正式对账');
  engine.ensure(s.jobs.every(j=>(j.testProcessHistory||[]).every(h=>h.pid>0&&
    fs.existsSync(h.evidencePath)&&sha(fs.readFileSync(h.evidencePath))===h.evidenceSha256)),
    '历史测试进程 PID 的原始终态或停止证据缺失');
  engine.ensure(!s.jobs.some(j=>j.status==='done'&&!j.result ||
    j.status==='cancelled'&&!!j.nativeId&&!j.stopConfirmation?.processTreeStopped&&
      !(j.executor==='agent'&&s.v3?.executionPath!=='unified-v03')),
    '迁移前已结束任务须有原始结果，已取消 actor 须确认整个进程树停止');
  engine.ensure(!(s.v3?.skillChildren||[]).some(c=>c.pending || c.jobIds.some(id=>
    s.jobs.some(j=>j.id===id && active(j)))), '迁移前技能子任务必须逐项收取或停止');
  for(const d of s.v3?.dispatchRecords||[]) {
    engine.ensure(!d.operationPid && !['starting','running','uncertain'].includes(d.status),
      `派发 token ${d.token} 尚有在途或不确定动作；先按 token 查询并对账`);
    engine.ensure(d.status==='prepared' || ['completed','cancelled'].includes(d.status),
      `派发 token ${d.token} 未取得终态`);
    engine.ensure(d.events.every(e=>fs.existsSync(e.evidencePath) &&
      sha(fs.readFileSync(e.evidencePath))===e.digest),'派发 token 原始宿主事件缺失或已改变');
    if(d.status==='completed')engine.ensure(d.instances.some(i=>i.nativeId&&i.state==='completed'),
      `派发 token ${d.token} 缺少已完成的原生实例`);
    for(const i of d.instances) {
      if(i.key===`token:${d.token}` && i.state==='requested' && !i.nativeId)continue;
      engine.ensure(['completed','cancelled'].includes(i.state),
        `派发 token ${d.token} 存在未终止的原生实例`);
      engine.ensure(i.events.length>0 && i.events.every(e=>fs.existsSync(e.evidencePath) &&
        sha(fs.readFileSync(e.evidencePath))===e.digest), '原生实例终态证据缺失或已改变');
    }
  }
  for(const i of s.v3?.detachedInstances||[]) {
    engine.ensure(['completed','cancelled'].includes(i.state) && i.events.length>0 &&
      i.events.every(e=>fs.existsSync(e.evidencePath)&&sha(fs.readFileSync(e.evidencePath))===e.digest),
      '存在未绑定、未知或缺少原始证据的宿主实例');
  }
  engine.ensure(!(s.waitIntervals||[]).some(w=>w.kind==='recovery'&&!w.endedAt),
    '恢复等待区间尚未结清，不能迁移');
  return migrationHostQuiescence(s,statePath,context);
}
function backupMigration(statePath:string,s:engine.State,decisionPath:string,decision:MigrationDecision,
  host:{raw:string;challenge:string}) {
  const bytes=fs.readFileSync(statePath),backup=path.join(path.dirname(statePath),'migrations',
    `pre-v3-${randomUUID()}.json`);
  fs.mkdirSync(path.dirname(backup),{recursive:true});
  fs.copyFileSync(statePath,backup,fs.constants.COPYFILE_EXCL);
  const digest=sha(bytes);
  engine.ensure(sha(fs.readFileSync(backup))===digest,'迁移备份字节校验失败；原账本未改变');
  const hostDigest=sha(host.raw),hostPath=path.join(path.dirname(statePath),'host-observations',
    `migration-${sha(s.id+host.challenge).slice(0,20)}-${hostDigest.slice(0,20)}.json`);
  fs.mkdirSync(path.dirname(hostPath),{recursive:true});
  fs.writeFileSync(hostPath,host.raw,{flag:'wx',mode:0o444});
  engine.ensure(sha(fs.readFileSync(hostPath))===hostDigest,'迁移宿主观测归档字节校验失败');
  const record:NonNullable<engine.State['migrations']>[number]={at:new Date().toISOString(),
    fromProtocol:s.protocol??null,toProtocol:3,expectedRevision:s.revision,
    backupPath:backup,backupSha256:digest,decisionPath:path.resolve(decisionPath),
    decisionSha256:sha(fs.readFileSync(decisionPath)),quiescencePath:path.resolve(decision.evidencePath),
    quiescenceSha256:sha(fs.readFileSync(decision.evidencePath)),previousStatus:s.status,
    hostObservationPath:hostPath,hostObservationSha256:hostDigest,
    invalidatedTickets:[]};
  s.migrations??=[];s.migrations.push(record);
  return record;
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
    prs[n] = { ...p, checks: old?.head === p.head && old.base === p.base && old.ciMergeHead === p.ciMergeHead ? old.checks : [],
      ciMergeTree: old?.ciMergeHead === p.ciMergeHead ? old?.ciMergeTree : undefined };
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
      migrationRequired: prior.protocol !== engine.currentProtocol || !engine.unifiedSkillsReady(prior),
      next: engine.unifiedSkillsReady(prior)
        ? 'inspect 后实时 reconcile；不得重新认领已有任务'
        : prior.protocol === engine.currentProtocol
          ? '过渡运行只读；停稳后显式 migrate-skills 固定完整技能绑定'
          : '旧运行只读；继续派发前先对账、停止在途任务并显式 upgrade' };
  }
  const parent = gh.issue(repo, spec), children = gh.subIssues(repo, spec);
  engine.ensure(parent.state === 'OPEN', '目标 spec 已关闭'); engine.ensure(children.length, '目标 spec 尚无可读取的既有 sub-issues');
  const base = gh.targetHead(repo, inputs.targetBranch);
  excludeRuntime(repo.root);
  const v3 = engine.initialProtocolV3();
  v3.skillBindings = skills.defaultSkillBindings(skills.configuredSkillRoot());
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
export function packet(s: engine.State, j: engine.Job, statePath: string, sourceArchive?: RawSourceIndex) {
  requireBoundV3(s);
  const t = s.tickets.find(t => t.key === j.ticket);
  const disagreement=j.action==='adjudicate' && s.protocol===engine.currentProtocol && t
    ? engine.activeReviewDisagreement(s,t) : undefined;
  const regular=disagreement && s.v3?.skillInvocations.find(i=>i.id===disagreement.regularInvocationId);
  const fresh=disagreement && s.v3?.skillInvocations.find(i=>i.id===disagreement.freshInvocationId);
  const child = j.childRequestId ? s.v3?.skillChildren?.find(x => x.id === j.childRequestId) : undefined;
  const resumableSkill=s.v3?.skillInvocations.find(i=>!i.result && i.jobId!==j.id &&
    s.jobs.some(old=>old.id===i.jobId&&old.status==='cancelled'&&old.ticket===j.ticket&&
      old.epoch===j.epoch&&old.action===j.action&&old.candidateVersion===j.candidateVersion));
  const out = path.join(path.dirname(statePath), 'jobs', sha(j.id).slice(0, 20));
  if (j.action === 'repair-receipt') {
    fs.mkdirSync(out,{recursive:true});
    const original=s.jobs.find(x=>x.id===j.repairOfJobId), revision=s.v3?.receiptRecords
      ?.find(x=>x.jobId===original?.id)?.revisions.find(x=>x.id===j.repairTargetRevisionId);
    engine.ensure(original && revision, '独立修复任务缺少原始回执上下文');
    return {jobId:j.id,action:j.action,tier:j.tier,model:j.model,dispatchToken:j.dispatchToken,
      fresh:j.fresh,contextKey:j.contextKey,contextIntent:j.contextIntent || null,
      inputVersion:j.inputVersion,candidateVersion:j.candidateVersion,
      repairContext:{originalJobId:original.id,originalAction:original.action,rawPath:revision.rawPath,
        rawSha256:revision.rawSha256,parseOrValidationError:revision.error || '',
        previousRevisionId:revision.id,expectedHead:original.head,expectedBase:original.base,
        evidencePath:original.result?.evidencePath || '',previousSourceHostEvent:revision.sourceHostEvent || ''},
      outputDirectory:out,resultPath:path.join(out,'result.json'),rolesPath,
      resourceGrant:{agentSlots:1,testBatches:0,nestedAgents:false,worktreeWrite:false},
      note:'只纠正回执格式；读取原始字节及上下文后返回完整 JSON 结果。禁止实现、推送、评论、合并或修改工作区。'};
  }
  const authored = engine.actionMetadata[j.action].authored;
  const freshInitial = j.fresh && ['review-lens', 'pr-review'].includes(j.action);
  const freshChild = !!child && j.fresh;
  const prior = (child || freshInitial ? [] : s.jobs.filter(x => x.ticket === j.ticket && x.status === 'done' && x.result &&
    (j.action === 'review-report' ? x.epoch === j.epoch && ['review-lens', 'confirm', 'adjudicate'].includes(x.action)
      : !j.fresh && (authored || ['pr-review', 'review-lens', 'confirm', 'review-report'].includes(x.action)))))
    .map(x => { archiveResult(statePath,x); return { action: x.action, epoch: x.epoch, head: x.head, base: x.base, status: x.result!.status,
      resultPath: resultPaths(statePath,x.id).result }; });
  // 旧结果保持完整归档；每次派发只带当前轮的索引，完整历史按需读取。
  const relevant = prior.filter(x => x.epoch === j.epoch || x.head === j.head);
  const priorPath = path.join(out, 'prior-index.json');
  if (!freshInitial && !freshChild) write(priorPath, prior);
  const objective = j.fresh && (child || ['pr-review', 'review-lens', 'confirm'].includes(j.action))
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
    blockingReason: j.fresh && (child || ['pr-review','review-lens','confirm'].includes(j.action)) ? '' : t?.reason || t?.lastProblem || '',
    planPath: j.fresh && j.action !== 'plan-check' ? '' : t?.planPath || '',
    checksPath: freshInitial || freshChild ? '' : t?.checksPath || '',
    handoffPath: j.fresh && j.action !== 'replan' ? '' : authored ? t?.handoffPath || '' : t?.reviewHandoff || '',
    sourceUrl: `https://${s.repo.host}/${s.repo.slug}/issues/${t?.number || s.spec}`,
    reviewContext: t && (j.action==='author-review' || child?.skillCapability==='authorReview')
      ? { ...authorReviewSources(s,t,j.head,j.base), fixedPoint:j.base,
          instruction:'按当前固定的 authorReview 技能包及其依赖执行；原始 issue/spec、候选和规范来源由本 packet 提供。' }
      : null,
    objectiveEvidence: objective, prior: relevant.slice(-20), historyIndexPath: freshInitial || j.fresh && j.action !== 'review-report' ? '' : priorPath,
    sourceArchive: sourceArchive || null,
    rawSources: freshInitial || freshChild ? {specUrl:`https://${s.repo.host}/${s.repo.slug}/issues/${s.spec}`,
      issueUrl:`https://${s.repo.host}/${s.repo.slug}/issues/${t?.number || s.spec}`,
      candidate:{head:j.head,base:j.base,worktree:t?.worktree || ''},tests:t?.evidence.tests || null,
      visual:t?.evidence.visual || null,
      standards:sourceArchive ? sourceArchive.files.filter(file=>file.kind==='standard').map(file=>file.archivePath)
        : ['AGENTS.md','CLAUDE.md'].map(name=>path.join(s.repo.root,name)).filter(fs.existsSync),
      archivePath:sourceArchive?.manifestPath || null,
      sourceIndex:sourceArchive?.files || []} : null,
    finding: freshInitial ? null : j.finding || null,
    dispute: freshInitial ? null : j.dispute ? Object.fromEntries(Object.entries(j.dispute).map(([key, id]) => [key, resultPaths(statePath, id).result])) : null,
    reviewDisagreement: disagreement && regular?.result && fresh?.result ? {
      id:disagreement.id,head:disagreement.head,base:disagreement.base,
      candidateVersion:disagreement.candidateVersion,skillFingerprint:disagreement.skillFingerprint,
      regular:{invocationId:regular.id,blocking:disagreement.regularBlocking,
        reportPath:regular.result.rawOutputPath,reportSha256:regular.result.rawOutputSha256,
        sourceArchivePath:regular.sourceArchivePath,
        evidence:regular.result.evidencePaths.map((file,index)=>({path:file,sha256:regular.result!.evidenceSha256[index]}))},
      fresh:{invocationId:fresh.id,blocking:disagreement.freshBlocking,
        reportPath:fresh.result.rawOutputPath,reportSha256:fresh.result.rawOutputSha256,
        sourceArchivePath:fresh.sourceArchivePath,
        evidence:fresh.result.evidencePaths.map((file,index)=>({path:file,sha256:fresh.result!.evidenceSha256[index]}))},
      resultStatus:'resolved',requiredData:['disagreementId','regularInvocationId','freshInvocationId',
        'skillFingerprint','blocking','rationale','skillRuleRefs'],
      note:'L1 新上下文独立读取两轮原始报告、专业依据和同版本技能规则；以当前候选解释阻断差异。此决定不替代 CI 或 L2 验收。'
    } : null,
    remainingWork: j.ticket === '$spec' ? s.tickets.map(x => ({number:x.number,phase:x.phase,dependencies:x.dependencies,reason:x.reason})) : [],
    lens: j.action === 'review-lens' ? engine.lenses[Number(j.part)] : '',
    skillBindings: s.v3?.skillBindings?.map(b => ({ capability: b.capability, name: b.name,
      sourcePath: b.sourcePath, fingerprint: b.fingerprint })) || [],
    skillCall: child?.skillCapability
      ? { capabilities: [child.skillCapability], command: 'skill-start', finishCommand: 'skill-finish',
          resultField: 'data.skillInvocationIds', note: '通过已固定的能力绑定调用引用技能，并提交原始宿主回执。' }
      : j.action === 'implement'
      ? { capabilities: engine.actionMetadata[j.action].skills, command: 'skill-start',
          finishCommand: 'skill-finish', resultField: 'data.skillInvocationIds',
          note: '按批准计划选择 implement 或 diagnosing-bugs，测试走 test 预算入口。implement 内请求 /code-review 时，在 implementation 父调用下以 skill-delegate 委派一次当前 authorReview，head 为已提交候选；diagnosis 若没有内嵌审查，完成后由单个 author-review job 补审。完成候选后调用原始 handoff。' }
      : j.action === 'author-review'
      ? { capabilities:engine.actionMetadata[j.action].skills,command:'skill-start',finishCommand:'skill-finish',
          resultField:'data.skillInvocationIds',note:'对当前候选调用已绑定作者审查技能；技能自行委派专业子任务。' }
      : j.action === 'pr-review'
      ? { capabilities: engine.actionMetadata[j.action].skills, command: 'skill-start', finishCommand: 'skill-finish',
          delegateCommand: 'skill-delegate', childrenCommand: 'skill-children', resultField: 'data.skillInvocationIds',
          note: '按绑定技能包的 SKILL.md 和 automation-context.md 实际执行。技能按需登记子任务；提交完成的原始报告及宿主回执。跳过/未完成必须如实返回，不能签发 reviewed。' }
      : null,
    rolesPath, outputDirectory: out, resultPath: path.join(out, 'result.json'),
    resourceGrant: { agentSlots: j.executor === 'agent' ? 1 : 0, testBatches: j.tests, nestedAgents: false },
    note: child ? '执行技能请求的本子任务；独立上下文要求由宿主证明。不要派隐藏 agent；以 completed、failed 或 incomplete 返回结果。' :
      j.action === 'pr-review' ? '按已绑定技能的方法执行，并用 skill-delegate 登记所需子任务；不得自行派隐藏 agent。' :
      '读角色约束与来源；仅执行本 job。main loop 由内核调度，agent 不自行派隐藏子 agent。' };
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
function validateResult(s: engine.State, j: engine.Job, r: engine.Result, statePath: string) {
  verifyHandoffRef(j);
  safeFile(r.evidencePath);
  if (r.handoffPath) safeFile(r.handoffPath);
  if(j.action==='spec-audit'&&r.status==='waiting_human') {
    const url=String(r.data?.humanHandoffUrl||'');
    const issues=[gh.issue(s.repo,s.spec),...s.tickets.filter(t=>t.kind==='human').map(t=>gh.issue(s.repo,t.number))];
    const criteria=new Set([...s.specCriteria,...s.tickets.flatMap(t=>t.criteria)]);
    engine.ensure(issues.some(issue=>issue.comments.some(c=>c.url===url))&&
      Array.isArray(r.data?.pendingCriteria)&&
      (r.data.pendingCriteria as unknown[]).every(c=>typeof c==='string'&&criteria.has(c)),
      '人工交接须已发布在既有人工 issue 或父 spec，列明原 spec 待验条件');
  }
  if(j.action==='spec-audit'&&r.status==='needs_closeout')safeFile(String(r.data?.planPath||''));
  if (s.v3?.skillBindings && r.data?.skillInvocationIds) {
    engine.ensure(Array.isArray(r.data.skillInvocationIds) && r.data.skillInvocationIds.every(x => typeof x === 'string'),
      '技能调用引用必须是 ID 数组');
    skills.verifySkillResultFiles(s, j, r.data.skillInvocationIds as string[], r.handoffPath);
  }
  const t = s.tickets.find(t => t.key === j.ticket); if (!t || !r.complete) return;
  if (s.protocol === engine.currentProtocol && ['publish','merge'].includes(j.action)) {
    const kind=j.action, file=path.join(path.dirname(statePath),'actions',`${sha(j.id).slice(0,20)}.${kind}.intent.json`);
    const intent=read<{operationId:string;jobId:string;head:string;base:string;pr?:number}>(safeFile(file));
    engine.ensure(intent.jobId===j.id&&intent.head===j.head&&intent.base===j.base&&
      r.data?.operationId===intent.operationId&&r.evidencePath===path.join(path.dirname(statePath),'actions',
        `${sha(j.id).slice(0,20)}.${kind}.json`),
      'PR/合并结果缺少当前候选的稳定操作意图与远端对账证据');
  }
  if (j.action === 'accept' && r.status === 'ready' && r.data?.ciWaiver) {
    const waiver = r.data.ciWaiver as Record<string, unknown>;
    const file = path.resolve(String(waiver.evidence || ''));
    const record=s.ciAttestations?.find(a=>a.path===file&&a.jobId===j.id&&a.reason===waiver.reason&&
      a.head===t.head&&a.base===t.base);
    engine.ensure(record && file.startsWith(path.join(path.dirname(statePath),'ci')+path.sep) &&
      fs.statSync(file).isFile() && sha(fs.readFileSync(file))===record.sha256,
      'CI 豁免必须引用当前运行 ci-attest 的原始远端观测');
    const attestation = read<{jobId:string;reason:string;pr:number;head:string;base:string;checks:gh.CheckFact[];
      inventory?:ReturnType<typeof gh.workflowInventory>;required?:string[];
      notices?:ReturnType<typeof gh.checkRunNotice>[]}>(file);
    engine.ensure(attestation.jobId === j.id && attestation.pr === t.pr &&
      attestation.head === t.head && attestation.base === t.base &&
      attestation.reason === waiver.reason && waiver.verification === 'remote' &&
      waiver.observedHead === t.head && waiver.observedBase === t.base &&
      JSON.stringify(attestation.checks) === JSON.stringify(s.facts.prs[String(t.pr)]?.checks),
      'CI 豁免观测与当前 job、候选或远端检查不一致');
    if (waiver.reason === 'no_ci') engine.ensure(attestation.inventory?.length === 0 && attestation.required?.length === 0 &&
      attestation.checks.length === 0 && r.data.ciConfigured === false,
      '无 CI 豁免须有空检查和空工作流清单');
    else engine.ensure(waiver.reason === 'billing' && Array.isArray(waiver.notStartedIds) &&
      (waiver.notStartedIds as unknown[]).length > 0 &&
      (waiver.notStartedIds as unknown[]).every(id => attestation.notices?.some(n => n.id === id &&
        /bill(?:ing)?|payment|spending limit|额度|计费|付款/i.test(`${n.title} ${n.summary}`))),
      '计费豁免须逐项引用远端未启动检查及计费通知');
  }
  if (s.v3?.skillBindings && j.action==='implement' && r.status==='implemented') {
    const professional=(r.data?.skillInvocationIds as string[] || []).map(id=>s.v3!.skillInvocations.find(i=>i.id===id))
      .find(i=>i?.capability==='implementation' || i?.capability==='diagnosis');
    for(const child of (s.v3.skillChildren || []).filter(c=>c.parentInvocationId===professional?.id && c.skillCapability==='authorReview')) {
      const actor=s.jobs.find(x=>x.id===child.jobIds.at(-1));
      engine.ensure(actor && actor.result?.status==='completed', '内嵌作者自检子任务未完成');
      const ids=actor.result.data?.skillInvocationIds;
      engine.ensure(Array.isArray(ids), '内嵌作者自检缺少技能调用');
      skills.verifySkillResultFiles(s,actor,ids as string[]);
      for(const id of ids as string[]) {
        const invocation=s.v3.skillInvocations.find(i=>i.id===id);
        engine.ensure(invocation?.reviewSources?.fingerprint===authorReviewSources(s,t,r.head!,r.base!).fingerprint,
          '内嵌作者自检的 spec/规范、计划或候选来源已过期');
      }
    }
  }
  if (s.v3?.skillBindings && j.action==='author-review') {
    const id=(r.data?.skillInvocationIds as string[] || [])[0];
    const invocation=s.v3.skillInvocations.find(i=>i.id===id);
    engine.ensure(invocation?.reviewSources?.fingerprint===authorReviewSources(s,t,j.head,j.base).fingerprint,
      '作者自检的 spec/规范、计划或候选来源已过期');
  }
  if (s.v3?.skillBindings && ['verify','publish','pr-review','review-lens','confirm','review-report','accept','merge'].includes(j.action))
    requireCurrentAuthorReview(s,t);
  if (s.protocol === engine.currentProtocol && j.action === 'adjudicate' && j.part === 'pr-review') {
    const dispute=engine.activeReviewDisagreement(s,t);
    engine.ensure(dispute && j.fresh && j.contextObservation?.mode==='new',
      '审查分歧必须由当前候选的全新 L1 会话裁决');
    const report=read<Record<string,unknown>>(r.evidencePath);
    const fields=['disagreementId','regularInvocationId','freshInvocationId','skillFingerprint','blocking','rationale','skillRuleRefs'];
    engine.ensure(fields.every(key=>JSON.stringify(report[key])===JSON.stringify(r.data?.[key])) &&
      report.disagreementId===dispute.id && report.regularInvocationId===dispute.regularInvocationId &&
      report.freshInvocationId===dispute.freshInvocationId && report.skillFingerprint===dispute.skillFingerprint &&
      report.head===dispute.head && report.base===dispute.base &&
      report.candidateVersion===dispute.candidateVersion &&
      typeof report.blocking==='boolean' && typeof report.rationale==='string' && report.rationale.trim() &&
      Array.isArray(report.skillRuleRefs) && report.skillRuleRefs.length>0,
      'L1 裁决原文必须绑定当前候选、两轮报告和技能规则');
    const first=s.v3?.skillInvocations.find(i=>i.id===dispute.regularInvocationId);
    const bundle=first && read<{files:{relativePath:string}[]}>(first.sourceArchivePath);
    engine.ensure(bundle && (report.skillRuleRefs as unknown[]).every(ref=>typeof ref==='string' &&
      bundle.files.some(file=>ref===file.relativePath || ref.startsWith(file.relativePath+'#'))),
      'L1 裁决必须引用归档技能包内的规则文件');
    verifyReviewInvocation(s,dispute.regularInvocationId);
    verifyReviewInvocation(s,dispute.freshInvocationId);
  }
  if (s.protocol === engine.currentProtocol && ['accept','merge'].includes(j.action)) verifyReviewEvidenceFiles(s,t);
  if (s.protocol === engine.currentProtocol && j.action === 'review-report') {
    const invocation=s.v3?.skillInvocations.find(i=>i.id===r.data?.reviewInvocationId);
    engine.ensure(invocation?.result?.rawOutputPath===r.evidencePath &&
      invocation.result.rawOutputSha256===sha(fs.readFileSync(r.evidencePath)),
      '已发布报告不是当前归档的技能原文');
    const marker=`<!-- spec-delivery:${s.id}:${t.key}:${t.phase}:${invocation.id} -->`;
    const expected=`${marker}\n\n${fs.readFileSync(r.evidencePath,'utf8').trimEnd()}\n`;
    engine.ensure(gh.prComments(s.repo,t.pr).some(c=>c.url===r.data?.commentUrl && c.body===expected),
      'PR 上未找到与技能原文一致的审查完成评论');
  }
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
function verifyReviewEvidenceFiles(s:engine.State,t:engine.Ticket) {
  for(const round of ['regular','fresh'] as const) {
    const evidence=t.evidence[round];
    engine.ensure(evidence?.skillInvocationId && evidence.skillFingerprint && evidence.rawReportSha256,
      `${round} 审查缺少原始技能报告及版本记录`);
    const invocation=s.v3?.skillInvocations.find(i=>i.id===evidence.skillInvocationId);
    const job=invocation && s.jobs.find(j=>j.id===invocation.jobId);
    const dispute=round==='fresh' && evidence.adjudicationId && s.v3?.reviewDisagreements?.find(d=>
      d.adjudicationJobId===evidence.adjudicationId && d.freshInvocationId===invocation?.id &&
      d.outcomeBlocking===false && d.head===t.head && d.base===t.base &&
      d.skillFingerprint===evidence.skillFingerprint);
    const decision=dispute && s.v3?.decisionRecords.find(d=>d.id===evidence.adjudicationId &&
      d.kind==='adjudication' && d.scope===t.key && d.candidateVersion===dispute.candidateVersion);
    const clear=invocation?.result?.status==='pass' && !invocation.result.blocking ||
      invocation?.result?.status==='changes_required' && invocation.result.blocking && !!decision;
    engine.ensure(invocation && job && invocation.capability==='prReview' &&
      invocation.bindingFingerprint===evidence.skillFingerprint && clear &&
      invocation.result?.rawOutputPath===evidence.path &&
      invocation.result.rawOutputSha256===evidence.rawReportSha256 &&
      invocation.head===t.head && invocation.base===t.base,
      `${round} 审查的技能、候选或原始报告已失效`);
    skills.verifySkillResultFiles(s,job,[invocation.id]);
    if(decision) {
      engine.ensure(decision.inputVersion===engine.inputVersion(s) &&
        decision.sourceVersion===s.planSourceVersion &&
        artifactFingerprint(decision.artifactFiles).digest===decision.artifactDigest,
        'L1 审查裁决及其输入产物已过期或被修改');
      verifySessionArtifact(decision.session);
    }
  }
}
function verifyReviewInvocation(s:engine.State,id:string) {
  const invocation=s.v3?.skillInvocations.find(i=>i.id===id);
  const job=invocation && s.jobs.find(j=>j.id===invocation.jobId);
  engine.ensure(invocation && job && invocation.capability==='prReview' && invocation.result,
    '审查调用缺少完整原始记录');
  skills.verifySkillResultFiles(s,job,[id]);
}
function verify(s: engine.State, j: engine.Job, statePath: string): engine.Result {
  const t = engine.ticket(s, j.ticket);
  engine.ensure(j.action === 'verify' && active(j), '该 job 不是验证任务');
  requireCurrentAuthorReview(s,t);
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
      const r = spawnSync(c.argv[0], c.argv.slice(1), { cwd: t.worktree, env: testCommandEnv(c.env), shell: false,
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
  const listed=git(s.repo.root,'worktree','list','--porcelain').split(/\n\n/).filter(Boolean).map(block=>{
    const lines=block.split('\n');
    return {path:lines.find(line=>line.startsWith('worktree '))?.slice(9),
      branch:lines.find(line=>line.startsWith('branch '))?.slice(7),
      locked:lines.some(line=>line==='locked'||line.startsWith('locked '))};
  });
  const registered=listed.find(row=>row.path===path.resolve(t.worktree));
  const wtExists = fs.existsSync(t.worktree);
  engine.ensure(!registered?.locked,'worktree 已锁定或仍在使用，保留远端分支');
  engine.ensure(!listed.some(row=>row.branch===`refs/heads/${t.branch}`&&row.path!==path.resolve(t.worktree)),
    '分支仍被其他 worktree 使用，保留远端分支');
  engine.ensure(wtExists?registered?.branch===`refs/heads/${t.branch}`:!registered,
    '登记的 worktree 状态与资源账本不符，保留远端分支');
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
  // First release the local worktree. Git refuses locked or in-use worktrees;
  // the remote branch remains available when that safety check fails.
  if (wtExists) git(s.repo.root, 'worktree', 'remove', t.worktree);
  engine.ensure(!git(s.repo.root,'worktree','list','--porcelain').split(/\n\n/).some(block=>
    block.split('\n').includes(`branch refs/heads/${t.branch}`)),
    '分支仍被 worktree 使用，保留远端分支');
  // The lease refuses to delete a remote ref that changed during local cleanup.
  if (remoteHead) git(s.repo.root, 'push', `--force-with-lease=refs/heads/${t.branch}:${remoteHead}`, remote, `:refs/heads/${t.branch}`);
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
function publishReviewReport(s:engine.State,j:engine.Job):engine.Result {
  const t=engine.ticket(s,j.ticket);
  engine.ensure(s.protocol===engine.currentProtocol && ['review','fresh'].includes(t.phase) &&
    t.epoch===j.epoch && t.pr>0 && j.head===t.head && j.base===t.base,
    '只能发布当前候选与轮次的 PR 审查报告');
  const live=s.facts.prs[String(t.pr)];
  engine.ensure(live?.state==='OPEN' && !live.draft && live.head===j.head && live.base===j.base,
    'PR 审查报告对应的远端候选已改变或 PR 不可审查');
  const review=s.jobs.find(x=>x.ticket===t.key && x.epoch===t.epoch && x.action==='pr-review' &&
    x.status==='done' && x.result?.complete && x.result.status==='reviewed');
  const ids=review?.result?.data?.skillInvocationIds;
  engine.ensure(review && Array.isArray(ids) && ids.length===1,'本轮缺少完整 prReview 技能调用');
  const invocation=s.v3?.skillInvocations.find(i=>i.id===ids[0]);
  engine.ensure(invocation && invocation.jobId===review.id && invocation.capability==='prReview' &&
    invocation.candidateVersion===engine.candidateVersion(s,t) &&
    invocation.bindingFingerprint===s.v3?.skillBindings?.find(b=>b.capability==='prReview')?.fingerprint &&
    invocation.result && ['pass','changes_required'].includes(invocation.result.status) &&
    !!invocation.result.rawOutputPath,'PR 审查技能结果或版本已过期');
  skills.verifySkillResultFiles(s,review,[invocation.id]);
  const report=fs.readFileSync(safeFile(invocation.result.rawOutputPath),'utf8');
  engine.ensure(report.trim(),'技能没有生成原始审查报告');
  const marker=`<!-- spec-delivery:${s.id}:${t.key}:${t.phase}:${invocation.id} -->`;
  const body=`${marker}\n\n${report.trimEnd()}\n`;
  const existing=gh.prComments(s.repo,t.pr).find(c=>c.body.includes(marker));
  engine.ensure(!existing || existing.body===body,'已有审查评论与归档的技能原文不一致');
  let commentUrl=existing?.url;
  if(!commentUrl) {
    const bodyPath=path.join(path.dirname(invocation.sourceArchivePath),'review-comment.md');
    fs.writeFileSync(bodyPath,body);
    command(s.repo.root,'gh',['pr','comment',String(t.pr),'--repo',
      `${s.repo.host}/${s.repo.slug}`,'--body-file',bodyPath]);
    const posted=gh.prComments(s.repo,t.pr).find(c=>c.body.includes(marker));
    engine.ensure(posted?.body===body,'发布后未能核对技能报告原文');
    commentUrl=posted.url;
  }
  engine.ensure(!!commentUrl,'GitHub 未返回审查评论地址');
  return {model:j.model,complete:true,status:'posted',head:j.head,base:j.base,
    evidencePath:invocation.result.rawOutputPath,
    data:{commentUrl,reviewInvocationId:invocation.id}};
}
function closeIssue(s:engine.State,j:engine.Job,statePath:string):engine.Result {
  const t=s.tickets.find(t=>t.key===j.ticket), number=t?.number || s.spec;
  if(j.action==='spec-close') engine.ensure(s.specAudit?.status==='complete' && s.specAudit.base===s.facts.base && j.base===s.facts.base,'spec 验收已过期');
  else {
    engine.ensure(t && s.facts.prs[t.pr]?.state==='MERGED' && s.facts.prs[t.pr].baseRef===s.inputs.targetBranch &&
      engine.freshEvidence(t,'accept'),'工单未合并或缺少有效验收，不能关闭');
    const live=gh.pr(s.repo,t.pr),target=gh.targetHead(s.repo,s.inputs.targetBranch);
    engine.ensure(live.state==='MERGED'&&live.head===t.head&&live.baseRef===s.inputs.targetBranch&&
      !!live.mergedHead,'关闭前远端 PR 候选或目标分支已改变');
    git(s.repo.root,'fetch','--no-tags',selectRemote(s),s.inputs.targetBranch);
    git(s.repo.root,'merge-base','--is-ancestor',live.mergedHead,target);
    engine.ensure(gh.targetHead(s.repo,s.inputs.targetBranch)===target,
      '关闭核对期间目标分支变化，先重新观察');
  }
  const intent=operationIntent(statePath,j,'close',{issue:number,pr:t?.pr||null,
    head:t?.head||null,base:j.base,target:s.inputs.targetBranch});
  if(s.facts.issueStates[number]!=='CLOSED') command(s.repo.root,'gh',['issue','close',String(number),'--repo',`https://${s.repo.host}/${s.repo.slug}`,'--reason','completed']);
  const issue=gh.issue(s.repo,number);engine.ensure(issue.state==='CLOSED','尚未观察到 issue 关闭');
  const evidencePath=path.join(path.dirname(statePath),'actions',sha(j.id).slice(0,20)+'.close.json');
  write(evidencePath,{jobId:j.id,operationId:intent.operationId,issue:number,state:issue.state,
    base:s.facts.base,acceptance:t?.evidence.accept || s.specAudit});
  return {model:j.model,complete:true,status:'closed',base:j.base,evidencePath,
    data:{operationId:intent.operationId}};
}
function operationIntent<T extends object>(statePath:string,j:engine.Job,kind:string,input:T) {
  const operationId=`${kind}:${sha(j.id).slice(0,24)}`;
  const file=path.join(path.dirname(statePath),'actions',`${sha(j.id).slice(0,20)}.${kind}.intent.json`);
  const intent={operationId,jobId:j.id,kind,...input};
  if(fs.existsSync(file))engine.ensure(JSON.stringify(read(file))===JSON.stringify(intent),
    '远端操作意图已固定；不能在响应不确定后改变目标或内容');
  else write(file,intent);
  return {operationId,file};
}
function publishPr(statePath:string,jobId:string,request:{title:string;bodyPath:string;completionPath:string}):engine.Result {
  const s=read<engine.State>(statePath);requireUnified(s);
  const j=s.jobs.find(j=>j.id===jobId);engine.ensure(j?.action==='publish'&&active(j)&&j.nativeId,
    '只允许已绑定的当前发布任务创建 PR');
  const t=engine.ticket(s,j.ticket);
  engine.ensure(t.phase==='publish'&&t.epoch===j.epoch&&t.head===j.head&&t.base===j.base&&
    engine.freshEvidence(t,'tests')&&engine.freshEvidence(t,'self')&&
    localHead(t)===t.head&&clean(t),'发布意图的候选或测试证据已过期');
  requireCurrentAuthorReview(s,t);
  engine.ensure(gh.targetHead(s.repo,s.inputs.targetBranch)===t.base,'目标分支已变化，先集成并重审');
  engine.ensure(request.title?.trim(),'PR 需要标题');
  const body=fs.readFileSync(safeFile(request.bodyPath),'utf8');
  const completion=fs.readFileSync(safeFile(request.completionPath),'utf8');
  // A revised candidate may use the same PR, but the original publish intent
  // remains its ownership proof. A ledger PR number alone is insufficient.
  if(t.pr>0) {
    const original=s.jobs.find(previous=>previous.ticket===t.key&&previous.action==='publish'&&
      previous.status==='done'&&previous.result?.status==='published'&&
      previous.result.data?.pr===t.pr&&
      previous.result.data.operationId===`publish:${sha(previous.id).slice(0,24)}`);
    engine.ensure(original,'复用 PR 缺少原始发布操作记录');
    const originalMarker=`<!-- spec-delivery:${s.id}:${t.key}:pr:${original.result!.data!.operationId} -->`;
    engine.ensure(gh.pullRequestWithMarker(s.repo,t.branch,s.inputs.targetBranch,originalMarker)===t.pr,
      '原 PR 已失去固定归属标记；不能发布新完成评论');
  }
  const intent=operationIntent(statePath,j,'publish',{head:t.head,base:t.base,branch:t.branch,
    title:request.title,bodySha256:sha(body),completionSha256:sha(completion)});
  const prMarker=`<!-- spec-delivery:${s.id}:${t.key}:pr:${intent.operationId} -->`;
  const commentMarker=`<!-- spec-delivery:${s.id}:${t.key}:published:${intent.operationId} -->`;
  const prBody=`${prMarker}\n\n${body.trimEnd()}\n`;
  const commentBody=`${commentMarker}\n\n${completion.trimEnd()}\n`;
  // A repaired candidate keeps its original PR. GitHub advances that PR's head when
  // the issue branch is pushed; a new publish intent posts a new completion comment.
  const reusedPr=t.pr>0;
  let number=reusedPr?t.pr:gh.pullRequestWithMarker(s.repo,t.branch,s.inputs.targetBranch,prMarker);
  if(!number) {
    const attempt=path.join(path.dirname(statePath),'actions',`${sha(j.id).slice(0,20)}.pr-create.attempt.json`);
    engine.ensure(!fs.existsSync(attempt),'PR 创建曾发出但远端尚未确认；保留操作意图，不能盲目重发');
    write(attempt,{operationId:intent.operationId,head:t.head,base:t.base,at:new Date().toISOString()});
    try {number=gh.createPullRequest(s.repo,{title:request.title,headRef:t.branch,
      baseRef:s.inputs.targetBranch,body:prBody});}
    catch(error){number=gh.pullRequestWithMarker(s.repo,t.branch,s.inputs.targetBranch,prMarker);if(!number)throw error;}
  }
  if(!reusedPr)engine.ensure(gh.pullRequestWithMarker(s.repo,t.branch,s.inputs.targetBranch,prMarker)===number,
    '创建后未能按固定操作标记核对远端 PR');
  const pr=gh.pr(s.repo,number);
  engine.ensure(pr.state==='OPEN'&&!pr.draft&&pr.head===t.head&&pr.base===t.base&&
    pr.baseRef===s.inputs.targetBranch&&pr.headRef===t.branch,'创建后 PR 不是预期候选');
  const existing=gh.prComments(s.repo,number).find(c=>c.body.includes(commentMarker));
  engine.ensure(!existing||existing.body===commentBody,'已有完成评论内容与固定发布意图不一致');
  let commentUrl=existing?.url;
  if(!commentUrl) {
    const attempt=path.join(path.dirname(statePath),'actions',`${sha(j.id).slice(0,20)}.pr-comment.attempt.json`);
    engine.ensure(!fs.existsSync(attempt),'完成评论曾发出但远端尚未确认；不能盲目重发');
    write(attempt,{operationId:intent.operationId,pr:number,at:new Date().toISOString()});
    try {commentUrl=gh.postIssueComment(s.repo,number,commentBody);}
    catch(error){const posted=gh.prComments(s.repo,number).find(c=>c.body===commentBody);
      if(!posted)throw error;commentUrl=posted.url;}
  }
  engine.ensure(gh.prComments(s.repo,number).some(c=>c.url===commentUrl&&c.body===commentBody),
    '发布后未能按固定操作标记核对完成评论');
  const evidencePath=path.join(path.dirname(statePath),'actions',`${sha(j.id).slice(0,20)}.publish.json`);
  write(evidencePath,{...intent,pr:number,commentUrl,head:pr.head,base:pr.base,at:new Date().toISOString()});
  return {model:j.model,complete:true,status:'published',head:j.head,base:j.base,evidencePath,
    data:{pr:number,commentUrl,operationId:intent.operationId}};
}
function mergePr(statePath:string,jobId:string,request:{strategy:'merge'|'squash'|'rebase'}):engine.Result {
  const s=read<engine.State>(statePath);requireUnified(s);
  const j=s.jobs.find(j=>j.id===jobId);engine.ensure(j?.action==='merge'&&active(j)&&j.nativeId,
    '只允许已绑定的当前合并任务操作 PR');
  const t=engine.ticket(s,j.ticket);
  engine.ensure(t.epoch===j.epoch&&t.head===j.head&&t.base===j.base&&
    ['merge','blocked'].includes(t.phase),'合并任务候选或轮次已改变');
  engine.ensure(['merge','squash','rebase'].includes(request.strategy),'合并策略必须显式指定');
  const intent=operationIntent(statePath,j,'merge',{pr:t.pr,head:t.head,base:t.base,
    target:s.inputs.targetBranch,strategy:request.strategy});
  const marker=`spec-delivery operation ${intent.operationId}`;
  const observed=observe(s,[j]);s.facts=observed;
  const live=observed.prs[String(t.pr)];
  let uncertain='';
  if(live?.state!=='MERGED') {
    const attempt=path.join(path.dirname(statePath),'actions',`${sha(j.id).slice(0,20)}.merge.attempt.json`);
    if(fs.existsSync(attempt)) uncertain='已有合并请求但远端仍开放；等待平台结果或显式 L1 对账';
    else {
      requireCurrentAuthorReview(s,t);
      if(s.protocol===engine.currentProtocol)verifyReviewEvidenceFiles(s,t);
      engine.ensure(engine.mergeGate(s,t),'合并前远端 head/base、审查、验收或 CI 门禁已改变');
      write(attempt,{operationId:intent.operationId,pr:t.pr,head:t.head,base:t.base,at:new Date().toISOString()});
      try {gh.mergePullRequest(s.repo,t.pr,t.head,request.strategy,marker);}
      catch(error){const after=gh.pr(s.repo,t.pr);if(after.state!=='MERGED')uncertain=(error as Error).message;}
    }
  }
  const after=gh.pr(s.repo,t.pr);
  engine.ensure(after.head===t.head&&after.baseRef===s.inputs.targetBranch,
    '合并后远端 PR 候选或目标不符');
  const status=after.state==='MERGED'?'merged':'waiting_merge';
  if(status==='merged')engine.ensure(!!after.mergedHead,'远端尚未给出合并提交');
  const evidencePath=path.join(path.dirname(statePath),'actions',`${sha(j.id).slice(0,20)}.merge.json`);
  write(evidencePath,{...intent,status,mergedHead:after.mergedHead,uncertain,at:new Date().toISOString()});
  return {model:j.model,complete:true,status,head:j.head,base:j.base,evidencePath,
    data:{operationId:intent.operationId,mergedHead:after.mergedHead}};
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
    s = read<engine.State>(statePath); requireUnified(s); engine.ensure(s.status === 'running', 'workflow 未运行；暂停后不能执行命令任务');
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
  const r = recorded || (j.action === 'verify' ? verify(s, j, statePath) : j.action === 'claim' ? claim(s,j,statePath) :
    j.action === 'review-report' && s.protocol===engine.currentProtocol ? publishReviewReport(s,j) :
    ['close','spec-close'].includes(j.action) ? closeIssue(s,j,statePath) : cleanup(s, j, statePath));
  if(!recorded) write(receiptPath,{jobId:j.id,startedAt,finishedAt:new Date().toISOString(),result:r});
  release = lock(statePath);
  try {
    const latest = read<engine.State>(statePath); latest.facts = observe(latest,[j]);
    if(j.action==='claim' || j.action==='review-report' && latest.protocol===engine.currentProtocol) validateResult(latest,j,r,statePath);
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
  nativeId?: string; authoritative?: boolean; result?: unknown; resultFile?: string;
  /** Optional for older adapters; when present it binds the exact file bytes consumed below. */
  resultSha256?: string;
  /** Human-readable terminal text is never parsed as a receipt. */
  finalText?: string; continuationSupported?: boolean; startedAt?: string; completedAt?: string;
  cancelledAt?: string; usage?: engine.Json; usageScope?: 'session' | 'model_call';
  modelCallId?: string; provider?: string;
}
interface HostCall { ref: engine.HostEventRef; reply?: HostReply; error?: string }
function verifyHostResultDigest(bytes:Buffer,digest:unknown) {
  if(digest===undefined)return;
  engine.ensure(typeof digest==='string'&&/^[0-9a-f]{64}$/.test(digest)&&sha(bytes)===digest,
    '宿主结果文件与终态绑定 SHA-256 不一致');
}
/** The adapter is a trusted host process. Its raw reply is archived before it can change the ledger. */
function callHost(statePath: string, d: engine.DispatchRecord, kind: engine.HostEventRef['kind']): HostCall {
  engine.ensure(sha(fs.readFileSync(safeFile(d.requestPath)))===d.requestDigest,
    '持久派发请求已改变；禁止向宿主发送未签发的 token/model/job');
  const adapter = process.env.SPEC_DELIVERY_HOST_ADAPTER;
  engine.ensure(adapter && path.isAbsolute(adapter) && fs.statSync(adapter).isFile(),
    '宿主未提供可信派发适配器 SPEC_DELIVERY_HOST_ADAPTER');
  const invokedAt = new Date().toISOString();
  const run = spawnSync(adapter, [kind, d.requestPath], { cwd: path.dirname(statePath), encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const at = new Date().toISOString();
  const raw = { kind, requestPath: d.requestPath, invokedAt, at, exitCode: run.status, signal: run.signal,
    stdout: run.stdout || '', stderr: run.stderr || '', spawnError: run.error?.message || null };
  const bytes = JSON.stringify(raw, null, 2) + '\n', digest = sha(bytes);
  const evidencePath = path.join(path.dirname(statePath), 'host-events', sha(d.token).slice(0, 20), `${at.replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const fd = fs.openSync(evidencePath, 'wx', 0o444);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const ref = { kind, evidencePath, digest, at, invokedAt };
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
function appendHostUsage(instance:engine.HostInstanceRecord,raw:engine.Json,ref:{
  sourcePath:string;sourceSha256:string;at:string;scope?:'session'|'model_call';modelCallId?:string;
  sourceIndex?:number;supportingEvidencePath?:string
}) {
  const scope:engine.HostUsageObservation['scope']=ref.scope===undefined?'session':
    ref.scope==='model_call' && !(typeof ref.modelCallId==='string'&&!!ref.modelCallId.trim())?'unknown':
    ref.scope==='session'||ref.scope==='model_call'?ref.scope:'unknown';
  const id=sha(JSON.stringify([instance.key,ref.sourcePath,ref.sourceSha256,scope,
    ref.modelCallId||'',ref.sourceIndex??null,sha(JSON.stringify(raw))]));
  instance.usageObservations??=[];
  if(!instance.usageObservations.some(x=>x.id===id))instance.usageObservations.push({
    id,at:ref.at,sourcePath:ref.sourcePath,sourceSha256:ref.sourceSha256,
    raw,scope,modelCallId:ref.modelCallId,sourceIndex:ref.sourceIndex,
    supportingEvidencePath:ref.supportingEvidencePath});
  instance.rawUsage=raw;
}
/** A bad or unbound host reply is still an instance/event in the journal. */
function applyHostCall(statePath: string, jobId: string, call: HostCall): {
  state: HostState | 'uncertain'; nativeId?: string; result?: unknown; resultFile?: string; resultSha256?: string;
  sourceHostEvent: string; error?: string
} {
  const release = lock(statePath);
  try {
    const s = read<engine.State>(statePath); requireUnified(s);
    const d = s.v3!.dispatchRecords.find(x => x.jobId === jobId), j = s.jobs.find(x => x.id === jobId);
    engine.ensure(d && j, '派发任务不存在');
    d.events.push(call.ref); d.updatedAt = call.ref.at;
    const reply = call.reply;
    const key = reply?.nativeId ? `native:${reply.nativeId}` : `token:${d.token}`;
    let instance = d.instances.find(x => x.key === key);
    if (!instance) { instance = { key, nativeId: reply?.nativeId || null, state: 'unknown',
      firstSeenAt: call.ref.at, lastSeenAt: call.ref.at, events: [] }; d.instances.push(instance); }
    instance.events.push(call.ref); instance.lastSeenAt = call.ref.at;
    if (reply?.usage !== undefined) appendHostUsage(instance,reply.usage,{
      sourcePath:call.ref.evidencePath,sourceSha256:call.ref.digest,at:call.ref.at,
      scope:reply.usageScope,modelCallId:reply.modelCallId});
    if (reply?.provider) instance.observedProvider=reply.provider;
    if (typeof reply?.continuationSupported === 'boolean') instance.continuationSupported = reply.continuationSupported;
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
        instance.session = session;
        if (j.status === 'leased' || j.status === 'running') engine.bind(s, j.id, { nativeId: reply.nativeId!, session });
        else engine.ensure(j.nativeId === reply.nativeId, '已完成任务的宿主身份不能改变');
        d.nativeId = reply.nativeId;
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
    return error ? { state: 'uncertain', nativeId: reply?.nativeId, sourceHostEvent: call.ref.evidencePath, error } :
      { state: reply!.state, nativeId: reply!.nativeId, result: reply!.result,
        resultFile: reply!.resultFile, resultSha256: reply!.resultSha256,
        sourceHostEvent: call.ref.evidencePath };
  } finally { release(); }
}
function dispatchRound(statePath: string, jobId: string, launch: boolean) {
  const release = lock(statePath);
  let request: engine.DispatchRecord;
  try {
    const s = read<engine.State>(statePath); requireUnified(s);
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
      if (outcome.result === undefined && !outcome.resultFile)
        outcome = applyHostCall(statePath, jobId, callHost(statePath, request!, 'collect'));
      if (outcome.state === 'completed' && (outcome.result !== undefined || outcome.resultFile)) {
        try {
          let raw: Buffer, source: engine.ReceiptSource;
          if (outcome.result !== undefined) {
            raw = Buffer.from(typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result));
            source = 'host_structured';
          } else {
            const packetRecord=read<{outputDirectory:string}>(request!.packetPath);
            const output=fs.realpathSync(packetRecord.outputDirectory);
            const named=path.resolve(output,outcome.resultFile!);
            engine.ensure(named.startsWith(output+path.sep) && !fs.lstatSync(named).isSymbolicLink() &&
              fs.realpathSync(named)===named && fs.statSync(named).isFile(),
              '宿主结果文件必须是当前 packet 输出目录中的普通文件');
            raw=fs.readFileSync(named);
            verifyHostResultDigest(raw,outcome.resultSha256);
            source='host_file';
          }
          const current=read<engine.State>(statePath).jobs.find(j=>j.id===jobId)!;
          const receipt = current.action==='repair-receipt'
            ? stageRawResult(statePath,current.repairOfJobId!,raw,'repair',
              {sourceHostEvent:outcome.sourceHostEvent,sourceNativeId:outcome.nativeId,
                previousId:current.repairTargetRevisionId,repairJobId:current.id})
            : stageRawResult(statePath, jobId, raw, source,
              {sourceHostEvent:outcome.sourceHostEvent,sourceNativeId:outcome.nativeId});
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
  requireUnified(s);
  engine.ensure(s.v3,'ZCode 脚本只为已落盘 token 的 v3 派发生成');
  const entry=fileURLToPath(import.meta.url);
  return s.jobs.filter(j=>j.status==='leased'&&j.executor==='agent'&&!recovering(s,j))
    .flatMap(j=>{
      const d=s.v3!.dispatchRecords.find(d=>d.jobId===j.id);
      if(!d||d.status!=='prepared')return [];
      engine.ensure(fs.existsSync(d.requestPath)&&sha(fs.readFileSync(d.requestPath,'utf8'))===d.requestDigest,
        'ZCode 派发请求已改变');
      const p=read<{jobId:string;model:string;dispatchToken:string;executor?:string;action?:string;
        rolesPath:string;outputDirectory:string}>(d.packetPath);
      engine.ensure(p.jobId===j.id&&p.model===d.requestedModel&&p.dispatchToken===d.token&&
        (p.executor==='agent'||p.action==='repair-receipt'),'ZCode packet 与持久派发请求不符');
      const directory=path.join(path.dirname(statePath),'zcode','tokens',sha(d.token).slice(0,32));
      const prepared=prepareZcodeJob({workflowEntry:entry},d,p,directory);
      return [{jobId:j.id,token:d.token,requestPath:d.requestPath,scriptSha256:prepared.scriptSha256,
        loadSkill:'dynamic-workflows',tool:'CreateWorkflow',arguments:prepared.createWorkflow,
        note:'每个 job 有一个独立原生 workflow；顶层先按 token 查询，再创建并立即绑定已观测 actor。结果由 GetWorkflowRun 逐项收取，不能嵌套创建或靠批次模板绑定。'}];
    });
}
export function consumeStaged(statePath: string, ids?: string[]) {
  const release = lock(statePath);
  try {
    let s = read<engine.State>(statePath); allowCompletion(s);
    requireBoundV3(s);
    const jobs = s.jobs.filter(j => active(j) && j.nativeId && j.executor === 'agent' && engine.contextReady(j) &&
      s.tickets.find(t => t.key === j.ticket)?.phase !== 'recovery' && (!ids || ids.includes(j.id)) &&
      (!unifiedDispatchRequired(s,j) || (()=>{
        try {verifiedDispatchCompletion(s,j);return true;}catch{return false;}
      })()) &&
      (!s.v3?.dispatchRecords.find(d => d.jobId === j.id)?.managed ||
        s.v3.dispatchRecords.find(d => d.jobId === j.id)?.status === 'completed') &&
      fs.existsSync(resultPaths(statePath, j.id).ready) &&
      (s.protocol!==engine.currentProtocol || (()=>{
        const current=s.v3?.receiptRecords?.find(x=>x.jobId===j.id)?.currentId;
        if(!current)return false;
        try{return read<{revisionId?:string}>(resultPaths(statePath,j.id).ready).revisionId===current;}
        catch{return false;}
      })()));
    if (!jobs.length) return { submitted: [], rejected: [] };
    s.facts = observe(s, jobs);
    const submitted: string[] = [], rejected: {jobId:string; error:string}[] = [];
    for (const j of jobs) {
      try {
        const receipt = s.v3?.receiptRecords?.find(x => x.jobId === j.id);
        const revision = receipt?.revisions.find(x => x.id === receipt.currentId);
        if (s.protocol===engine.currentProtocol) {
          engine.ensure(revision,'协议 3 只从已归档的原始回执读取结果');
          engine.ensure(read<{revisionId?:string}>(resultPaths(statePath,j.id).ready).revisionId===revision.id,
            'ready 文件不指向当前不可变回执修订');
        }
        const raw = revision ? readReceiptRaw(revision) : read(resultPaths(statePath, j.id).result);
        const r = normalizeResult(s, j, raw);
        const trial = structuredClone(s), job = trial.jobs.find(x => x.id === j.id)!;
        if (trial.protocol === engine.currentProtocol) { engine.ensure(job.session, '模型任务缺少原生会话观测'); verifySessionArtifact(job.session); verifyHandoffRef(job); }
        engine.ensure(!job.testExecution,'测试进程未完成，不能提交任务');
        job.timing ??= {leasedAt:''}; job.timing.resultAt=read<{at:string}>(resultPaths(statePath,j.id).ready).at;
        if (trial.protocol === engine.currentProtocol && job.tier === 'L1') {
          const artifact = decisionArtifacts(trial, job, r);
          job.decisionArtifactDigest = artifact.digest; job.decisionArtifactFiles = artifact.files;
        }
        validateResult(trial, job, r, statePath); engine.submit(trial, job.id, r); journalBoundSession(trial, job);
        const accepted = trial.v3?.receiptRecords?.find(x => x.jobId === j.id)?.revisions.find(x => x.id === revision?.id);
        if (accepted) accepted.status = 'accepted';
        const record = trial.v3?.receiptRecords?.find(x => x.jobId === j.id);
        if (record && revision) record.acceptedId = revision.id;
        s = trial; submitted.push(j.id);
      } catch (error) {
        const record = s.v3?.receiptRecords?.find(x => x.jobId === j.id);
        const revision = record?.revisions.find(x => x.id === record.currentId);
        if (revision) { revision.status = 'rejected'; revision.error = (error as Error).message;
          recordReceiptFailure(s, j, statePath, revision, error as Error, true); }
        else recordRejectedReceipt(s, j, statePath, error as Error, true);
        rejected.push({jobId:j.id,error:(error as Error).message});
      }
    }
    save(statePath, s); return { submitted, rejected };
  } finally { release(); }
}
function receiptRecord(s: engine.State, jobId: string) {
  engine.ensure(s.v3, '缺少 v3 回执账本');
  s.v3.receiptRecords ??= [];
  let record = s.v3.receiptRecords.find(x => x.jobId === jobId);
  if (!record) { record = { jobId, revisions: [] }; s.v3.receiptRecords.push(record); }
  return record;
}
interface RecoveryDecision {
  kind: engine.RecoveryRecord['kind']; jobId: string; expectedRevision: number;
  dispatchToken: string; attempt: number; expectedCandidateVersion: string;
  reason: string; evidencePath: string; previousRevisionId?: string; rawPath?: string;
  expectedNativeId?: string; nativeId?: string; processTreeStopped?: boolean;
  observedState?: 'stopped' | 'lost'; continuationHostEvent?: string;
}
function recoveryTarget(s: engine.State, d: RecoveryDecision) {
  requireProtocol(s);
  engine.ensure(d.expectedRevision === s.revision, '恢复决定版本已过期；重新 inspect');
  engine.ensure(typeof d.reason === 'string' && !!d.reason.trim(), '恢复决定需要明确原因');
  safeFile(d.evidencePath);
  const j=s.jobs.find(j=>j.id===d.jobId), dispatch=s.v3?.dispatchRecords.find(x=>x.jobId===d.jobId);
  engine.ensure(j && dispatch && j.executor==='agent', '恢复目标不是已派发模型任务');
  engine.ensure(dispatch.token===d.dispatchToken && dispatch.attempt===d.attempt &&
    j.dispatchToken===d.dispatchToken, '恢复目标 token 或 attempt 已改变');
  const t=s.tickets.find(x=>x.key===j.ticket);
  engine.ensure(d.expectedCandidateVersion === engine.candidateVersion(s,t) &&
    j.candidateVersion===d.expectedCandidateVersion,
    '候选已变化；进入正常诊断，不能用旧候选回执纠错');
  engine.ensure(j.inputVersion===engine.inputVersion(s),
    '模型配置或输入已变化；先诊断并重规划，不能修订旧执行回执');
  engine.ensure(s.status!=='retired' && s.status!=='complete', '终态运行不能恢复回执');
  return {j,dispatch,t};
}
function appendRecovery(s: engine.State, d: RecoveryDecision, fields: Partial<engine.RecoveryRecord> = {}) {
  s.v3!.recoveryRecords ??= [];
  const record:engine.RecoveryRecord={id:randomUUID(),kind:d.kind,jobId:d.jobId,
    expectedRevision:d.expectedRevision,dispatchToken:d.dispatchToken,attempt:d.attempt,
    evidencePath:path.resolve(d.evidencePath),reason:d.reason.trim(),at:new Date().toISOString(),...fields};
  s.v3!.recoveryRecords.push(record);
  engine.event(s, `${d.jobId} 恢复 ${d.kind}：${record.reason}`);
  return record;
}
function verifyContinuationSource(s:engine.State,d:engine.DispatchRecord,j:engine.Job,
  decision:RecoveryDecision,previous:engine.ReceiptRevision,bytes:Buffer) {
  engine.ensure(decision.continuationHostEvent && j.nativeId && j.session,
    '托管 actor 的修订需要可靠续接宿主事件；否则先 prepare-repair');
  verifySessionArtifact(j.session);
  const instance=d.instances.find(i=>i.nativeId===j.nativeId);
  engine.ensure(instance?.continuationSupported===true,
    '宿主未证明同一 actor 可续接；请登记独立回执修复任务');
  const ref=d.events.find(e=>e.evidencePath===decision.continuationHostEvent);
  engine.ensure(ref && ['query','collect','start'].includes(ref.kind) &&
    Date.parse(ref.at)>=Date.parse(previous.at) &&
    sha(fs.readFileSync(safeFile(ref.evidencePath),'utf8'))===ref.digest,
    '续接事件不是当前 token 的可信后续宿主事件');
  const event=read<{stdout:string}>(ref.evidencePath);
  const reply=JSON.parse(event.stdout) as HostReply;
  engine.ensure(reply.token===d.token && reply.jobId===j.id && reply.targetHost===d.targetHost &&
    reply.nativeId===j.nativeId && reply.state==='completed' && reply.continuationSupported===true,
    '续接事件未证明原 actor 完成修订');
  let authoritative:Buffer;
  if(reply.result!==undefined)
    authoritative=Buffer.from(typeof reply.result==='string'?reply.result:JSON.stringify(reply.result));
  else {
    engine.ensure(reply.resultFile,'续接事件缺少权威结果');
    const packet=read<{outputDirectory:string}>(d.packetPath),output=fs.realpathSync(packet.outputDirectory);
    const named=path.resolve(output,reply.resultFile);
    engine.ensure(named.startsWith(output+path.sep) && !fs.lstatSync(named).isSymbolicLink() &&
      fs.realpathSync(named)===named && fs.statSync(named).isFile(),
      '续接结果文件必须位于当前 packet 输出目录');
    authoritative=fs.readFileSync(named);
    verifyHostResultDigest(authoritative,reply.resultSha256);
  }
  engine.ensure(authoritative.equals(bytes),'修订原文与宿主续接的权威结果字节不符');
  return ref.evidencePath;
}
function readReceiptRaw(revision: engine.ReceiptRevision): unknown {
  const bytes = fs.readFileSync(revision.rawPath);
  engine.ensure(createHash('sha256').update(bytes).digest('hex') === revision.rawSha256, '原始回执字节已改变');
  return JSON.parse(bytes.toString('utf8'));
}
function archiveReceipt(s: engine.State, statePath: string, j: engine.Job, bytes: Buffer,
  source: engine.ReceiptSource, options: {sourceHostEvent?:string;sourceNativeId?:string;previousId?:string;repairJobId?:string} = {}) {
  const record = receiptRecord(s, j.id), digest = createHash('sha256').update(bytes).digest('hex');
  const existing=record.revisions.find(x=>x.source===source && x.rawSha256===digest &&
    x.repairJobId===options.repairJobId && (!options.previousId || x.previousId===options.previousId));
  if(existing)return existing;
  const previousId=options.previousId || record.currentId;
  const key = JSON.stringify([j.id, source, digest, previousId || '', options.repairJobId || '']);
  const id = sha(key).slice(0, 32);
  const prior = record.revisions.find(x => x.id === id);
  if (prior) return prior;
  const rawPath = path.join(path.dirname(statePath), 'receipt-raw', sha(j.id).slice(0, 20), `${id}.bin`);
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  try { const fd = fs.openSync(rawPath, 'wx', 0o444);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    engine.ensure((error as NodeJS.ErrnoException).code === 'EEXIST' &&
      createHash('sha256').update(fs.readFileSync(rawPath)).digest('hex') === digest,
      '同一回执原文归档冲突');
  }
  const t = s.tickets.find(t => t.key === j.ticket);
  const revision: engine.ReceiptRevision = { id, previousId, source,
    rawPath, rawSha256: digest, sourceHostEvent: options.sourceHostEvent,
    sourceNativeId: options.sourceNativeId, repairJobId: options.repairJobId,
    candidateVersion: j.candidateVersion || engine.candidateVersion(s, t),
    at: new Date().toISOString(), status: 'raw' };
  record.revisions.push(revision); record.currentId = id;
  engine.event(s, `${j.id} 原始回执 ${id} 已归档 (${source})`);
  return revision;
}
function recordReceiptFailure(s: engine.State, j: engine.Job, statePath: string,
  revision: engine.ReceiptRevision, error: Error, invariant = false) {
  if (j.action === 'skill-child') {
    engine.event(s, `${j.id} 技能子任务回执 ${revision.id} 待修复：${error.message}`);
    return;
  }
  const t = s.tickets.find(t => t.key === j.ticket);
  if (t && active(j) && t.epoch === j.epoch) {
    const budget = t.failureBudget;
    const limit = !!s.policy && ((budget?.totalRetries || 0) + 1 >= s.policy.rounds ||
      (budget?.lastSignature === `receipt_validation:${error.message}` &&
        (budget?.consecutiveNoProgress || 0) + 1 >= s.policy.noProgress));
    engine.recordFailure(s, t, { id: `${j.id}:receipt:${revision.rawSha256}`, category: 'receipt_validation',
      reason: error.message, jobId: j.id, next: t.phase, invariant: invariant || limit, preservePhase: !invariant && !limit });
  }
  recoverOnRejectedResult(s, j, statePath, error);
}
function stageLegacyResult(statePath:string,id:string,bytes:Buffer) {
  const release=lock(statePath);
  try {
    const s=read<engine.State>(statePath),j=s.jobs.find(x=>x.id===id);allowCompletion(s);
    engine.ensure(s.protocol!==engine.currentProtocol && j && j.executor==='agent' && active(j),
      '旧协议只能暂存当前在途模型任务结果');
    const r=normalizeResult(s,j,JSON.parse(bytes.toString('utf8'))),files=resultPaths(statePath,id);
    safeFile(r.evidencePath);if(r.handoffPath)safeFile(r.handoffPath);
    if(fs.existsSync(files.ready)) {
      engine.ensure(fs.readFileSync(files.result,'utf8')===JSON.stringify(r,null,2)+'\n',
        '已有不同回执；不能覆盖旧结果');
    } else {
      write(files.result,r);write(files.ready,{jobId:id,at:new Date().toISOString(),resultPath:files.result});
    }
    save(statePath,s);
  } finally {release();}
  return {jobId:id,resultPath:resultPaths(statePath,id).result,...consumeStaged(statePath,[id])};
}
function stageRawResult(statePath: string, id: string, bytes: Buffer, source: engine.ReceiptSource,
  options: {sourceHostEvent?:string;sourceNativeId?:string;previousId?:string;repairJobId?:string;
    recovery?:RecoveryDecision} = {}) {
  if(read<engine.State>(statePath).protocol!==engine.currentProtocol)
    return stageLegacyResult(statePath,id,bytes);
  const release = lock(statePath);
  let revisionId = '', parseError = '';
  try {
    const s = read<engine.State>(statePath), j = s.jobs.find(j => j.id === id); allowCompletion(s);
    requireUnified(s);
    engine.ensure(j && j.executor === 'agent' && (active(j) || j.status === 'done'), '只能接收已登记的 agent 任务结果');
    if(unifiedDispatchRequired(s,j)&&!options.recovery&&!(source==='repair'&&options.repairJobId))
      verifiedDispatchCompletion(s,j);
    if(engine.contextReady(j))verifyHandoffRef(j);
    if (options.recovery) {
      const target=recoveryTarget(s,options.recovery);
      engine.ensure(target.j.id===id && options.recovery.kind==='revise-receipt' && active(j),
        '仅可修订当前在途任务的回执');
      if(target.dispatch.managed)engine.ensure(target.dispatch.instances.some(i=>i.nativeId===j.nativeId &&
        i.state==='completed'),'宿主尚未确认原业务执行终态');
      const current=receiptRecord(s,id);
      engine.ensure(current.currentId && !current.acceptedId &&
        current.currentId===options.recovery.previousRevisionId,'原始回执修订链已改变');
      engine.ensure(current.revisions.find(x=>x.id===current.currentId)?.candidateVersion===
        options.recovery.expectedCandidateVersion,'原始回执的候选版本已变化；进入正常诊断');
      if(target.dispatch.managed) {
        const previous=current.revisions.find(x=>x.id===current.currentId)!;
        options.sourceHostEvent=verifyContinuationSource(s,target.dispatch,j,
          options.recovery,previous,bytes);
        options.sourceNativeId=j.nativeId;
      }
      options.previousId=current.currentId;
    }
    if (source === 'repair' && options.repairJobId) {
      const repair=s.jobs.find(x=>x.id===options.repairJobId), rd=s.v3?.dispatchRecords.find(x=>x.jobId===repair?.id);
      engine.ensure(active(j) && receiptRecord(s,id).currentId===options.previousId &&
        repair && active(repair) && repair.repairOfJobId===id &&
        repair.repairTargetRevisionId===options.previousId &&
        rd?.managed && rd.status==='completed' && repair.nativeId===options.sourceNativeId &&
        rd.instances.some(i=>i.nativeId===repair.nativeId && i.state==='completed') && repair.session,
        '独立修复者未完成或原生身份未核实');
      verifySessionArtifact(repair.session);
    }
    if (source === 'host_structured' || source === 'host_file') {
      const d = s.v3?.dispatchRecords.find(x => x.jobId === id);
      engine.ensure(d?.managed && d.status === 'completed' && j.nativeId === options.sourceNativeId &&
        d.instances.some(i => i.nativeId === j.nativeId && i.state === 'completed'),
        '宿主终态尚未确认，不能采用已出现的结果文件');
    }
    const record = receiptRecord(s, id);
    if(j.status==='done' && record.acceptedId) {
      const accepted=record.revisions.find(x=>x.id===record.acceptedId);
      engine.ensure(accepted && accepted.rawSha256===createHash('sha256').update(bytes).digest('hex'),
        '已完成任务的权威回执不能改变');
      return {jobId:id,revisionId:accepted.id,resultPath:resultPaths(statePath,id).result,
        submitted:[],rejected:[]};
    }
    engine.ensure(!record.acceptedId || j.status === 'done', '已有权威回执，不能覆盖');
    engine.ensure(!record.currentId || source === 'repair' || record.revisions.some(x => x.id === record.currentId && x.rawSha256 === createHash('sha256').update(bytes).digest('hex')),
      '已有不同回执；请通过 recover-result 修订');
    const priorCurrentId=record.currentId;
    const revision = archiveReceipt(s, statePath, j, bytes, source, options); revisionId = revision.id;
    if (priorCurrentId!==revision.id && record.currentId===revision.id && fs.existsSync(resultPaths(statePath,id).ready))
      fs.rmSync(resultPaths(statePath,id).ready);
    if (options.recovery) appendRecovery(s,options.recovery,
      {receiptRevisionId:revision.id,afterNativeId:options.sourceNativeId});
    if (source === 'repair' && options.repairJobId) {
      const repair=s.jobs.find(x=>x.id===options.repairJobId)!;
      repair.status='done';repair.timing??={leasedAt:''};repair.timing.completedAt=new Date().toISOString();
      engine.event(s, `${repair.id} 独立回执修复已交付修订 ${revision.id}`);
    }
    if (j.status === 'done') {
      const normalized=normalizeResult(s,j,readReceiptRaw(revision));
      engine.ensure(JSON.stringify(j.result)===JSON.stringify(normalized),
        '已完成任务的回执不能改变');
      revision.status='accepted';record.acceptedId=revision.id;
      save(statePath, s);
      return { jobId: id, revisionId, resultPath: resultPaths(statePath,id).result, submitted: [], rejected: [] };
    }
    try {
      const r = normalizeResult(s, j, readReceiptRaw(revision)), files = resultPaths(statePath, id);
      safeFile(r.evidencePath); if (r.handoffPath) safeFile(r.handoffPath);
      // The normalized file is a staging cache; the immutable revision remains authoritative.
      write(files.result, r);
      write(files.ready, {jobId:id,at:new Date().toISOString(),resultPath:files.result,revisionId});
      revision.status = 'schema_valid'; revision.error = undefined;
      if (source==='repair') {
        const d=s.v3?.dispatchRecords.find(x=>x.jobId===id);
        if(d?.managed && d.instances.some(i=>i.nativeId===j.nativeId && i.state==='completed')) {
          d.status='completed';d.uncertainty=undefined;
        }
      }
    } catch (error) {
      parseError = (error as Error).message; revision.status = 'rejected'; revision.error = parseError;
      recordReceiptFailure(s, j, statePath, revision, error as Error);
    }
    save(statePath, s);
  } finally { release(); }
  if (parseError) return { jobId:id, revisionId, resultPath:resultPaths(statePath,id).result,
    submitted: [], rejected: [{jobId:id,error:parseError}] };
  return { jobId:id, revisionId, resultPath:resultPaths(statePath,id).result, ...consumeStaged(statePath,[id]) };
}
export function stageResult(statePath: string, id: string, value: unknown) {
  return stageRawResult(statePath, id, Buffer.from(JSON.stringify(value)), 'stage');
}
function confirmStopped(s:engine.State,statePath:string,j:engine.Job,proof:{
  state:'stopped'|'lost';evidencePath:string;processTreeStopped?:boolean;commandDisposition?:'recover'|'cancel'
}) {
  safeFile(proof.evidencePath);
  engine.ensure(proof.processTreeStopped===true,'须确认执行者与测试的整个进程树已停止');
  engine.ensure(!j.testExecution || !processAlive(j.testExecution.pid),'测试进程仍在运行，不能释放预算');
  const d=s.v3?.dispatchRecords.find(x=>x.jobId===j.id);
  if(j.executor==='agent' && d?.managed) {
    const instance=d.instances.find(i=>i.nativeId===j.nativeId);
    engine.ensure(instance && ['completed','cancelled'].includes(instance.state),
      '宿主实例仍可能运行；先归档取消或终态确认');
  }
  if(j.executor!=='agent' && /^command:\d+:/.test(j.nativeId) && s.protocol!==undefined) {
    engine.ensure(!processAlive(Number(j.nativeId.split(':')[1])), '命令父进程仍在运行');
    if(proof.commandDisposition==='recover') {
      j.commandRecovery={nativeId:j.nativeId,evidencePath:proof.evidencePath,at:new Date().toISOString()};
      return;
    }
    delete j.commandRecovery;
  }
  j.status='cancelled';
  j.stopConfirmation={state:proof.state,evidencePath:proof.evidencePath,processTreeStopped:true,at:new Date().toISOString()};
  if(j.testExecution?.pid){j.testProcessHistory??=[];j.testProcessHistory.push({pid:j.testExecution.pid,
    kind:'reconciled',evidencePath:proof.evidencePath,
    evidenceSha256:sha(fs.readFileSync(proof.evidencePath)),at:new Date().toISOString()});}
  j.timing??={leasedAt:''};j.timing.cancelledAt=new Date().toISOString();delete j.testExecution;
  if(j.action==='skill-child')engine.event(s,`${j.id} 技能子任务已由宿主确认停止；父调用等待显式 skill-retry`);
  else if(s.v3?.skillInvocations.some(i=>i.jobId===j.id&&!i.result))
    engine.event(s,`${j.id} 父技能执行者已停止；保留调用与子任务证据，等待新角色通过 skill-resume 续接`);
  else if(j.ticket==='$spec')s.specAudit=undefined;
  else {
    const t=engine.ticket(s,j.ticket);
    if(t.failures?.some(f=>f.jobId===j.id))engine.finalizeRejectedReceipt(s,t,j);
    else if(j.nativeId)engine.recordFailure(s,t,{id:`${j.id}:host`,category:'host',jobId:j.id,
      reason:`宿主执行 ${proof.state}；${proof.evidencePath}`,signature:`${j.action}:${proof.state}`,
      next:t.phase,preservePhase:t.phase==='recovery'});
  }
  engine.event(s,`${j.id} 已用完整进程树证据确认停止`);
}
function recoverResult(statePath:string,d:RecoveryDecision) {
  if(d.kind==='revise-receipt') {
    engine.ensure(d.rawPath,'回执修订需要原文文件');
    const bytes=fs.readFileSync(safeFile(d.rawPath));
    const receipt=stageRawResult(statePath,d.jobId,bytes,'repair',{recovery:d});
    engine.ensure(!receipt.rejected.length,`修订已保留但未通过核验：${JSON.stringify(receipt.rejected)}`);
    return receipt;
  }
  if(d.kind==='cancel') {
    const release=lock(statePath);
    try {const s=read<engine.State>(statePath),{j,dispatch}=recoveryTarget(s,d);
      engine.ensure(active(j) && dispatch.managed && dispatch.status==='running',
        '取消前须确认当前托管实例正在运行');
      appendRecovery(s,d,{beforeNativeId:j.nativeId});save(statePath,s);
    } finally {release();}
    return cancelDispatch(statePath,d.jobId);
  }
  const release=lock(statePath);
  try {
    const s=read<engine.State>(statePath),{j,dispatch}=recoveryTarget(s,d);
    engine.ensure(active(j) && j.status!=='done','已完成任务不能恢复身份或停止');
    if(d.kind==='confirm-stop' || d.kind==='abandon') {
      engine.ensure(d.observedState==='stopped' || d.observedState==='lost','需要明确停止或遗失状态');
      if(d.kind==='abandon')engine.ensure(!!s.v3?.receiptRecords?.find(x=>x.jobId===j.id)?.currentId,
        '放弃纠错前须有原始回执');
      confirmStopped(s,statePath,j,{state:d.observedState,evidencePath:d.evidencePath,
        processTreeStopped:d.processTreeStopped});
      appendRecovery(s,d,{beforeNativeId:j.nativeId});
    } else if(d.kind==='correct-binding') {
      engine.ensure(d.expectedNativeId===j.nativeId && d.nativeId && d.nativeId!==j.nativeId,
        '绑定纠错必须准确声明旧身份与不同的新身份');
      engine.ensure(!s.v3?.receiptRecords?.find(x=>x.jobId===j.id)?.acceptedId,
        '已接纳回执的原生身份不能替换');
      const target=dispatch.instances.find(i=>i.nativeId===d.nativeId);
      engine.ensure(target && ['running','completed','cancelled'].includes(target.state) &&
        target.events.length>0,'新身份必须来自当前 token 的宿主实例日志');
      const old=dispatch.instances.find(i=>i.nativeId===j.nativeId);
      if(old && ['running','unknown'].includes(old.state))
        engine.ensure(d.processTreeStopped===true,'旧实例仍可能运行，必须确认整个进程树停止');
      const session=nativeSession(statePath,d.nativeId,j.id);
      engine.verifyNativeSession(s,session,d.nativeId,j.tier);verifySessionArtifact(session);
      const before=j.nativeId,priorBindingError=target.bindingError||old?.bindingError;
      j.nativeId='';j.session=undefined;j.contextObservation=undefined;j.status='leased';
      engine.bind(s,j.id,{nativeId:d.nativeId,session});
      dispatch.nativeId=d.nativeId;dispatch.status=target.state==='completed'?'completed':
        target.state==='cancelled'?'cancelled':'running';
      target.session=session;dispatch.uncertainty=undefined;
      appendRecovery(s,d,{beforeNativeId:before,afterNativeId:d.nativeId,priorBindingError});
    } else if(d.kind==='prepare-repair') {
      engine.ensure(s.status==='running','暂停时不能启动新的修复任务');
      const current=receiptRecord(s,j.id),rev=current.revisions.find(x=>x.id===current.currentId);
      engine.ensure(rev && rev.status==='rejected' && !current.acceptedId &&
        d.previousRevisionId===rev.id,'只为当前失败修订登记独立修复任务');
      engine.ensure(!s.jobs.some(x=>x.repairOfJobId===j.id && active(x)),
        '已有在途的独立回执修复任务');
      const instance=dispatch.instances.find(i=>i.nativeId===j.nativeId);
      engine.ensure(!dispatch.managed || instance?.state==='completed',
        '原业务执行尚未确认完成，不能派发独立修复');
      const repairId=`${j.id}:receipt-repair:${rev.id.slice(0,12)}:try-1`;
      engine.ensure(!s.jobs.some(x=>x.id===repairId),'此修订的独立修复任务已登记');
      const token=randomUUID();
      const repair:engine.Job={id:repairId,ticket:j.ticket,epoch:j.epoch,action:'repair-receipt',part:rev.id,
        tier:j.tier,model:j.model,executor:'agent',fresh:true,contextKey:`receipt-repair:${j.id}:${rev.id}`,
        contextIntent:{kind:'independent',fresh:true,parentJobId:j.id},
        head:j.head,base:j.base,tests:0,status:'leased',nativeId:'',repairOfJobId:j.id,
        repairTargetRevisionId:rev.id,dispatchToken:token,inputVersion:j.inputVersion,
        candidateVersion:j.candidateVersion,timing:{leasedAt:new Date().toISOString()}};
      s.jobs.push(repair);
      const packetPath=path.join(path.dirname(statePath),'packets',sha(repair.id).slice(0,20)+'.json');
      write(packetPath,packet(s,repair,statePath));
      const requestPath=path.join(path.dirname(statePath),'dispatch',`${sha(repair.id).slice(0,20)}.json`);
      const request={token,jobId:repair.id,attempt:1,targetHost:s.capabilities?.framework||'unknown',
        requestedModel:repair.model,packetPath,contextIntent:repair.contextIntent,resumeFrom:null};
      write(requestPath,request);const at=new Date().toISOString();
      s.v3!.dispatchRecords.push({...request,requestPath,requestDigest:sha(fs.readFileSync(requestPath)),
        status:'prepared',createdAt:at,updatedAt:at,events:[],instances:[{key:`token:${token}`,
          nativeId:null,state:'requested',firstSeenAt:at,lastSeenAt:at,events:[]}]});
      appendRecovery(s,d,{beforeNativeId:j.nativeId,receiptRevisionId:rev.id,repairJobId:repair.id});
    } else throw new Error(`未知恢复类型 ${d.kind}`);
    save(statePath,s);
    return {statePath,status:s.status,revision:s.revision,record:s.v3!.recoveryRecords!.at(-1)};
  } finally {release();}
}
export function bindBatch(statePath: string, binding: {runId:string; model?:string; jobs:{jobId:string; actorName:string}[]}) {
  const release = lock(statePath);
  try {
    const s = read<engine.State>(statePath); allowCompletion(s);
    engine.ensure(s.protocol!==engine.currentProtocol,
      '协议 3 禁止旧批次模板绑定；使用持久 token 的逐 job 派发及回执协议');
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
    const s=read<engine.State>(statePath), j=s.jobs.find(j=>j.id===id); requireUnified(s);
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
  let a:number|undefined,b:number|undefined,testGroupPid:number|undefined;
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
    const r=spawnSync(request.argv[0],request.argv.slice(1),{cwd:worktree,env:testCommandEnv(request.env),
      timeout:request.timeoutSeconds*1000,stdio:['ignore',a,b],shell:false,detached:true});
    testGroupPid=r.pid;
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
      if(j.testExecution?.pid===process.pid){
        if(testGroupPid){j.testProcessHistory??=[];j.testProcessHistory.push({pid:testGroupPid,
          kind:'completed',evidencePath:path.join(out,'receipt.json'),
          evidenceSha256:fs.existsSync(path.join(out,'receipt.json'))?
            sha(fs.readFileSync(path.join(out,'receipt.json'))):'',at:new Date().toISOString()});}
        if(j.testExecution.granted)j.tests=0;delete j.testExecution;engine.event(s,`${j.ticket} 测试进程结束`);save(statePath,s);}
    } finally {release();}
  }
}
export async function main(argv: string[]): Promise<unknown> {
  const [op, file, extra, fourth] = argv;
  if(op==='version')return {workflow:'spec-delivery',version:workflowVersion};
  if (!op || op === 'help') return { workflow: 'spec-delivery', input: ['spec', 'targetBranch', 'models.L1', 'models.L2', 'models.L3'],
    version:workflowVersion,readme: path.join(home, 'spec-delivery', 'README.md'), commands: ['version','summary <state.json>', 'init <input.json>', 'inspect <state>', 'migration-context <state>', 'plan-context <state>', 'decision-context <state>', 'plan <state> <plan.json>', 'observe-main <state> <native-id>', 'drive <state>', 'next <state>', 'dispatch <state> <jobId>', 'dispatch-cancel <state> <decision.json>', 'recover-result <state> <decision.json>', 'bind <state> <jobId> <binding.json>', 'bind-batch <state> <binding.json> (historical only)', 'context-handoff <state> <jobId> <verification.json>', 'context-reconstruct <state> <jobId> <reconstruction.json>', 'skill-start <state> <jobId> <host-capabilities.json>', 'skill-delegate <state> <invocationId> <children.json>', 'skill-continue <state> <invocationId>', 'skill-retry <state> <invocationId> <keys.json>', 'skill-resume <state> <invocationId> <resume.json>', 'skill-finish <state> <invocationId> <outcome.json>', 'migrate-skills <state> <migration.json>', 'stage <state> <jobId> <result-json>', 'stage-raw <state> <jobId> <raw-file>', 'collect <state> [jobId]', 'submit <state> <jobId> <result.json>', 'execute <state> <jobId>', 'publish-pr <state> <jobId> <request.json>', 'merge-pr <state> <jobId> <request.json>', 'test <state> <jobId> <request.json>', 'ci-attest <state> <accept-jobId> <request.json>', 'guard <state> <jobId>', 'reconcile <state> <host-status.json>', 'recover-workspace <state> <ticket> <decision.json>', 'resolve <state> <decisions.json>', 'reconfigure <state> <models.json>', 'upgrade <state> <evidence.json>', 'retire <state> <reason.json>', 'record-host <state> <observations.json>', 'record-wait <state> <observation.json>', 'metrics <state>', 'metrics-compare <before-state> <after-state>', 'resume <state> <decision.json>', 'zcode <state>'] };
  engine.ensure(file, '缺少输入文件/状态路径');
  // summary 在 lock() 之前返回：只验证可读协议，不创建/等待/恢复/删除状态锁，也不进入写路径。
  if (op === 'summary') return summarizeLedger(path.resolve(file));
  if (op === 'init') return initialize(read<engine.Inputs>(file));
  // 历史读取不触发锁恢复、GitHub 观测或状态写入。
  if (op === 'inspect' || op === 'metrics' || op === 'migration-context') {
    const state = read<engine.State>(path.resolve(file)); supportedLedger(state);
    return op === 'inspect' ? { ...state, rolesPath } : op === 'migration-context' ? migrationContext(state,path.resolve(file)) : metrics(state);
  }
  if (op === 'metrics-compare') {
    engine.ensure(extra,'需要前后两个状态文件');
    const before=read<engine.State>(path.resolve(file)),after=read<engine.State>(path.resolve(extra));
    supportedLedger(before);supportedLedger(after);
    return compareMetrics(before,after);
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
  // Transitional v3 ledgers are read-only until explicit, quiescent migration.
  // This check precedes all command, host and GitHub operations, including paths
  // with their own state lock below. Historical protocol-2 completion is preserved.
  if(op!=='upgrade'&&op!=='migrate-skills')requireBoundV3(read<engine.State>(path.resolve(file)));
  if (op === 'execute') { engine.ensure(extra, '需要 command jobId'); return executeCommand(path.resolve(file), extra); }
  if (op === 'publish-pr' || op === 'merge-pr') {
    engine.ensure(extra&&fourth,'需要 jobId 与固定远端操作请求文件');
    const statePath=path.resolve(file),release=lock(statePath);
    try {return op==='publish-pr'?publishPr(statePath,extra,read(fourth)):mergePr(statePath,extra,read(fourth));}
    finally {release();}
  }
  if (op === 'test') {engine.ensure(extra && fourth,'需要 jobId 与测试请求文件');return runTest(path.resolve(file),extra,read(fourth));}
  if (op === 'stage' || op === 'stage-raw') {
    engine.ensure(extra && fourth, '需要 jobId 与结果 JSON 内容或原文文件');
    const bytes = op === 'stage' ? Buffer.from(fourth) : fs.readFileSync(safeFile(fourth));
    const receipt=stageRawResult(path.resolve(file),extra,bytes,'stage');
    engine.ensure(!receipt.rejected.length,`回执已保留但未通过核验：${JSON.stringify(receipt.rejected)}；主控核对，不重跑外部动作`);
    return receipt;
  }
  if (op === 'recover-result') {
    engine.ensure(extra,'需要带版本与证据的恢复决定文件');
    const decision=read<RecoveryDecision>(extra),statePath=path.resolve(file);
    const recovered=recoverResult(statePath,decision);
    return decision.kind==='correct-binding'
      ? {...recovered,...consumeStaged(statePath,[decision.jobId])} : recovered;
  }
  if (op === 'dispatch') { engine.ensure(extra, '需要 jobId'); return dispatchRound(path.resolve(file), extra, true); }
  if (op === 'dispatch-cancel') {
    engine.ensure(extra,'取消需带版本与证据的决定文件');
    const decision=read<RecoveryDecision>(extra);
    engine.ensure(decision.kind==='cancel','取消决定类型必须为 cancel');
    return recoverResult(path.resolve(file),decision);
  }
  if (op === 'collect') {
    const statePath = path.resolve(file), state = read<engine.State>(statePath); requireUnified(state);
    const records = state.v3!.dispatchRecords.filter(d => d.managed && (!extra || d.jobId === extra) &&
      ['starting','running','completed','uncertain'].includes(d.status));
    const polled = records.map(d => dispatchRound(statePath, d.jobId, false));
    return { polled, ...consumeStaged(statePath, extra ? [extra] : undefined) };
  }
  if (op === 'bind-batch') { engine.ensure(extra, '需要宿主批次绑定文件'); return bindBatch(path.resolve(file),read(extra)); }
  if (op === 'drive') {
    requireUnified(read<engine.State>(path.resolve(file)));
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
    if(op!=='upgrade'&&op!=='migrate-skills')requireBoundV3(s);
    engine.ensure(s.status !== 'retired', '已退役运行只允许 inspect/metrics/summary，不能自动复活');
    if (op === 'ci-attest') {
      engine.ensure(extra && fourth, '需要验收 jobId 与豁免请求');
      const j=s.jobs.find(j=>j.id===extra), request=read<{reason:'no_ci'|'billing';notStartedIds?:string[]}>(fourth);
      engine.ensure(j && j.action==='accept' && active(j) && s.status==='running',
        '只允许在途验收任务读取当前 CI 豁免事实');
      const t=engine.ticket(s,j.ticket);
      s.facts=observe(s,[j]);const pr=s.facts.prs[String(t.pr)];
      engine.ensure(pr?.state==='OPEN' && pr.head===t.head && pr.base===t.base &&
        pr.baseRef===s.inputs.targetBranch,'CI 观测候选不是当前 PR/目标分支');
      const inventory=request.reason==='no_ci'?gh.workflowInventory(s.repo):undefined;
      const required=request.reason==='no_ci'?gh.requiredStatusChecks(s.repo,s.inputs.targetBranch):undefined;
      const notices=request.reason==='billing'?(request.notStartedIds||[]).map(id=>gh.checkRunNotice(s.repo,id)):undefined;
      if(request.reason==='no_ci')engine.ensure(pr.checks.length===0 && inventory?.length===0 && required?.length===0,
        '远端有 CI 检查、工作流或保护规则，不能声明无 CI');
      else engine.ensure(request.reason==='billing' && notices?.length &&
        (request.notStartedIds||[]).every(id=>pr.checks.some(c=>c.id===id&&c.status==='startup_failure') &&
          notices.some(n=>n.id===id&&/bill(?:ing)?|payment|spending limit|额度|计费|付款/i.test(`${n.title} ${n.summary}`))),
        '远端没有逐项证明因计费而未启动的检查');
      const attestation={jobId:j.id,reason:request.reason,pr:t.pr,head:t.head,base:t.base,
        checks:pr.checks,inventory,required,notices,at:s.facts.at};
      const digest=sha(JSON.stringify(attestation));
      const evidencePath=path.join(path.dirname(statePath),'ci',`${sha(j.id).slice(0,20)}-${digest.slice(0,20)}.json`);
      if(!fs.existsSync(evidencePath))write(evidencePath,attestation);
      else engine.ensure(JSON.stringify(read(evidencePath))===JSON.stringify(attestation),
        'CI 原始观测归档已经改变');
      s.ciAttestations??=[];
      if(!s.ciAttestations.some(a=>a.path===evidencePath))s.ciAttestations.push({jobId:j.id,
        reason:request.reason,head:t.head,base:t.base,path:evidencePath,
        sha256:sha(fs.readFileSync(evidencePath)),at:s.facts.at});
      engine.event(s,`${t.key} CI 豁免远端观测已归档：${request.reason}`);save(statePath,s);
      return {ciWaiver:{reason:request.reason,evidence:evidencePath,verification:'remote',
        observedHead:t.head,observedBase:t.base,notStartedIds:request.notStartedIds||[]},
        ciConfigured:request.reason==='no_ci'?false:undefined};
    }
    if (op === 'upgrade') {
      engine.ensure(extra, '升级需显式迁移决定文件');
      if(s.protocol===engine.currentProtocol) {
        engine.ensure(engine.unifiedSkillsReady(s), '过渡协议 3 需停稳后显式 migrate-skills，不能直接继续派发');
        return {statePath,status:s.status,upgraded:false};
      }
      const proof=read<MigrationDecision>(extra);
      const host=verifyMigrationQuiescence(s,statePath,proof);
      const migration=backupMigration(statePath,s,extra,proof,host);
      // 旧计划、作者和 PR 审查方法均不能拼成新技能的完整通过。
      for(const t of s.tickets) if(!['done','human','close','cleanup'].includes(t.phase)) {
        const affected=['self','verify','publish','review','fresh','accept','merge','integrate','queued'].includes(t.phase) ||
          t.reason==='waiting_ci';
        t.evidence={};t.authorReview=undefined;t.reviewDisagreementId=undefined;
        if(affected) {
          t.phase=t.worktree?'replan':'claim';t.epoch++;
          t.reason='旧协议部分候选与审查证据已失效；重新批准计划、执行绑定技能并审查';
          migration.invalidatedTickets.push(t.key);
        }
      }
      for(const j of s.jobs) if(j.result) {
        const output=resultPaths(statePath,j.id).result;
        if(!fs.existsSync(output))write(output,j.result);
      }
      if(s.status!=='complete'){s.specAudit=undefined;s.auditEpoch++;}
      s.validationOwner=undefined;s.protocol=engine.currentProtocol;s.v3=engine.initialProtocolV3();
      s.v3.skillBindings=skills.defaultSkillBindings(skills.configuredSkillRoot());
      engine.event(s,`迁移为统一运行协议 3；原账本备份 SHA-256 ${migration.backupSha256}：${migration.backupPath}；保留全部原结果和已完成工单。对账依据：${proof.evidencePath}`);
      save(statePath,s);return {statePath,status:s.status,upgraded:true,backupPath:migration.backupPath,
        backupSha256:migration.backupSha256,invalidatedTickets:migration.invalidatedTickets};
    }
    if(!['bind','submit','reconcile','retire','record-host','record-wait','migrate-skills'].includes(op))requireUnified(s);
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
      if(request.capability==='authorReview' && !prepared.alreadyStarted) {
        const t=engine.ticket(s,j.ticket);
        engine.ensure(localHead(t)===j.head && clean(t), '作者自检须对已提交且干净的当前候选执行');
        const sources=authorReviewSources(s,t,j.head,j.base);
        const packetPath=path.join(path.dirname(statePath),'packets',sha(j.id).slice(0,20)+'.json');
        const context=read<{reviewContext?:engine.ReviewSources}>(packetPath).reviewContext;
        engine.ensure(context?.fingerprint===sources.fingerprint,
          '作者自检 packet 的候选或来源已过期；重新派发当前来源');
        prepared.invocation.reviewSources=sources;
      }
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
      for(const child of request.children || []) {
        if(child.skillCapability==='authorReview' && parent && ['implement','integrate'].includes(parent.action)) {
          engine.ensure(ticket?.worktree && clean(ticket),
            'authorReview 子任务需要当前已提交且干净的工作区；先提交或清理改动');
          const committedHead=localHead(ticket);
          engine.ensure(!child.head || child.head===committedHead,
            'authorReview 子任务 head 不是当前已提交候选；请用当前工作区 HEAD');
          child.head=committedHead;
        } else if(child.head && child.head!==parent?.head) {
          engine.ensure(parent && ticket?.worktree && localHead(ticket)===child.head && clean(ticket),
            '技能子任务候选 head 必须是当前已提交且干净的工作区');
        }
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
      if(invocation.capability==='authorReview') {
        const job=s.jobs.find(j=>j.id===invocation.jobId);
        engine.ensure(job, '作者自检缺少真实执行者');
        const t=engine.ticket(s,job.ticket);
        engine.ensure(localHead(t)===job.head && clean(t) &&
          invocation.reviewSources?.fingerprint===authorReviewSources(s,t,job.head,job.base).fingerprint,
          '作者自检结果的候选或来源已改变');
      }
      const observation=skillObservation(statePath,'result',extra,invocation.jobId);
      const outcome=read<Omit<skills.SkillOutcome,'hostReceiptPath'>>(fourth);
      const result = skills.finishSkillCall(s, extra, {...outcome,hostReceiptPath:observation.file});
      save(statePath, s);
      return { invocationId: extra, status: result.status, blocking: result.blocking, result };
    }
    if (op === 'migrate-skills') {
      engine.ensure(extra, '需要显式技能迁移文件');
      const request=read<MigrationDecision & {replacements:Partial<Record<engine.SkillCapability,string>>}>(extra);
      engine.ensure(request.expectedRevision===s.revision, '技能迁移决定已过期；重新 inspect 当前账本');
      const convergence=s.v3?.executionPath==='legacy-v02' || !engine.unifiedSkillsReady(s);
      const host=convergence?verifyMigrationQuiescence(s,statePath,request):undefined;
      const trial=structuredClone(s);
      const changed=skills.migrateSkillBindings(trial,request.replacements || {},path.resolve(request.evidencePath));
      if(convergence) {
        const migration=backupMigration(statePath,s,extra,request,host!);
        migration.invalidatedTickets=trial.tickets.filter((t,i)=>t.phase!==s.tickets[i]?.phase ||
          t.epoch!==s.tickets[i]?.epoch).map(t=>t.key);
        trial.migrations=s.migrations;
      }
      s=trial;
      save(statePath,s);
      return {statePath,changed,revision:s.revision,status:s.status,
        backupPath:convergence?s.migrations?.at(-1)?.backupPath:undefined};
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
      requireCurrentAuthorReview(s,t);
      if(s.protocol===engine.currentProtocol)verifyReviewEvidenceFiles(s,t);
      engine.ensure(j.action === 'merge' && engine.mergeGate(s, t), '最新的合并门禁不满足，禁止合并');
      return { allowed: true, head: t.head, base: t.base, at: s.facts.at, note: '立即使用预期 head 约束合并；远端保护仍生效，目标分支由主控串行调度' };
    }
    if (op === 'plan') {
      engine.ensure(extra, '需要 L1 自行生成的 plan.json');
      s.facts = observe(s); const parent = gh.issue(s.repo, s.spec), sources = gh.subIssues(s.repo, s.spec);
      const p = read<engine.ExecutionPlan & { decisionNativeId?: string }>(extra); safeFile(p.evidencePath);
      for(const item of p.tickets)for(const deferred of item.deferredDependencies||[]) {
        const source=sources.find(x=>x.number===item.number);
        const target=deferred.target===s.spec?parent:sources.find(x=>x.number===deferred.target);
        engine.ensure(source?.comments.some(c=>c.url===deferred.records[0])&&
          target?.comments.some(c=>c.url===deferred.records[1]),
          '延期人工验收的两端评论必须真实存在于原工单与接收工单/spec');
      }
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
      refreshAuthorReviews(s);
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
        const sourceTicket=s.tickets.find(t=>t.key===j.ticket);
        const sourceArchive=j.executor==='agent' && sourceTicket?.worktree && engine.actionMetadata[j.action].rawSource
          ? rawSourcesForJob(s,sourceTicket,j,statePath) : undefined;
        const p = packet(s, j, statePath, sourceArchive);
        const file = path.join(path.dirname(statePath), 'packets', sha(j.id).slice(0, 20) + '.json'); write(file, p);
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
      if(unifiedDispatchRequired(s,j))
        engine.ensure(dispatch?.managed&&!!j.dispatchToken&&dispatch.token===j.dispatchToken&&
          ['running','completed'].includes(dispatch.status)&&dispatch.nativeId===ref.nativeId&&
          dispatch.instances.some(i=>i.nativeId===ref.nativeId&&
            ['running','completed'].includes(i.state)&&i.events.length>0),
          '统一运行的 actor 须由可信宿主按持久 token 查询并绑定，不能用手填原生身份');
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
        t.epoch++; t.evidence = {}; t.reviewDisagreementId=undefined;
        t.phase = t.worktree ? 'replan' : 'claim';
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
      const sourceBytes=fs.readFileSync(safeFile(extra)),sourceSha256=sha(sourceBytes);
      const records=JSON.parse(sourceBytes.toString('utf8')) as {jobId?:string;nativeId:string;targetHost?:string;
        evidencePath:string;startedAt?:string;completedAt?:string;cancelledAt?:string;
        usage?:engine.Json;usageScope?:'session'|'model_call';modelCallId?:string;
        provider?:string;model?:string;dispatchToken?:string;state?:engine.HostInstanceRecord['state']}[];
      engine.ensure(Array.isArray(records),'宿主观测须为数组');
      const archived=path.join(path.dirname(statePath),'host-usage',`${sourceSha256}.json`);
      fs.mkdirSync(path.dirname(archived),{recursive:true});
      if(!fs.existsSync(archived)) {
        const fd=fs.openSync(archived,'wx',0o444);
        try {fs.writeFileSync(fd,sourceBytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      } else engine.ensure(sha(fs.readFileSync(archived))===sourceSha256,'宿主原始用量归档已改变');
      for(const [sourceIndex,r] of records.entries()) {
        engine.ensure(typeof r.nativeId==='string' && !!r.nativeId,'宿主观测缺少原生实例 ID');
        engine.ensure(r.targetHost===undefined||typeof r.targetHost==='string'&&!!r.targetHost,
          '宿主目标无效');
        engine.ensure(r.provider===undefined||typeof r.provider==='string','宿主 provider 无效');
        engine.ensure(!r.state||['requested','running','completed','cancelled','unknown'].includes(r.state),
          '宿主实例状态无效');
        safeFile(r.evidencePath);
        const j=r.jobId?s.jobs.find(j=>j.id===r.jobId):undefined;
        engine.ensure(!r.jobId||j,'宿主任务不存在');
        const dispatches=j?s.v3?.dispatchRecords.filter(x=>x.jobId===j.id)||[]:[];
        const d=r.dispatchToken?dispatches.find(x=>x.token===r.dispatchToken):dispatches.at(-1);
        engine.ensure(!r.dispatchToken||d,'宿主观测的派发 token 不存在');
        let instance:engine.HostInstanceRecord;
        if(j) {
          engine.ensure(j.nativeId===r.nativeId || (!!d && r.dispatchToken===d.token &&
            d.instances.some(i=>i.nativeId===r.nativeId && i.events.some(e=>e.evidencePath===r.evidencePath))),
            '未绑定实例须引用已归档的宿主事件；身份或派发 token 不符');
          engine.ensure(!r.targetHost || !d || r.targetHost===d.targetHost,'宿主目标与派发不符');
        } else if(!j) {
          engine.ensure(s.v3 && r.targetHost,'无 job 的实际实例须声明目标宿主');
          const proof=read<{source:string;nativeId:string;targetHost:string}>(r.evidencePath);
          engine.ensure(proof.source==='native_host' && proof.nativeId===r.nativeId &&
            proof.targetHost===r.targetHost,'独立实例缺少宿主原始身份记录');
        }
        for(const stamp of [r.startedAt,r.completedAt,r.cancelledAt])
          if(stamp)engine.ensure(Number.isFinite(Date.parse(stamp)),'宿主时间无效');
        if(d) {
          const at=new Date().toISOString(); let found=d.instances.find(x=>x.nativeId===r.nativeId);
          if(d.managed) {
            engine.ensure(found,'托管派发的用量记录不能创建未经宿主发现的原生实例');
            if(r.state&&r.state!==found.state) {
              const ref=d.events.find(e=>e.evidencePath===r.evidencePath&&
                fs.existsSync(e.evidencePath)&&sha(fs.readFileSync(e.evidencePath))===e.digest);
              let reply:Partial<HostReply>|undefined;
              try {reply=JSON.parse(JSON.parse(fs.readFileSync(r.evidencePath,'utf8')).stdout);}catch{}
              engine.ensure(ref&&reply?.token===d.token&&reply.jobId===d.jobId&&
                reply.targetHost===d.targetHost&&reply.nativeId===r.nativeId&&reply.state===r.state,
                '托管实例状态只能由原始宿主派发事件改变，补录用量不能改写终态');
            }
          }
          if(!found){found={key:`native:${r.nativeId}`,nativeId:r.nativeId,state:r.state||'unknown',firstSeenAt:at,lastSeenAt:at,events:[]};d.instances.push(found);}
          instance=found;
          instance.lastSeenAt=at; if(r.state)instance.state=r.state;
          const digest=sha(fs.readFileSync(r.evidencePath));const ref:engine.HostEventRef={kind:'query',evidencePath:r.evidencePath,digest,at};
          if(!d.managed) {
            if(!instance.events.some(x=>x.evidencePath===ref.evidencePath&&x.digest===ref.digest))instance.events.push(ref);
            if(!d.events.some(x=>x.evidencePath===ref.evidencePath&&x.digest===ref.digest))d.events.push(ref);
          }
        } else if(s.v3) {
          s.v3.detachedInstances??=[];
          const targetHost=r.targetHost||s.capabilities?.framework||'unknown';
          let found=s.v3.detachedInstances.find(x=>x.targetHost===targetHost&&x.nativeId===r.nativeId);
          if(!found){const at=new Date().toISOString();found={key:`native:${r.nativeId}`,nativeId:r.nativeId,
            targetHost,state:r.state||'unknown',firstSeenAt:at,lastSeenAt:at,events:[]};
            s.v3.detachedInstances.push(found);}
          instance=found;
          const at=new Date().toISOString(),digest=sha(fs.readFileSync(r.evidencePath));
          instance.lastSeenAt=at;if(r.state)instance.state=r.state;
          if(!instance.events.some(e=>e.evidencePath===r.evidencePath&&e.digest===digest))
            instance.events.push({kind:'query',evidencePath:r.evidencePath,digest,at});
        } else {
          // Protocol 2 had no instance journal; retain its bound-job observation behavior.
          engine.ensure(j && j.nativeId===r.nativeId,'旧协议只能登记已绑定任务');
          const at=new Date().toISOString();
          instance={key:`legacy:${r.nativeId}`,nativeId:r.nativeId,state:r.state||'unknown',
            firstSeenAt:at,lastSeenAt:at,events:[]};
        }
        if(r.startedAt)instance.startedAt ||= r.startedAt;
        if(r.completedAt)instance.completedAt ||= r.completedAt;
        if(r.cancelledAt)instance.cancelledAt ||= r.cancelledAt;
        if(r.provider)instance.observedProvider=r.provider;
        if(j?.session&&j.nativeId===r.nativeId)instance.session ||= j.session;
        if(r.usage!==undefined)appendHostUsage(instance,r.usage,{sourcePath:archived,
          sourceSha256,at:new Date().toISOString(),scope:r.usageScope,modelCallId:r.modelCallId,
          sourceIndex,supportingEvidencePath:r.evidencePath});
        if(j && j.nativeId===r.nativeId){
          if(r.startedAt){j.timing??={leasedAt:''};j.timing.startedAt=r.startedAt;}
          if(r.usage && typeof r.usage==='object' && !Array.isArray(r.usage) &&
            Object.keys(r.usage).every(k=>['inputTokens','outputTokens','cost','currency','modelMs'].includes(k)))
            j.usage=r.usage as engine.Job['usage'];
        }
      }
      engine.event(s,'记录宿主原始时间与用量；未绑定或独立实例仍保留，未知字段保持未知');
    } else if (op === 'record-wait') {
      engine.ensure(extra,'需要带版本与证据的等待区间观测');
      const r=read<{expectedRevision:number;id:string;kind:'recovery'|'external';scope:string;
        startedAt:string;endedAt?:string;evidencePath:string;reason:string}>(extra);
      engine.ensure(r.expectedRevision===s.revision,'等待区间观测版本已过期');
      engine.ensure(r.id&&r.scope&&r.reason&&['recovery','external'].includes(r.kind),
        '等待区间需要 ID、范围、原因和类型');
      engine.ensure(Number.isFinite(Date.parse(r.startedAt))&&
        (!r.endedAt||Number.isFinite(Date.parse(r.endedAt))&&Date.parse(r.endedAt)>=Date.parse(r.startedAt)),
        '等待区间时间无效');
      const evidenceDigest=sha(fs.readFileSync(safeFile(r.evidencePath)));
      s.waitIntervals??=[];
      const existing=s.waitIntervals.find(x=>x.id===r.id);
      if(existing) {
        engine.ensure(!existing.endedAt&&r.endedAt&&existing.kind===r.kind&&
          existing.scope===r.scope&&existing.startedAt===r.startedAt,
          '等待区间只能用同一 ID 与边界补记一次结束');
        existing.endedAt=r.endedAt;existing.closedEvidencePath=r.evidencePath;
        existing.closedEvidenceDigest=evidenceDigest;
      } else s.waitIntervals.push({id:r.id,kind:r.kind,scope:r.scope,startedAt:r.startedAt,
        endedAt:r.endedAt,evidencePath:r.evidencePath,evidenceDigest,reason:r.reason});
      engine.event(s,`记录 ${r.kind} 等待区间 ${r.id}`);
    } else if (op === 'submit') {
      engine.ensure(extra && fourth, '需要 jobId 与结果 JSON');
      const j = s.jobs.find(j => j.id === extra); engine.ensure(j, '未知 job'); const r = read<engine.Result>(fourth);
      const trial = structuredClone(s), trialJob = trial.jobs.find(x => x.id === extra)!;
      try {
        if (trialJob.status !== 'done') {
          engine.ensure(!trialJob.testExecution,'测试进程未完成');
          if (trial.protocol === engine.currentProtocol && trialJob.executor === 'agent') {
          if(unifiedDispatchRequired(trial,trialJob))verifiedDispatchCompletion(trial,trialJob);
          engine.ensure(trialJob.session, '缺少原生会话观测'); verifySessionArtifact(trialJob.session);
          verifyHandoffRef(trialJob);
            if (trialJob.tier === 'L1') {
              const artifact = decisionArtifacts(trial, trialJob, r);
              trialJob.decisionArtifactDigest = artifact.digest; trialJob.decisionArtifactFiles = artifact.files;
            }
          }
          trial.facts = observe(trial,[trialJob]); validateResult(trial, trialJob, r, statePath);
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
          confirmStopped(s,statePath,j,{state:observation.state,evidencePath:observation.evidencePath,
            processTreeStopped:observation.processTreeStopped,commandDisposition:observation.commandDisposition});
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
        t.handoffPath = d.handoffPath; t.phase = t.worktree ? 'replan' : 'claim';
        t.epoch++; t.reviewDisagreementId=undefined; t.reason = '';
        if (session) {
          const artifact = artifactFingerprint([d.evidencePath, d.handoffPath]);
          engine.recordL1Decision(s, { id: `resolve:${t.key}:${t.epoch}:${randomUUID()}`, kind: 'resolve', scope: t.key,
            inputVersion: engine.inputVersion(s), sourceVersion: s.planSourceVersion,
            candidateVersion: originalCandidate, appliesToCandidateVersion: engine.candidateVersion(s, t),
            artifactPath: path.resolve(d.evidencePath), artifactFiles: artifact.files, artifactDigest: artifact.digest,
            session, at: new Date().toISOString() });
        }
      }
      if (s.status === 'blocked' || s.status === 'running') s.status = 'running';
      engine.event(s, 'L1 用已取得的新事实解除局部阻塞；重新规划而非跳过验证');
      s.specAudit = undefined; s.auditEpoch++;
    } else if (op === 'resume') {
      engine.ensure(extra,'恢复暂停或人工条件需要单独的版本化继续决定');
      const decision=read<{schemaVersion:1;expectedRevision:number;expectedStatus:engine.State['status'];
        kind:'user_resume'|'human_condition_resolved'|'blocked_resume';inputVersion:string;
        decisionNativeId:string;evidencePath:string;humanEvidencePath?:string;reason:string}>(extra);
      engine.ensure(decision.schemaVersion===1 && decision.expectedRevision===s.revision &&
        decision.expectedStatus===s.status && decision.inputVersion===engine.inputVersion(s),
        '恢复决定的状态、revision 或输入版本已过期');
      engine.ensure(s.status==='paused'||s.status==='waiting_human'||s.status==='blocked',
        '只有暂停、人工等待或已阻断的运行可显式恢复');
      engine.ensure(decision.kind===(s.status==='paused'?'user_resume':s.status==='waiting_human'?
        'human_condition_resolved':'blocked_resume') && !!decision.reason?.trim(),
        '恢复决定必须对应用户暂停或当前人工条件，并说明继续原因');
      engine.ensure(!s.jobs.some(active) && !s.jobs.some(j=>j.testExecution),
        '恢复前先对账或停止已有任务及测试进程');
      safeFile(decision.evidencePath);
      engine.ensure(fs.readFileSync(decision.evidencePath,'utf8').trim(),'继续授权依据不能为空');
      if(s.status==='waiting_human') {
        safeFile(decision.humanEvidencePath || '');
        engine.ensure(fs.readFileSync(decision.humanEvidencePath!,'utf8').trim(),
          '人工条件解除需要非空原始依据');
      }
      engine.ensure(decision.decisionNativeId,'恢复决定需要真实 L1 原生会话');
      const session=nativeSession(statePath,decision.decisionNativeId,'$resume');
      engine.verifyNativeSession(s,session,decision.decisionNativeId,'L1');verifySessionArtifact(session);
      engine.reconcileFacts(s,observe(s));
      if(decision.expectedStatus==='waiting_human')
        engine.ensure(s.tickets.filter(t=>t.kind==='human').every(t=>t.phase==='done'),
          '仍有未完成的人工工单；不能解除 waiting_human');
      s.continuations??=[];s.continuations.push({at:new Date().toISOString(),fromStatus:decision.expectedStatus,
        kind:decision.kind,decisionPath:path.resolve(extra),decisionSha256:sha(fs.readFileSync(extra)),
        evidencePath:path.resolve(decision.evidencePath),evidenceSha256:sha(fs.readFileSync(decision.evidencePath)),
        ...(decision.humanEvidencePath?{humanEvidencePath:path.resolve(decision.humanEvidencePath),
          humanEvidenceSha256:sha(fs.readFileSync(decision.humanEvidencePath))}:{}),session});
      s.status='running';s.specAudit=undefined;s.auditEpoch++;s.mainSession=session;
      engine.event(s, 'L1 按单独的继续决定恢复运行；局部阻塞仍需逐项处理');
    } else throw new Error(`未知命令 ${op}`);
    save(statePath, s); return { statePath, status: s.status, revision: s.revision };
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ error: error.message, note: '未满足的条件不会被当作成功；核对后由 L1 继续' }) + '\n'); process.exitCode = 1;
  });
}
