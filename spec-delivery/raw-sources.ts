import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ensure, type Job, type State, type Ticket } from './core.ts';
import * as gh from './github.ts';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const git = (root: string, ...args: string[]) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

export interface RawSourceFile {
  kind: 'spec' | 'issue' | 'diff' | 'standard' | 'history';
  origin: string; sourceVersion: string; fetchedAt: string;
  archivePath: string; sha256: string; bytes: number;
}
interface RawSourceManifest {
  schemaVersion: 1; key: string; repo: string; issue: number;
  candidate: { head: string; base: string };
  sourceVersions: { plan: string; spec: string; issue: string };
  fetchedAt: string; files: RawSourceFile[]; fingerprint: string;
}
export interface RawSourceIndex {
  manifestPath: string; fingerprint: string; cacheHit: boolean;
  candidate: RawSourceManifest['candidate']; sourceVersions: RawSourceManifest['sourceVersions'];
  files: RawSourceFile[];
}

function fingerprint(manifest: Omit<RawSourceManifest, 'fingerprint'>) {
  return digest(JSON.stringify(manifest));
}
function verify(manifest: RawSourceManifest, expected: Omit<RawSourceManifest, 'fetchedAt' | 'files' | 'fingerprint'>, directory: string) {
  ensure(manifest && typeof manifest === 'object' && manifest.candidate && manifest.sourceVersions &&
    Array.isArray(manifest.files) && manifest.schemaVersion === 1 &&
    manifest.key === expected.key && manifest.repo === expected.repo &&
    manifest.issue === expected.issue && manifest.candidate.head === expected.candidate.head &&
    manifest.candidate.base === expected.candidate.base &&
    JSON.stringify(manifest.sourceVersions) === JSON.stringify(expected.sourceVersions),
  '原始来源缓存版本与当前候选不一致');
  const { fingerprint: stored, ...unsigned } = manifest;
  ensure(stored === fingerprint(unsigned) && Array.isArray(manifest.files) && manifest.files.length >= 4,
    '原始来源缓存清单缺失或已改变');
  for (const file of manifest.files) {
    ensure(path.dirname(file.archivePath) === directory && fs.existsSync(file.archivePath) &&
      fs.statSync(file.archivePath).isFile(), '原始来源缓存文件缺失');
    const bytes = fs.readFileSync(file.archivePath);
    ensure(bytes.length === file.bytes && digest(bytes) === file.sha256,
      `原始来源缓存内容已改变：${file.origin}`);
  }
}

/** Every access checks current editorial source versions; only immutable candidate material is reused. */
export function rawSourcesForJob(s: State, t: Ticket, j: Job, statePath: string): RawSourceIndex {
  ensure(t.worktree && j.head && j.base && s.planSourceVersion, '原始来源需要候选、worktree 和已批准来源版本');
  const spec = gh.issueSource(s.repo, s.spec), issue = gh.issueSource(s.repo, t.number);
  ensure(spec.body.trim() && issue.body.trim(), 'spec 或工单正文缺失，不能生成空原始资料');
  const specBytes = JSON.stringify(spec, null, 2) + '\n', issueBytes = JSON.stringify(issue, null, 2) + '\n';
  const sourceVersions = { plan: s.planSourceVersion, spec: digest(specBytes), issue: digest(issueBytes) };
  const candidate = { head: j.head, base: j.base };
  const key = digest(JSON.stringify({ repo: s.repo.slug, issue: t.number, candidate, sourceVersions }));
  const directory = path.join(path.dirname(statePath), 'raw-sources', key);
  const manifestPath = path.join(directory, 'manifest.json');
  const expected = { schemaVersion: 1 as const, key, repo: s.repo.slug, issue: t.number, candidate, sourceVersions };
  if (fs.existsSync(manifestPath)) {
    let manifest: RawSourceManifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RawSourceManifest; }
    catch { throw new Error('原始来源缓存清单不可读取或不是 JSON'); }
    verify(manifest, expected, directory);
    return { manifestPath, fingerprint: manifest.fingerprint, cacheHit: true, candidate, sourceVersions, files: manifest.files };
  }

  // Both revisions are immutable Git objects. A missing object is a hard read failure.
  git(t.worktree, 'cat-file', '-e', `${j.base}^{commit}`);
  git(t.worktree, 'cat-file', '-e', `${j.head}^{commit}`);
  const changed = git(t.worktree, 'diff', '--name-only', '-z', j.base, j.head, '--').split('\0').filter(Boolean);
  const diff = git(t.worktree, 'diff', '--binary', '--no-ext-diff', j.base, j.head, '--');
  const history = git(t.worktree, 'log', '--max-count=100', '--format=%H%x09%aI%x09%s', `${j.base}..${j.head}`, '--');
  const standards = git(t.worktree, 'ls-tree', '-r', '-z', '--name-only', j.head).split('\0').filter(Boolean)
    .filter(relative => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(relative))
    .filter(relative => {
      const folder = path.posix.dirname(relative);
      return folder === '.' || changed.some(file => file === folder || file.startsWith(`${folder}/`));
    }).sort();
  const at = new Date().toISOString();
  fs.mkdirSync(directory, { recursive: true });
  const files: RawSourceFile[] = [];
  function archive(kind: RawSourceFile['kind'], origin: string, sourceVersion: string, contents: string) {
    const archivePath = path.join(directory, `${files.length}-${kind}-${digest(origin).slice(0, 12)}.raw`);
    const bytes = Buffer.from(contents), sha256 = digest(bytes);
    if (fs.existsSync(archivePath)) ensure(digest(fs.readFileSync(archivePath)) === sha256,
      `原始来源缓存文件冲突：${origin}`);
    else fs.writeFileSync(archivePath, bytes, { flag: 'wx', mode: 0o444 });
    files.push({ kind, origin, sourceVersion, fetchedAt: at, archivePath, sha256, bytes: bytes.length });
  }
  archive('spec', spec.url, sourceVersions.spec, specBytes);
  archive('issue', issue.url, sourceVersions.issue, issueBytes);
  archive('diff', `git:${s.repo.slug}:${j.base}..${j.head}:diff`, digest(`${j.base}:${j.head}`), diff);
  archive('history', `git:${s.repo.slug}:${j.base}..${j.head}:commits`, digest(`${j.base}:${j.head}`), history);
  for (const relative of standards) archive('standard', `git:${s.repo.slug}:${j.head}:${relative}`,
    j.head, git(t.worktree, 'show', `${j.head}:${relative}`));
  const unsigned = { ...expected, fetchedAt: at, files };
  const manifest: RawSourceManifest = { ...unsigned, fingerprint: fingerprint(unsigned) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  return { manifestPath, fingerprint: manifest.fingerprint, cacheHit: false, candidate, sourceVersions, files };
}
