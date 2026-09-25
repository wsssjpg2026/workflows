/**
 * #14：离线只读 `summary <state.json>` 的真 CLI 子进程回归。
 *
 * 全部 fixture 隔离在临时目录：不读写任何真实运行账本、不访问 GitHub、不执行 git。
 * PATH 前置失败式假 `gh`/`git`：被杀即记录并以码 99 退出，于是"完全离线"可被证伪。
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
const HEAD = '31313c1849a93db1af1b3c537a8e7469374c7c57';

const ticket = (number: number, phase: e.Phase): e.Ticket => {
  const t = e.buildTicket({ number, kind: 'software', dependencies: [], criteria: [`#${number}`], visual: false }, HEAD);
  t.phase = phase; t.head = HEAD; t.base = HEAD;
  return t;
};
const job = (id: string, status: e.Job['status'], executor: e.Job['executor'] = 'agent'): e.Job => ({
  id, ticket: '14', epoch: 1, action: 'implement', part: '', tier: 'L3', model: 'm', executor, fresh: false,
  contextKey: `ctx-${id}`, head: HEAD, base: HEAD, tests: 0, status, nativeId: '',
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
    facts: { base: HEAD, issueStates: { 12: 'OPEN' }, prs: {}, at: '2026-01-01T00:00:00.000Z' },
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
    const version = f.call('version');
    assert.equal(version.status, 0, version.stderr);
    assert.equal(JSON.parse(version.stdout).version, parsed.version);
    assert.equal(calls(f), '');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
