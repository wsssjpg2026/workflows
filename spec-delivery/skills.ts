import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { candidateVersion, ensure, event, currentProtocol, verifyNativeSession, type Job, type SkillBinding, type SkillCapability,
  inputVersion, type SkillChildRequest, type Tier, type SkillInvocation, type SkillMode, type SkillResult, type SkillStatus, type State } from './core.ts';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const capabilities: SkillCapability[] = ['implementation', 'diagnosis', 'authorReview', 'prReview', 'handoff'];
const defaultNames: Record<SkillCapability, string> = {
  implementation: 'implement', diagnosis: 'diagnosing-bugs', authorReview: 'code-review',
  prReview: 'code-review-from-claude', handoff: 'handoff',
};
export const skillCapabilities = capabilities;
export function defaultSkillPaths(root?: string): Record<SkillCapability, string> {
  const sourceRoot=root || path.join(os.homedir(), '.agents', 'skills');
  const paths=Object.fromEntries(capabilities.map(capability =>
    [capability, path.join(sourceRoot, defaultNames[capability], 'SKILL.md')])) as Record<SkillCapability, string>;
  if (root === undefined) {
    paths.authorReview=path.join(path.dirname(fileURLToPath(import.meta.url)),
      'review-skills','code-review','SKILL.md');
    paths.prReview=path.join(path.dirname(fileURLToPath(import.meta.url)),
      'review-skills','code-review-from-claude','SKILL.md');
  }
  return paths;
}

/** Pin the exact bytes of the skill and every file in its package, including referenced resources. */
export function resolveSkill(capability: SkillCapability, inputPath: string): SkillBinding {
  ensure(capabilities.includes(capability), `未知技能能力：${capability}`);
  let sourcePath: string;
  try { sourcePath = fs.realpathSync(path.resolve(inputPath)); }
  catch (error) { throw new Error(`${capability} 技能来源不可读取：${inputPath}；${(error as Error).message}`); }
  ensure(fs.statSync(sourcePath).isFile() && path.basename(sourcePath) === 'SKILL.md', '技能来源必须是实际 SKILL.md 文件');
  const root = path.dirname(sourcePath), files: SkillBinding['files'] = [];
  let totalBytes = 0;
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const file = path.join(directory, entry.name);
      ensure(!entry.isSymbolicLink(), `技能依赖不能是符号链接：${file}`);
      if (entry.isDirectory()) { walk(file); continue; }
      ensure(entry.isFile(), `技能依赖不是普通文件：${file}`);
      const bytes = fs.readFileSync(file);
      totalBytes += bytes.length;
      ensure(files.length < 128 && totalBytes <= 8 * 1024 * 1024, '技能包过大，不能可靠固定依赖版本');
      files.push({ path: file, relativePath: path.relative(root, file).split(path.sep).join('/'), sha256: digest(bytes) });
    }
  };
  walk(root);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const header = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  ensure(header && source.slice(header[0].length).trim(), `技能缺少有效 frontmatter 或正文：${sourcePath}`);
  const name = header[1].match(/^name:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]?.trim();
  ensure(name, `技能缺少 name：${sourcePath}`);
  // disable-model-invocation limits unsolicited model selection. The workflow's bound stage is an explicit call.
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { capability, name, sourcePath, files,
    fingerprint: digest(JSON.stringify({ sourcePath, name, files: files.map(({relativePath, sha256}) => [relativePath, sha256]) })),
    pinnedAt: new Date().toISOString() };
}
export function defaultSkillBindings(root?: string) {
  const paths = defaultSkillPaths(root);
  return capabilities.map(capability => resolveSkill(capability, paths[capability]));
}
export function bindingFor(s: State, capability: SkillCapability): SkillBinding {
  ensure(s.protocol === currentProtocol && s.v3?.skillBindings, '运行尚未固定技能绑定；先迁移当前运行');
  const binding = s.v3.skillBindings.find(b => b.capability === capability);
  ensure(binding, `缺少 ${capability} 技能绑定`);
  return binding;
}
export function verifySkillBinding(binding: SkillBinding) {
  const current = resolveSkill(binding.capability, binding.sourcePath);
  ensure(current.fingerprint === binding.fingerprint, `${binding.capability} 技能或依赖版本漂移；需要显式 migrate-skills`);
  return current;
}

export interface NativeSkillRegistration { entry: string; sourcePath: string; fingerprint: string }
export interface SkillHostCapabilities {
  nativeExplicit?: { supported: boolean; registrations: NativeSkillRegistration[] };
  sourceExecution?: { allowed: boolean; acceptsOriginalFiles: boolean };
}
export interface SkillSourceBundle {
  capability: SkillCapability; name: string; sourcePath: string; fingerprint: string;
  files: { relativePath: string; sourcePath: string; sha256: string; dataBase64: string }[];
}
export interface PreparedSkillCall { invocation: SkillInvocation; source: SkillSourceBundle; nativeEntry?: string; alreadyStarted: boolean }

export interface SkillChildSpec {
  key: string; instruction: string; tier: Tier; required?: boolean; independent?: boolean;
  skillCapability?: SkillCapability; head?: string;
}
function activeParent(s: State, invocationId: string) {
  ensure(s.status === 'running' && s.v3, 'workflow 未运行或缺少技能账本');
  const invocation = s.v3.skillInvocations.find(i => i.id === invocationId);
  ensure(invocation && !invocation.result, '父技能调用不存在或已完成');
  const job = s.jobs.find(j => j.id === invocation.jobId);
  ensure(job && job.status === 'running' && job.session &&
    JSON.stringify(job.session) === JSON.stringify(invocation.session), '父技能调用没有正在运行的真实宿主');
  const t = job.ticket === '$spec' ? undefined : s.tickets.find(x => x.key === job.ticket);
  ensure(invocation.candidateVersion === candidateVersion(s, t) && job.inputVersion === inputVersion(s),
    '父技能调用的输入或候选已过期');
  verifySkillBinding(bindingFor(s, invocation.capability));
  return { invocation, job };
}
export function skillChildState(s: State, child: SkillChildRequest) {
  const job = child.jobIds.length ? s.jobs.find(j => j.id === child.jobIds.at(-1)) : undefined;
  if (child.pending) return 'pending' as const;
  if (!job) return 'pending' as const;
  if (job.status === 'cancelled') return 'failed' as const;
  if (job.status !== 'done') return 'running' as const;
  return job.result?.complete && job.result.status === 'completed' ? 'completed' as const : 'failed' as const;
}
/** A request key is stable across process restarts; its definition cannot be silently changed. */
export function delegateSkillChildren(s: State, invocationId: string, specs: SkillChildSpec[]) {
  const { invocation, job } = activeParent(s, invocationId);
  ensure(Array.isArray(specs) && specs.length > 0 && new Set(specs.map(x => x.key)).size === specs.length,
    '技能委派需要非空且不重复的子任务 key');
  s.v3!.skillChildren ??= [];
  const rows: SkillChildRequest[] = [];
  for (const spec of specs) {
    ensure(spec && typeof spec.key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(spec.key) &&
      typeof spec.instruction === 'string' && spec.instruction.trim() &&
      ['L1', 'L2', 'L3'].includes(spec.tier) &&
      (spec.required === undefined || typeof spec.required === 'boolean') &&
      (spec.independent === undefined || typeof spec.independent === 'boolean') &&
      Object.keys(spec).every(key=>['key','instruction','tier','required','independent','skillCapability','head'].includes(key)),
      '技能子任务定义无效；模型只能来自已确认的 L1/L2/L3 路由');
    ensure(!spec.skillCapability || capabilities.includes(spec.skillCapability), '子任务引用未知技能能力');
    ensure(spec.head === undefined || /^[0-9a-f]{40}$/.test(spec.head), '子任务候选 head 必须是完整提交 SHA');
    ensure(!spec.head || spec.head === job.head || ['implement', 'integrate'].includes(job.action),
      '只读父任务不能指定不同候选 head');
    const dependency = spec.skillCapability ? verifySkillBinding(bindingFor(s, spec.skillCapability)) : undefined;
    const expected: Omit<SkillChildRequest, 'jobIds' | 'pending' | 'requestedAt'> = {
      id: `${invocationId}:child:${spec.key}`, parentInvocationId: invocationId, key: spec.key,
      instruction: spec.instruction, tier: spec.tier, model: s.inputs.models[spec.tier],
      required: spec.required !== false, independent: spec.independent !== false || job.fresh,
      fresh: job.fresh, candidateVersion: invocation.candidateVersion, inputVersion: inputVersion(s),
      head: spec.head || job.head, base: job.base, ...(dependency ? {skillCapability: spec.skillCapability,
        dependencyFingerprint: dependency.fingerprint} : {}),
    };
    const existing = s.v3!.skillChildren.find(x => x.id === expected.id);
    if (existing) {
      const comparable = Object.fromEntries(Object.entries(existing).filter(([k]) => !['jobIds','pending','requestedAt'].includes(k)));
      ensure(JSON.stringify(comparable) === JSON.stringify(expected), '相同子任务 key 的委派定义或版本已改变');
      rows.push(existing); continue;
    }
    const row: SkillChildRequest = {...expected, jobIds: [], pending: true, requestedAt: new Date().toISOString()};
    s.v3!.skillChildren.push(row); rows.push(row);
  }
  event(s, `${invocation.capability} 请求 ${rows.length} 个已登记子任务`);
  return rows;
}
export function retrySkillChildren(s: State, invocationId: string, keys: string[]) {
  activeParent(s, invocationId);
  ensure(Array.isArray(keys) && keys.length > 0 && new Set(keys).size === keys.length,
    '重试需要不重复的子任务 key');
  const rows = keys.map(key => {
    const row = s.v3!.skillChildren?.find(x => x.parentInvocationId === invocationId && x.key === key);
    ensure(row && skillChildState(s, row) === 'failed', `子任务 ${key} 尚未失败，不能重复派发`);
    const last = s.jobs.find(j => j.id === row.jobIds.at(-1));
    ensure(last?.status === 'done' || last?.status === 'cancelled' && last.stopConfirmation,
      '失败子任务仍有未停止的宿主租约');
    row.pending = true; return row;
  });
  event(s, `${invocationId} 显式重试 ${rows.length} 个子任务`);
  return rows;
}
export function skillChildrenSnapshot(s: State, invocationId: string) {
  const { invocation } = activeParent(s, invocationId);
  const children = (s.v3!.skillChildren || []).filter(x => x.parentInvocationId === invocationId).map(x => {
    const job = x.jobIds.length ? s.jobs.find(j => j.id === x.jobIds.at(-1)) : undefined;
    return { key: x.key, requestId: x.id, state: skillChildState(s, x), required: x.required,
      tier: x.tier, requestedModel: x.model, observedModel: job?.session?.model || null,
      nativeId: job?.nativeId || null, jobId: job?.id || null, attempts: x.jobIds.length,
      fresh: x.fresh, independent: x.independent, candidateVersion: x.candidateVersion,
      skillCapability: x.skillCapability || null, dependencyFingerprint: x.dependencyFingerprint || null,
      result: job?.result || null };
  });
  return { invocationId, parentJobId: invocation.jobId,
    waiting: children.some(x => ['pending','running'].includes(x.state) || x.required && x.state !== 'completed'), children };
}
export function requireSkillChildrenComplete(s: State, invocationId: string) {
  const rows = (s.v3?.skillChildren || []).filter(x => x.parentInvocationId === invocationId);
  const invocation=s.v3?.skillInvocations.find(i=>i.id===invocationId);
  const parent=invocation && s.jobs.find(j=>j.id===invocation.jobId);
  ensure(invocation && parent, '技能子任务缺少父调用');
  // A skill package may declare its own automation topology. This generic
  // contract is part of the pinned source bundle; alternative skills need
  // neither these keys nor any particular review method.
  const source=JSON.parse(fs.readFileSync(invocation.sourceArchivePath,'utf8')) as SkillSourceBundle;
  const contractFile=source.files.find(file=>file.relativePath==='automation-contract.json');
  if(contractFile) {
    const contract=JSON.parse(Buffer.from(contractFile.dataBase64,'base64').toString('utf8')) as
      {schema?:number;requiredChildren?:{key?:string;tier?:Tier;independent?:boolean}[]};
    ensure(contract.schema===1 && Array.isArray(contract.requiredChildren) &&
      contract.requiredChildren.every(item=>typeof item.key==='string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(item.key) && ['L1','L2','L3'].includes(item.tier || '') &&
        typeof item.independent==='boolean') &&
      new Set(contract.requiredChildren.map(item=>item.key)).size===contract.requiredChildren.length,
      '技能包自动化契约无效');
    for(const required of contract.requiredChildren) {
      const child=rows.find(row=>row.key===required.key);
      ensure(child?.required && child.tier===required.tier && child.independent===required.independent,
        `技能包要求的子任务 ${required.key} 未按绑定契约登记`);
    }
  }
  const authored=rows.filter(x=>x.required && x.head!==parent.head);
  if(authored.length) {
    const t=s.tickets.find(t=>t.key===parent.ticket);
    ensure(t?.worktree && ['implement','integrate'].includes(parent.action), '子任务候选来源与父任务不符');
    const current=execFileSync('git',['rev-parse','HEAD'],{cwd:t.worktree,encoding:'utf8'}).trim();
    ensure(authored.every(x=>x.head===current), '技能子任务证据不是当前已提交候选 head');
  }
  for (const child of rows) {
    ensure(['completed','failed'].includes(skillChildState(s, child)), `技能子任务 ${child.key} 尚有在途租约`);
    if (!child.required) continue;
    ensure(skillChildState(s, child) === 'completed', `必需技能子任务 ${child.key} 尚未完成`);
    if (child.skillCapability) {
      const binding = verifySkillBinding(bindingFor(s, child.skillCapability));
      ensure(binding.fingerprint === child.dependencyFingerprint, `子任务 ${child.key} 的引用技能版本已改变`);
    }
  }
}

/** Reattach the same invocation after the old host is proven stopped; child receipts remain in place. */
export function resumeSkillCall(s: State, invocationId: string, replacement: Job,
  host: SkillHostCapabilities, evidencePath: string) {
  ensure(s.status === 'running' && s.v3, 'workflow 未运行或缺少技能账本');
  const invocation = s.v3.skillInvocations.find(i => i.id === invocationId);
  ensure(invocation && !invocation.result, '仅能续接未完成的技能调用');
  const previous = s.jobs.find(j => j.id === invocation.jobId);
  ensure(previous?.status === 'cancelled' && previous.stopConfirmation &&
    previous.stopConfirmation.processTreeStopped, '旧父任务尚未由宿主确认完整停止');
  ensure(replacement.status === 'running' && replacement.session && replacement.nativeId &&
    replacement.id !== previous.id && replacement.ticket === previous.ticket &&
    replacement.epoch === previous.epoch && replacement.action === previous.action &&
    replacement.tier === previous.tier && replacement.model === previous.model &&
    replacement.candidateVersion === previous.candidateVersion &&
    replacement.inputVersion === previous.inputVersion && replacement.head === previous.head &&
    replacement.base === previous.base, '续接任务与原父调用的角色或候选不一致');
  verifyNativeSession(s,replacement.session,replacement.nativeId,replacement.tier);
  ensure(replacement.session.nativeId !== invocation.session.nativeId &&
    replacement.session.observationId !== invocation.session.observationId, '续接必须使用新的原生执行者');
  ensure(fs.statSync(evidencePath).isFile() && fs.readFileSync(evidencePath,'utf8').trim(), '续接需要非空宿主依据');
  const binding = verifySkillBinding(bindingFor(s,invocation.capability));
  ensure(binding.fingerprint === invocation.bindingFingerprint &&
    invocation.candidateVersion === candidateVersion(s,
      replacement.ticket === '$spec' ? undefined : s.tickets.find(t=>t.key===replacement.ticket)) &&
    replacement.inputVersion === inputVersion(s), '旧调用的技能或候选版本已变化');
  if (invocation.mode === 'native_explicit')
    ensure(host.nativeExplicit?.supported && host.nativeExplicit.registrations.some(r=>
      r.entry===invocation.nativeEntry && r.sourcePath===binding.sourcePath && r.fingerprint===binding.fingerprint),
      '新宿主没有原调用的同版本原生技能入口');
  else ensure(host.sourceExecution?.allowed && host.sourceExecution.acceptsOriginalFiles,
    '新宿主不能加载已归档的原始技能及依赖');
  ensure(!s.v3.skillInvocations.some(i=>i!==invocation && i.jobId===replacement.id && !i.result),
    '续接 actor 已启动另一技能调用');
  const prior = { previousJobId: previous.id, previousSession: invocation.session,
    jobId: replacement.id, session: replacement.session, evidencePath: path.resolve(evidencePath),
    evidenceSha256: digest(fs.readFileSync(evidencePath)),
    previousHostCapabilityPath: invocation.hostCapabilityPath,
    previousHostCapabilitySha256: invocation.hostCapabilitySha256,
    at: new Date().toISOString() };
  invocation.resumeHistory ??= []; invocation.resumeHistory.push(prior);
  invocation.jobId = replacement.id; invocation.session = replacement.session;
  event(s, `${invocation.id} 由 ${previous.id} 续接到 ${replacement.id}；已完成子结果保留`);
  return invocation;
}

function sourceBundle(binding: SkillBinding): SkillSourceBundle {
  return { capability: binding.capability, name: binding.name, sourcePath: binding.sourcePath, fingerprint: binding.fingerprint,
    files: binding.files.map(file => ({ relativePath: file.relativePath, sourcePath: file.path,
      sha256: file.sha256, dataBase64: fs.readFileSync(file.path).toString('base64') })) };
}
function archiveSource(statePath: string, id: string, bundle: SkillSourceBundle) {
  const file = path.join(path.dirname(statePath), 'skills', digest(id).slice(0, 20), 'source.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) ensure(fs.readFileSync(file, 'utf8') === JSON.stringify(bundle), '已归档技能来源与当前来源不符');
  else fs.writeFileSync(file, JSON.stringify(bundle), { flag: 'wx' });
  return file;
}
export function prepareSkillCall(s: State, job: Job, capability: SkillCapability, host: SkillHostCapabilities,
  statePath: string): PreparedSkillCall {
  ensure(s.status === 'running', '运行暂停或阻断时不能启动新的技能调用');
  ensure(job.executor === 'agent' && (job.status === 'running' || capability === 'handoff' && job.status === 'done') && job.nativeId && job.session,
    '技能必须由已绑定真实宿主会话的 agent job 显式调用');
  ensure(job.session.jobId === job.id && job.session.nativeId === job.nativeId, '技能调用执行者与 job 不符');
  verifyNativeSession(s, job.session, job.nativeId, job.tier);
  const binding = bindingFor(s, capability);
  verifySkillBinding(binding);
  const existing = s.v3!.skillInvocations.findLast(i => i.jobId === job.id && i.capability === capability && !i.result);
  if (existing) {
    ensure(existing.bindingFingerprint === binding.fingerprint, '未完成调用的技能版本已变化；先对账');
    return { invocation: existing, source: JSON.parse(fs.readFileSync(existing.sourceArchivePath, 'utf8')),
      nativeEntry: existing.nativeEntry, alreadyStarted: true };
  }
  ensure(!s.v3!.skillInvocations.some(i => !i.result && i.capability === capability && i.jobId !== job.id &&
    s.jobs.some(old => old.id === i.jobId && old.status === 'cancelled' && old.ticket === job.ticket &&
      old.epoch === job.epoch && old.action === job.action && old.candidateVersion === job.candidateVersion)),
    '同候选旧父技能调用待续接；使用 skill-resume，不能重做已有专业步骤');
  const registration = host.nativeExplicit?.supported && Array.isArray(host.nativeExplicit.registrations)
    ? host.nativeExplicit.registrations.find(r =>
      r.sourcePath === binding.sourcePath && r.fingerprint === binding.fingerprint && !!r.entry)
    : undefined;
  const mode: SkillMode = registration ? 'native_explicit' : 'source_execution';
  if (!registration) ensure(host.sourceExecution?.allowed && host.sourceExecution.acceptsOriginalFiles,
    `宿主没有已注册且指纹匹配的 ${binding.name} 原生显式调用，且不允许加载原技能及依赖源码执行`);
  const currentCandidate = candidateVersion(s, job.ticket === '$spec' ? undefined : s.tickets.find(t => t.key === job.ticket));
  if (!(capability === 'handoff' && job.status === 'done'))
    ensure(job.candidateVersion === currentCandidate, '候选版本改变，不能调用旧 job 的技能');
  const id = `${job.id}:skill:${capability}:${randomUUID()}`;
  const source = sourceBundle(binding);
  ensure(source.files.every(file => digest(Buffer.from(file.dataBase64, 'base64')) === file.sha256),
    '读取技能原文期间来源改变，不能开始调用');
  const sourceArchivePath = archiveSource(statePath, id, source);
  const invocation: SkillInvocation = { id, jobId: job.id, capability, bindingFingerprint: binding.fingerprint,
    mode, nativeEntry: registration?.entry, session: job.session, candidateVersion: currentCandidate,
    head: job.head, base: job.base, startedAt: new Date().toISOString(), sourceArchivePath };
  s.v3!.skillInvocations.push(invocation);
  event(s, `${job.ticket} · ${capability} 已授权 ${mode} 调用，来源 ${binding.fingerprint}`);
  return { invocation, source, nativeEntry: registration?.entry, alreadyStarted: false };
}

export interface SkillOutcome {
  status: SkillStatus; blocking: boolean; rawOutputPath?: string; evidencePaths?: string[]; hostReceiptPath: string;
}
function nonblank(file: string) {
  ensure(fs.statSync(file).isFile() && fs.readFileSync(file).toString('utf8').trim().length > 0, `技能产物为空：${file}`);
  return file;
}
function verifyResumeHistory(invocation: SkillInvocation) {
  for (const resume of invocation.resumeHistory || []) {
    ensure(digest(fs.readFileSync(nonblank(resume.evidencePath))) === resume.evidenceSha256,
      '技能续接宿主依据已改变');
    if (resume.previousHostCapabilityPath)
      ensure(digest(fs.readFileSync(nonblank(resume.previousHostCapabilityPath))) ===
        resume.previousHostCapabilitySha256, '原宿主技能能力观测已改变');
  }
}
function archiveArtifact(invocation: SkillInvocation, leaf: string, original: string) {
  const archived = path.join(path.dirname(invocation.sourceArchivePath), leaf);
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  const bytes = fs.readFileSync(original);
  if (fs.existsSync(archived)) ensure(fs.readFileSync(archived).equals(bytes), '已有原始技能产物归档与当前字节不符');
  else fs.writeFileSync(archived, bytes, { flag: 'wx' });
  return archived;
}
export function finishSkillCall(s: State, invocationId: string, outcome: SkillOutcome): SkillResult {
  ensure(s.protocol === currentProtocol && s.v3, '只有 v3 运行能收取技能结果');
  const invocation = s.v3.skillInvocations.find(i => i.id === invocationId);
  ensure(invocation, `未知技能调用 ${invocationId}`);
  verifyResumeHistory(invocation);
  if (invocation.result) {
    ensure(invocation.result.status === outcome.status && invocation.result.blocking === outcome.blocking &&
      invocation.result.originalOutputPath === (outcome.rawOutputPath ? path.resolve(outcome.rawOutputPath) : undefined) &&
      invocation.result.originalHostReceiptPath === path.resolve(outcome.hostReceiptPath) &&
      digest(fs.readFileSync(invocation.result.hostReceiptPath)) === invocation.result.hostReceiptSha256,
      '重复技能回执内容不一致');
    return invocation.result;
  }
  const job = s.jobs.find(j => j.id === invocation.jobId);
  ensure(job && (job.status === 'running' || invocation.capability === 'handoff' && job.status === 'done') &&
    job.session && JSON.stringify(job.session) === JSON.stringify(invocation.session),
    '技能结果不属于当前真实执行者');
  if (invocation.hostCapabilityPath)
    ensure(digest(fs.readFileSync(nonblank(invocation.hostCapabilityPath))) === invocation.hostCapabilitySha256,
      '技能宿主能力观测归档已改变');
  verifySkillBinding(bindingFor(s, invocation.capability));
  ensure(bindingFor(s, invocation.capability).fingerprint === invocation.bindingFingerprint,
    '技能调用的版本已迁移，旧结果不能用于当前门禁');
  if (!(invocation.capability === 'handoff' && job.status === 'done'))
    ensure(candidateVersion(s, job.ticket === '$spec' ? undefined : s.tickets.find(t => t.key === job.ticket)) === invocation.candidateVersion,
      '技能结果候选已过期');
  ensure(['pass', 'changes_required', 'incomplete', 'skipped'].includes(outcome.status) && typeof outcome.blocking === 'boolean',
    '技能外围回执缺少明确状态或阻断结论');
  ensure(outcome.status !== 'pass' || outcome.blocking === false, 'pass 不能同时声明阻断');
  ensure(outcome.status !== 'changes_required' || outcome.blocking === true, 'changes_required 必须声明阻断');
  if (outcome.status === 'pass' || outcome.status === 'changes_required') requireSkillChildrenComplete(s, invocationId);
  const hostReceiptPath = nonblank(path.resolve(outcome.hostReceiptPath));
  const hostReceipt = JSON.parse(fs.readFileSync(hostReceiptPath, 'utf8')) as Record<string, unknown>;
  ensure(hostReceipt.invocationId === invocation.id && hostReceipt.jobId === job.id && hostReceipt.nativeId === job.nativeId &&
    hostReceipt.source === 'native_host' && hostReceipt.mode === invocation.mode && hostReceipt.terminal === true &&
    hostReceipt.bindingFingerprint === invocation.bindingFingerprint &&
    hostReceipt.observationId === job.session.observationId &&
    (invocation.mode !== 'native_explicit' || hostReceipt.nativeEntry === invocation.nativeEntry),
    '宿主回执未证明本次技能调用、实际模式或终态');
  if (invocation.mode === 'source_execution') {
    const source = JSON.parse(fs.readFileSync(invocation.sourceArchivePath, 'utf8')) as SkillSourceBundle;
    ensure(Array.isArray(hostReceipt.loadedFiles) &&
      JSON.stringify(hostReceipt.loadedFiles) === JSON.stringify(source.files.map(file =>
        ({ relativePath: file.relativePath, sha256: file.sha256 }))),
      '源码执行宿主未证明逐字加载原技能及引用资源');
  }
  const rawOutputPath = outcome.rawOutputPath ? path.resolve(outcome.rawOutputPath) : '';
  const evidencePaths = (outcome.evidencePaths || []).map(p => path.resolve(p));
  if (outcome.status === 'pass' || outcome.status === 'changes_required') {
    ensure(rawOutputPath, '完整技能结论缺少原始产物');
    nonblank(rawOutputPath);
    ensure(evidencePaths.length > 0, '完整技能结论缺少证据');
    evidencePaths.forEach(nonblank);
    if (invocation.capability === 'handoff')
      ensure(fs.realpathSync(rawOutputPath).startsWith(fs.realpathSync(os.tmpdir()) + path.sep),
        '原始 handoff 必须先写入 OS 临时目录');
  } else {
    if (rawOutputPath) nonblank(rawOutputPath);
    evidencePaths.forEach(nonblank);
  }
  const archivedRaw = rawOutputPath ? archiveArtifact(invocation, 'raw-output', rawOutputPath) : '';
  const archivedReceipt = archiveArtifact(invocation, 'host-receipt.json', hostReceiptPath);
  const archivedEvidence = evidencePaths.map((file, index) => archiveArtifact(invocation, `evidence/${index}`, file));
  const result: SkillResult = { status: outcome.status, blocking: outcome.blocking,
    originalOutputPath: rawOutputPath || undefined, rawOutputPath: archivedRaw,
    rawOutputSha256: archivedRaw ? digest(fs.readFileSync(archivedRaw)) : '',
    originalEvidencePaths: evidencePaths, evidencePaths: archivedEvidence,
    evidenceSha256: archivedEvidence.map(file => digest(fs.readFileSync(file))),
    originalHostReceiptPath: hostReceiptPath, hostReceiptPath: archivedReceipt,
    hostReceiptSha256: digest(fs.readFileSync(archivedReceipt)), completedAt: new Date().toISOString() };
  invocation.result = result;
  event(s, `${job.ticket} · ${invocation.capability} ${invocation.mode} → ${result.status}`);
  return result;
}

export function verifySkillResultFiles(s: State, job: Job, invocationIds: string[], handoffPath?: string) {
  for (const id of invocationIds) {
    const invocation = s.v3?.skillInvocations.find(i => i.id === id);
    ensure(invocation && invocation.jobId === job.id && invocation.result, '外层结果引用未完成的技能调用');
    verifyResumeHistory(invocation);
    if (invocation.result.status === 'pass' || invocation.result.status === 'changes_required')
      requireSkillChildrenComplete(s, invocation.id);
    const binding = bindingFor(s, invocation.capability);
    verifySkillBinding(binding);
    ensure(binding.fingerprint === invocation.bindingFingerprint, '技能调用版本与运行绑定不符');
    if (invocation.hostCapabilityPath)
      ensure(digest(fs.readFileSync(nonblank(invocation.hostCapabilityPath))) === invocation.hostCapabilitySha256,
        '技能宿主能力观测归档已改变');
    const archived = JSON.parse(fs.readFileSync(nonblank(invocation.sourceArchivePath), 'utf8')) as SkillSourceBundle;
    ensure(archived.fingerprint === binding.fingerprint && archived.sourcePath === binding.sourcePath &&
      archived.files.length === binding.files.length && archived.files.every((file, index) =>
        file.relativePath === binding.files[index].relativePath && file.sha256 === binding.files[index].sha256 &&
        digest(Buffer.from(file.dataBase64, 'base64')) === file.sha256), '原始技能来源归档已改变');
    const result = invocation.result;
    ensure(digest(fs.readFileSync(nonblank(result.hostReceiptPath))) === result.hostReceiptSha256,
      '技能宿主回执已改变');
    if (result.rawOutputPath) ensure(digest(fs.readFileSync(nonblank(result.rawOutputPath))) === result.rawOutputSha256,
      '技能原始产物已改变');
    result.evidencePaths.forEach((file, index) =>
      ensure(digest(fs.readFileSync(nonblank(file))) === result.evidenceSha256[index], '技能专业证据已改变'));
    if (invocation.capability === 'handoff' && handoffPath && result.rawOutputPath)
      ensure(digest(fs.readFileSync(nonblank(handoffPath))) === result.rawOutputSha256,
        '持久 handoff 不是原始技能产物的逐字副本');
  }
}

export interface SkillHostAdapter {
  capabilities(): Promise<SkillHostCapabilities>;
  invokeNative?(call: PreparedSkillCall): Promise<SkillOutcome>;
  executeSource?(call: PreparedSkillCall): Promise<SkillOutcome>;
}
/** Host adapters call the actual native Skill tool or run the original source; this function never infers a verdict. */
export async function invokeBoundSkill(s: State, job: Job, capability: SkillCapability, host: SkillHostAdapter,
  statePath: string, persist: (state: State) => void) {
  const capabilityReport = structuredClone(await host.capabilities());
  if (!host.invokeNative && capabilityReport.nativeExplicit) capabilityReport.nativeExplicit.supported = false;
  if (!host.executeSource && capabilityReport.sourceExecution) capabilityReport.sourceExecution.allowed = false;
  const call = prepareSkillCall(s, job, capability, capabilityReport, statePath);
  persist(s);
  ensure(!call.alreadyStarted, '调用已登记；先查询宿主状态，不能重复启动技能');
  const outcome = call.invocation.mode === 'native_explicit'
    ? await host.invokeNative?.(call) : await host.executeSource?.(call);
  ensure(outcome, `宿主缺少 ${call.invocation.mode} 的实际执行入口`);
  const result = finishSkillCall(s, call.invocation.id, outcome);
  persist(s);
  return { invocation: call.invocation, result };
}

export function migrateSkillBindings(s: State, replacements: Partial<Record<SkillCapability, string>>, evidencePath: string) {
  ensure(s.protocol === currentProtocol && s.v3, '只有协议 3 运行能迁移技能绑定');
  ensure(Object.keys(replacements).every(key => capabilities.includes(key as SkillCapability)), '技能迁移包含未知能力名称');
  ensure(fs.statSync(evidencePath).isFile() && fs.readFileSync(evidencePath, 'utf8').trim(), '技能迁移需要非空依据');
  ensure(!s.jobs.some(j => j.status === 'leased' || j.status === 'running'), '技能迁移前先停止或收取全部在途任务');
  const changed: SkillCapability[] = [];
  const previous = s.v3.skillBindings || [];
  const defaults = defaultSkillPaths();
  const next = capabilities.map(capability => {
    const prior = previous.find(binding => binding.capability === capability);
    const replacement = replacements[capability] || prior?.sourcePath || defaults[capability];
    const resolved = resolveSkill(capability, replacement);
    if (resolved.fingerprint !== prior?.fingerprint) changed.push(capability);
    return resolved;
  });
  ensure(changed.length > 0, '技能来源和依赖未变化，无需迁移');
  s.v3.skillBindings = next;
  s.v3.skillMigrations ??= [];
  s.v3.skillMigrations.push({ at: new Date().toISOString(), evidencePath: path.resolve(evidencePath),
    changes: changed.map(capability => ({ capability,
      previousFingerprint: previous.find(b => b.capability === capability)?.fingerprint || '',
      nextFingerprint: next.find(b => b.capability === capability)!.fingerprint })) });
  for (const t of s.tickets) {
    if (['done', 'human', 'close', 'cleanup', 'recovery'].includes(t.phase)) continue;
    if (changed.includes('implementation') || changed.includes('diagnosis') || changed.includes('handoff')) {
      if (!t.worktree || ['claim', 'plan', 'plan_check'].includes(t.phase)) continue;
      t.phase = 'replan'; t.epoch++; t.evidence = {}; t.authorReview=undefined;
      t.reason = '实现/诊断/交接技能版本迁移；重新批准计划并获取证据';
    } else if (changed.includes('authorReview')) {
      if (!['self', 'verify', 'publish', 'review', 'fresh', 'accept', 'merge'].includes(t.phase) &&
          !(t.phase === 'blocked' && t.reason === 'waiting_ci')) continue;
      t.phase = 'self'; t.epoch++; t.evidence = {}; t.authorReview=undefined;
      t.reason = '作者自检技能版本迁移；重新审查当前候选';
    } else if (changed.includes('prReview')) {
      if (!['review', 'fresh', 'accept', 'merge'].includes(t.phase) &&
          !(t.phase === 'blocked' && t.reason === 'waiting_ci')) continue;
      t.phase = 'review'; t.epoch++; delete t.evidence.regular; delete t.evidence.fresh; delete t.evidence.accept;
      t.reason = 'PR 审查技能版本迁移；重新取得 regular/fresh 证据';
    }
  }
  s.validationOwner = undefined;
  s.specAudit = undefined; s.auditEpoch++;
  event(s, `显式迁移技能 ${changed.join(', ')}；受影响候选证据失效。依据：${evidencePath}`);
  return changed;
}
