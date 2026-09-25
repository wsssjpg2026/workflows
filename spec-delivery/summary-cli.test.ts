/**
 * #14：离线只读 `summary <state.json>` 的真 CLI 子进程回归。
 *
 * 全部 fixture 隔离在临时目录：不读写任何真实运行账本、不访问 GitHub、不执行 git。
 * PATH 前置失败式假 `gh`/`git`：被调即记录并以码 99 退出，于是"完全离线"可被证伪。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as e from './core.ts';
import { summarize } from './summary.ts';

const entry = fileURLToPath(new URL('../spec-delivery.workflow.ts', import.meta.url));
// 仅用于填充 fixture 的 head/base 字段（summarize 不读它们）；不用真实候选 SHA，避免写死的基线过期后误导读者。
const FIXTURE_HEAD = 'fixture-head';

const ticket = (number: number, phase: e.Phase): e.Ticket => {
  const t = e.buildTicket({ number, kind: 'software', dependencies: [], criteria: [`#${number}`], visual: false }, FIXTURE_HEAD);
  t.phase = phase; t.head = FIXTURE_HEAD; t.base = FIXTURE_HEAD;
  return t;
};
const job = (id: string, status: e.Job['status'], executor: e.Job['executor'] = 'agent'): e.Job => ({
  id, ticket: '14', epoch: 1, action: 'implement', part: '', tier: 'L3', model: 'm', executor, fresh: false,
  contextKey: `ctx-${id}`, head: FIXTURE_HEAD, base: FIXTURE_HEAD, tests: 0, status, nativeId: '',
});

/** 最小但完整的合法账本；`protocol: undefined` 表示无 protocol 字段的旧账本。 */
function ledger(status: e.State['status'], protocol: 2 | undefined): e.State {
  const state: e.State = {
    schema: 1, protocol, id: 'summary-cli-fixture', revision: 7,
    inputs: { spec: 12, targetBranch: 'codex/test-deepseek-harness', models: { L1: 'large', L2: 'middle', L3: 'small' } },
    spec: 12,
    repo: { root: '/fixture/repo', slug: 'example/test', host: 'github.com', defaultBranch: 'main' },
    status, policy: { agents: 6, issues: 3, tests: 1, noProgress: 4, rounds: 6 },
    specCriteria: ['summary 可离线读取账本'], planEvidence: '/fixture/plan.md',
    tickets: [ticket(13, 'done'), ticket(14, 'human'), ticket(15, 'blocked'), ticket(16, 'claim')],
    jobs: [job('a', 'leased'), job('b', 'running'), job('c', 'leased', 'command'), job('d', 'done'), job('e', 'cancelled')],
    facts: { base: FIXTURE_HEAD, issueStates: { 12: 'OPEN' }, prs: {}, at: '2026-01-01T00:00:00.000Z' },
    auditEpoch: 1, validationOwner: '14',
    events: [{ revision: 7, message: 'fixture', at: '2026-01-01T00:00:00.000Z' }],
  };
  if (protocol === undefined) delete (state as { protocol?: 2 }).protocol;
  return state;
}

interface Fixture { dir: string; call: (...args: string[]) => ReturnType<typeof spawnSync>; statePath: string; ghLog: string }

function setup(name: string, text: string): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `summary-cli-${name}-`));
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, text);
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const ghLog = path.join(dir, 'offline-tool-calls.log');
  for (const tool of ['gh', 'git']) {
    const shim = path.join(bin, tool);
    fs.writeFileSync(shim, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(ghLog)},${JSON.stringify(`${tool} `)}+process.argv.slice(2).join(' ')+'\\n');\nconsole.error('offline fixture forbids ${tool}');\nprocess.exit(99);\n`);
    fs.chmodSync(shim, 0o755);
  }
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const call = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { cwd: dir, env, encoding: 'utf8' });
  return { dir, call, statePath, ghLog };
}

/** 目录内容与字节的稳定指纹：守护"不写状态/history/锁"等不变量。 */
function digest(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const item of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) { parts.push(`${rel}/`); walk(path.join(d, item.name), rel); }
      else parts.push(`${rel}:${createHash('sha256').update(fs.readFileSync(path.join(d, item.name))).digest('hex')}`);
    }
  };
  walk(dir, '');
  return parts.join('\n');
}

const calls = (f: Fixture) => (fs.existsSync(f.ghLog) ? fs.readFileSync(f.ghLog, 'utf8') : '');
const reference = (statePath: string) => summarize(JSON.parse(fs.readFileSync(statePath, 'utf8')) as e.State);

function spawnLiveHolder(): { pid: number; stop: () => void } {
  const child: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(child.pid, '无法启动锁持有者进程');
  return { pid: child.pid, stop: () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } } };
}

test('protocol:2 账本：退出 0、stdout 恰为 summarize 的单个 JSON 对象、零副作用', () => {
  const state = ledger('running', 2);
  const f = setup('running', JSON.stringify(state, null, 2) + '\n');
  try {
    const before = digest(f.dir);
    const r = f.call('summary', f.statePath);
    assert.equal(r.status, 0, `退出码非 0；stderr=${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), reference(f.statePath));
    assert.equal(r.stdout, JSON.stringify(reference(f.statePath), null, 2) + '\n');
    assert.equal(r.stderr, '');
    assert.equal(calls(f), '', 'summary 调用了 gh/git');
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), JSON.stringify(state, null, 2) + '\n', '状态文件被改写');
    assert.equal(digest(f.dir), before, 'fixture 目录出现新增/改动（history、锁、临时文件）');
    assert.equal(fs.existsSync(path.join(f.dir, 'history')), false, 'summary 产生了 history 记录');
    assert.equal(fs.existsSync(f.statePath + '.lock'), false, 'summary 创建了状态锁');
    assert.equal(fs.existsSync(f.statePath + '.lock.recovery'), false, 'summary 创建了锁恢复目录');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('旧账本（无 protocol）与 paused/waiting_human/complete/retired 状态均可读取', () => {
  for (const status of ['paused', 'waiting_human', 'complete', 'retired'] as const) {
    const state = ledger(status, undefined);
    assert.equal('protocol' in state, false, 'fixture 应模拟旧账本');
    const f = setup(status, JSON.stringify(state));
    try {
      const r = f.call('summary', f.statePath);
      assert.equal(r.status, 0, `${status} 退出码非 0；stderr=${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), reference(f.statePath), `${status} 输出与 summarize 不一致`);
      const expected = summarize(state);
      assert.equal(JSON.parse(r.stdout).status, status);
      assert.equal(JSON.parse(r.stdout).spec, expected.spec);
      assert.deepEqual(JSON.parse(r.stdout).tickets, expected.tickets);
      assert.deepEqual(JSON.parse(r.stdout).jobs, expected.jobs);
      assert.equal(JSON.parse(r.stdout).validationOwner, '14');
      assert.equal(calls(f), '', `${status} 调用了 gh/git`);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('不退让他人持有的锁：存活持有者与死进程持有者都原样保留，不等待也不恢复', () => {
  const state = ledger('running', 2);
  // a) 持有者进程真实存活：绝不能接管，也不能等锁超时。
  const live = setup('lock-live', JSON.stringify(state));
  const holder = spawnLiveHolder();
  try {
    const lockDir = live.statePath + '.lock';
    fs.mkdirSync(lockDir);
    const owner = JSON.stringify({ pid: holder.pid, host: os.hostname() });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), owner);
    const before = digest(live.dir);
    const started = Date.now();
    const r = live.call('summary', live.statePath);
    assert.equal(r.status, 0, `存活锁下退出码非 0；stderr=${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), reference(live.statePath));
    assert.ok(Date.now() - started < 10_000, 'summary 在等锁而不是直接只读返回');
    assert.equal(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'), owner, 'owner.json 被改写');
    assert.equal(fs.existsSync(lockDir + '.recovery'), false, '产生了锁恢复目录');
    assert.equal(digest(live.dir), before, '锁目录或状态目录被改动');
  } finally { holder.stop(); fs.rmSync(live.dir, { recursive: true, force: true }); }

  // b) 持有者 pid 必死：不得选举恢复、不得删除锁。
  const dead = setup('lock-dead', JSON.stringify(state));
  try {
    const lockDir = dead.statePath + '.lock';
    fs.mkdirSync(lockDir);
    const owner = JSON.stringify({ pid: 2147483647, host: os.hostname() });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), owner);
    const before = digest(dead.dir);
    const r = dead.call('summary', dead.statePath);
    assert.equal(r.status, 0, `死锁下退出码非 0；stderr=${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), reference(dead.statePath));
    assert.equal(fs.existsSync(lockDir), true, 'summary 删除了他人持有的锁');
    assert.equal(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'), owner);
    assert.equal(fs.existsSync(lockDir + '.recovery'), false, 'summary 参与了锁恢复');
    assert.equal(digest(dead.dir), before);
  } finally { fs.rmSync(dead.dir, { recursive: true, force: true }); }
});

test('缺少 state 参数：非零退出、明确 stderr、stdout 无伪成功', () => {
  const f = setup('noarg', JSON.stringify(ledger('running', 2)));
  try {
    const r = f.call('summary');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /缺少输入文件\/状态路径/);
    assert.equal(r.stdout.trim(), '');
    assert.equal(calls(f), '');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('文件不存在：非零退出、stderr 指明路径、stdout 为空', () => {
  const f = setup('missing', JSON.stringify(ledger('running', 2)));
  try {
    const absent = path.join(f.dir, 'absent.json');
    const r = f.call('summary', absent);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /状态文件不存在/);
    assert.ok(r.stderr.includes(absent), `stderr 未指明缺失路径：${r.stderr}`);
    assert.equal(r.stdout.trim(), '');
    assert.equal(calls(f), '');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('JSON 损坏：非零退出、stderr 说明解析失败、原文件字节不变', () => {
  const broken = '{"schema":1,"tickets":[';
  const f = setup('broken', broken);
  try {
    const r = f.call('summary', f.statePath);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /不是合法 JSON/);
    assert.equal(r.stdout.trim(), '');
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), broken, '损坏文件被改写');
    assert.equal(calls(f), '');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('非 JSON 故障不被误报为 JSON 语法错误：目录、悬空符号链接、不可读文件各有明确 stderr', () => {
  // 目录：不存在 JSON 语法问题，错误必须指出「不是普通文件」。
  const dirFixture = setup('dir', JSON.stringify(ledger('running', 2)));
  const nested = path.join(dirFixture.dir, 'nested');
  try {
    fs.mkdirSync(nested);
    const before = digest(dirFixture.dir);
    const r = dirFixture.call('summary', nested);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim(), '', '目录输入产生伪成功输出');
    assert.match(r.stderr, /状态文件不是普通文件/, `目录输入的错误文案不明确：${r.stderr}`);
    assert.doesNotMatch(r.stderr, /不是合法 JSON/, '目录输入被误报成 JSON 语法错误');
    assert.ok(r.stderr.includes(nested), `stderr 未指明传入路径：${r.stderr}`);
    assert.equal(calls(dirFixture), '');
    assert.equal(digest(dirFixture.dir), before, '目录路径查询改动了 fixture');
  } finally { fs.rmSync(dirFixture.dir, { recursive: true, force: true }); }

  // 悬空符号链接：路径不存在，必须与 JSON 语法错误分开陈述。
  const linkFixture = setup('symlink', JSON.stringify(ledger('running', 2)));
  const dangling = path.join(linkFixture.dir, 'dangling.json');
  try {
    fs.symlinkSync(path.join(linkFixture.dir, 'nowhere.json'), dangling);
    const r = linkFixture.call('summary', dangling);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /状态文件不存在/);
    assert.ok(r.stderr.includes(dangling), `stderr 未指明传入路径：${r.stderr}`);
    assert.doesNotMatch(r.stderr, /不是合法 JSON/);
  } finally { fs.rmSync(linkFixture.dir, { recursive: true, force: true }); }
});

test('不可读文件：权限故障与 JSON 语法故障分开陈述，且无伪成功输出', { skip: process.getuid?.() === 0 }, () => {
  const f = setup('denied', JSON.stringify(ledger('running', 2)));
  const denied = path.join(f.dir, 'denied.json');
  try {
    fs.writeFileSync(denied, JSON.stringify(ledger('running', 2)));
    fs.chmodSync(denied, 0o000);
    const r = f.call('summary', denied);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim(), '', '不可读文件产生伪成功输出');
    assert.match(r.stderr, /状态文件不可读/, `权限故障文案不明确：${r.stderr}`);
    assert.doesNotMatch(r.stderr, /不是合法 JSON/, '权限故障被误报成 JSON 语法错误');
    assert.equal(calls(f), '');
  } finally {
    try { fs.chmodSync(denied, 0o600); } catch { /* 文件可能未创建 */ }
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('父目录不可搜索：按不可读陈述而非不存在，恢复权限后同一路径可读', { skip: process.getuid?.() === 0 }, () => {
  const f = setup('parent-denied', JSON.stringify(ledger('running', 2)));
  const blocked = path.join(f.dir, 'noperm');
  try {
    fs.mkdirSync(blocked);
    const statePath = path.join(blocked, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(ledger('running', 2)));
    const before = digest(f.dir);
    fs.chmodSync(blocked, 0o000);
    const denied = f.call('summary', statePath);
    assert.notEqual(denied.status, 0);
    assert.equal(denied.stdout.trim(), '', '父目录不可搜索却产生伪成功输出');
    assert.match(denied.stderr, /状态文件不可读/, `EACCES 未按不可读陈述：${denied.stderr}`);
    assert.doesNotMatch(denied.stderr, /状态文件不存在/, '一直存在的文件被误报为不存在');
    assert.equal(calls(f), '');
    fs.chmodSync(blocked, 0o700);
    assert.equal(digest(f.dir), before, '失败路径改动了 fixture（锁、history 或临时文件）');
    // 权限恢复后同一路径立即读通：证明文件始终存在且内容合法，前一次失败是访问权限而非缺失。
    const allowed = f.call('summary', statePath);
    assert.equal(allowed.status, 0, `恢复权限后仍失败：${allowed.stderr}`);
    assert.deepEqual(JSON.parse(allowed.stdout), reference(statePath));
    assert.equal(digest(f.dir), before, '读取成功路径改动了 fixture');
  } finally {
    try { fs.chmodSync(blocked, 0o700); } catch { /* 可能未创建 */ }
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('schema:1 但账本形状损坏：非零退出、明确 stderr、无编造摘要', () => {
  const cases: [string, unknown][] = [
    ['tickets-string', { ...ledger('running', 2), tickets: 'xx' }],
    ['jobs-string', { ...ledger('running', 2), jobs: 'yy' }],
    ['tickets-elements', { ...ledger('running', 2), tickets: [1, 2] }],
    ['jobs-elements', { ...ledger('running', 2), jobs: [{ status: 1 }] }],
    ['tickets-missing', (() => { const s = ledger('running', 2) as Record<string, unknown>; delete s.tickets; return s; })()],
    ['jobs-missing', (() => { const s = ledger('running', 2) as Record<string, unknown>; delete s.jobs; return s; })()],
    ['inputs-missing', (() => { const s = ledger('running', 2) as Record<string, unknown>; delete s.inputs; return s; })()],
    ['target-branch-missing', { ...ledger('running', 2), inputs: { spec: 12 } }],
    ['spec-string', { ...ledger('running', 2), spec: '12' }],
  ];
  for (const [name, value] of cases) {
    const f = setup(`shape-${name}`, JSON.stringify(value));
    try {
      const before = digest(f.dir);
      const r = f.call('summary', f.statePath);
      assert.notEqual(r.status, 0, `${name} 应为非零退出，实际却输出：${r.stdout}`);
      assert.match(r.stderr, /状态文件结构不符合 schema 1/, `${name} 错误文案不明确：${r.stderr}`);
      assert.equal(r.stdout.trim(), '', `${name} 产生了编造摘要`);
      assert.equal(calls(f), '', `${name} 调用了 gh/git`);
      assert.equal(digest(f.dir), before, `${name} 在失败路径改动了 fixture`);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('旧账本与退役门禁文案把 summary 与 inspect/metrics 并列', () => {
  // 旧账本（无 protocol）：plan 在 requireProtocol 处被挡。
  const legacy = setup('gate-legacy', JSON.stringify(ledger('running', undefined)));
  try {
    const r = legacy.call('plan', legacy.statePath, path.join(legacy.dir, 'plan.json'));
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /inspect\/metrics\/summary/, `旧账本文案未含 summary：${r.stderr}`);
  } finally { fs.rmSync(legacy.dir, { recursive: true, force: true }); }

  // 退役 + protocol:2：drive 走 requireProtocol 的退役分支，plan 走主流程的退役分支。
  const retired = setup('gate-retired', JSON.stringify(ledger('retired', 2)));
  try {
    const planned = retired.call('plan', retired.statePath, path.join(retired.dir, 'plan.json'));
    assert.notEqual(planned.status, 0);
    assert.equal(planned.stdout.trim(), '');
    assert.match(planned.stderr, /已退役运行只允许 inspect\/metrics\/summary/, `退役主流程文案未含 summary：${planned.stderr}`);

    const driven = retired.call('drive', retired.statePath);
    assert.notEqual(driven.status, 0);
    assert.equal(driven.stdout.trim(), '');
    assert.match(driven.stderr, /运行已退役；只允许 inspect\/metrics\/summary/, `退役 requireProtocol 文案未含 summary：${driven.stderr}`);
  } finally { fs.rmSync(retired.dir, { recursive: true, force: true }); }
});

test('schema 不受支持（schema:2 与缺失 schema）：非零退出且无输出', () => {
  const cases: [string, unknown][] = [
    ['schema2', { ...ledger('running', 2), schema: 2 }],
    ['noschema', (() => { const s = ledger('running', 2) as Record<string, unknown>; delete s.schema; return s; })()],
  ];
  for (const [name, value] of cases) {
    const f = setup(name, JSON.stringify(value));
    try {
      const r = f.call('summary', f.statePath);
      assert.notEqual(r.status, 0, `${name} 退出码应为非 0`);
      assert.match(r.stderr, /不支持的状态版本/);
      assert.equal(r.stdout.trim(), '', `${name} 产生了伪成功输出`);
      assert.equal(calls(f), '');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('既有 history 记录在读取后字节与条目数不变', () => {
  const f = setup('history', JSON.stringify(ledger('complete', 2)));
  try {
    const history = path.join(f.dir, 'history');
    fs.mkdirSync(history);
    const revision = path.join(history, '000006-old.json');
    fs.writeFileSync(revision, JSON.stringify({ revision: 6 }));
    const entries = fs.readdirSync(history).length;
    const before = digest(f.dir);
    const r = f.call('summary', f.statePath);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(revision, 'utf8'), JSON.stringify({ revision: 6 }));
    assert.equal(fs.readdirSync(history).length, entries, 'history 条目数变化');
    assert.equal(digest(f.dir), before, 'history 或状态被改动');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('help 的 commands 列出 summary <state.json>，version 行为不变', () => {
  const f = setup('help', JSON.stringify(ledger('running', 2)));
  try {
    const help = f.call('help');
    assert.equal(help.status, 0, help.stderr);
    const parsed = JSON.parse(help.stdout);
    assert.ok(Array.isArray(parsed.commands), 'help.commands 不是数组');
    assert.ok(parsed.commands.includes('summary <state.json>'), `help.commands 缺少 summary：${help.stdout}`);
    assert.equal(parsed.version, '0.2.0', 'version 号被改动');
    const version = f.call('version');
    assert.equal(version.status, 0, version.stderr);
    assert.equal(JSON.parse(version.stdout).version, parsed.version);
    assert.equal(calls(f), '');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }

  // help/version 在状态文件校验之前返回：旧账本、任意损坏输入下仍保持既有行为。
  const legacy = setup('help-legacy', '{"schema":1,');
  try {
    const help = legacy.call('help');
    assert.equal(help.status, 0, help.stderr);
    assert.ok(JSON.parse(help.stdout).commands.includes('summary <state.json>'));
    const version = legacy.call('version');
    assert.equal(version.status, 0, version.stderr);
    assert.equal(JSON.parse(version.stdout).version, JSON.parse(help.stdout).version);
    assert.equal(calls(legacy), '');
  } finally { fs.rmSync(legacy.dir, { recursive: true, force: true }); }
});

test('同族只读命令 inspect/metrics 对同一 fixture 行为不变，且不写状态', () => {
  const state = ledger('running', 2);
  const f = setup('readonly-peers', JSON.stringify(state, null, 2) + '\n');
  try {
    const before = digest(f.dir);
    const inspect = f.call('inspect', f.statePath);
    assert.equal(inspect.status, 0, `inspect 退出码非 0；stderr=${inspect.stderr}`);
    assert.equal(JSON.parse(inspect.stdout).id, state.id);
    const m = f.call('metrics', f.statePath);
    assert.equal(m.status, 0, `metrics 退出码非 0；stderr=${m.stderr}`);
    const parsed = JSON.parse(m.stdout);
    assert.equal(parsed.run, state.id);
    assert.equal(parsed.jobs, state.jobs.length);
    assert.deepEqual(parsed.byStatus, { leased: 2, running: 1, done: 1, cancelled: 1 });
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), JSON.stringify(state, null, 2) + '\n', 'inspect/metrics 改写了状态文件');
    assert.equal(digest(f.dir), before, 'inspect/metrics 在 fixture 目录留下新增或改动');
    assert.equal(calls(f), '');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
