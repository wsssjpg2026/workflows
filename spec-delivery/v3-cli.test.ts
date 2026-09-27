import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../spec-delivery.workflow.ts', import.meta.url));
const git = (cwd: string, ...argv: string[]) => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inputs = { spec: 100, targetBranch: 'main', models: { L1: 'large', L2: 'middle', L3: 'small' } };

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-v3-cli-'));
  const root = path.join(temp, 'repo'), bare = path.join(temp, 'origin.git');
  fs.mkdirSync(root); git(temp, 'init', '--bare', bare); git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Workflow Test');
  fs.writeFileSync(path.join(root, 'source.txt'), 'base\n'); git(root, 'add', 'source.txt'); git(root, 'commit', '-m', 'base');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'remote', 'add', 'origin', bare); git(root, 'remote', 'set-url', '--push', 'origin', 'https://github.com/example/test.git');
  git(root, 'push', bare, 'main');
  const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
  const ghLog = path.join(temp, 'gh.log');
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs=require('fs'),a=process.argv.slice(2),endpoint=a.at(-1);
fs.appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(a)+'\\n');
const issue=n=>({number:n,title:n===100?'Spec':'Task',body:'Delivery',html_url:'https://github.com/example/test/issues/'+n,state:'open',assignees:[]});
if(a[0]==='repo'&&a[1]==='view') console.log(JSON.stringify({nameWithOwner:'example/test',url:'https://github.com/example/test',defaultBranchRef:{name:'main'}}));
else if(a.includes('graphql')) console.log(JSON.stringify({data:{repository:{target:{target:{oid:${JSON.stringify(head)}}},i100:{number:100,state:'OPEN'},i101:{number:101,state:'OPEN'}}}}));
else if(a[0]==='issue'&&a[1]==='comment') console.log('https://github.com/example/test/issues/101#issuecomment-1');
else if(endpoint.endsWith('/git/ref/heads/main')) console.log(JSON.stringify({ref:'refs/heads/main',object:{type:'commit',sha:${JSON.stringify(head)}}}));
else if(endpoint.endsWith('/issues/100/sub_issues?per_page=100')) console.log(JSON.stringify([[issue(101)]]));
else if(endpoint.endsWith('/issues/101/sub_issues?per_page=100')) console.log('[[]]');
else if(endpoint.includes('/blocked_by?')||endpoint.includes('/comments?')) console.log('[[]]');
else if(endpoint.endsWith('/issues/100')) console.log(JSON.stringify(issue(100)));
else if(endpoint.endsWith('/issues/101')) console.log(JSON.stringify(issue(101)));
else { console.error('unexpected gh '+a.join(' ')); process.exit(2); }
`);
  fs.chmodSync(gh, 0o755);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const call = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { cwd: root, env, encoding: 'utf8' });
  const inputPath = path.join(temp, 'input.json'); fs.writeFileSync(inputPath, JSON.stringify(inputs));
  const planEvidence = path.join(temp, 'plan-evidence.md'); fs.writeFileSync(planEvidence, 'L1 plan evidence\n');
  const planPath = path.join(temp, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    capabilities: { framework: 'test', mainModel: 'large', modelRouting: 'per_agent', models: ['large', 'middle', 'small'] },
    policy: { agents: 4, issues: 1, tests: 1, noProgress: 2, rounds: 3 },
    tickets: [{ number: 101, kind: 'software', dependencies: [], criteria: ['delivered'], visual: false }],
    specCriteria: ['delivered'], evidencePath: planEvidence,
  }));
  return { temp, root, head, call, inputPath, planPath, planEvidence, ghLog };
}

test('v3 公开 CLI 从五项输入初始化、规划、认领并登记一次 agent 结果', () => {
  const x = fixture();
  try {
    const started = x.call('init', x.inputPath); assert.equal(started.status, 0, started.stderr);
    const statePath = JSON.parse(started.stdout).statePath as string;
    const initial = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(initial.protocol, 3);
    assert.deepEqual(initial.v3, { executionPath: 'legacy-v02', decisionRecords: [], skillInvocations: [], dispatchRecords: [] });
    assert.deepEqual(Object.keys(initial.inputs).sort(), ['models', 'spec', 'targetBranch']);
    assert.equal(initial.repo.root, x.root);
    assert.equal(initial.facts.base, x.head);
    assert.equal(x.call('plan', statePath, x.planPath).status, 0);
    const driven = x.call('drive', statePath); assert.equal(driven.status, 0, driven.stderr);
    const progressed = JSON.parse(driven.stdout);
    assert.equal(progressed.completed.length, 1, 'drive 应执行真实认领命令');
    const planning = progressed.jobs.find((j: {action:string}) => j.action === 'plan');
    assert.ok(planning?.packetPath);
    const afterClaim = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(afterClaim.tickets[0].phase, 'plan');
    assert.equal(git(afterClaim.tickets[0].worktree, 'rev-parse', 'HEAD'), x.head);
    const binding = path.join(x.temp, 'binding.json'); fs.writeFileSync(binding, JSON.stringify({ nativeId: 'real-host-plan-1', model: 'large' }));
    assert.equal(x.call('bind', statePath, planning.id, binding).status, 0);
    const checks = path.join(x.temp, 'checks.md'); fs.writeFileSync(checks, 'test command\n');
    const receipt = { complete: true, status: 'planned', evidencePath: x.planEvidence,
      data: { planPath: x.planPath, checksPath: checks } };
    const staged = x.call('stage', statePath, planning.id, JSON.stringify(receipt)); assert.equal(staged.status, 0, staged.stderr);
    const inspected = x.call('inspect', statePath); assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).tickets[0].phase, 'plan_check');
    const summary = x.call('summary', statePath); assert.equal(summary.status, 0, summary.stderr);
    assert.equal(JSON.parse(summary.stdout).schemaVersion, 1);
    assert.equal(JSON.parse(summary.stdout).tickets.pending, 1);
    assert.equal(x.call('metrics', statePath).status, 0);
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});

test('旧协议保持只读，暂停迁移有原账本备份且不会自动恢复；退役与未知协议拒绝推进', () => {
  const x = fixture();
  try {
    const init = x.call('init', x.inputPath); assert.equal(init.status, 0, init.stderr);
    const statePath = JSON.parse(init.stdout).statePath as string;
    const old = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    old.protocol = 2; delete old.v3; old.status = 'paused';
    const oldBytes = JSON.stringify(old); fs.writeFileSync(statePath, oldBytes);
    const again = x.call('init', x.inputPath); assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).migrationRequired, true);
    assert.equal(fs.readFileSync(statePath, 'utf8'), oldBytes, 'init 不应静默迁移旧账本');
    for (const op of ['summary', 'inspect', 'metrics']) assert.equal(x.call(op, statePath).status, 0, op);
    const denied = x.call('next', statePath); assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /upgrade.*协议 3/);
    const proof = path.join(x.temp, 'migration.json');
    fs.writeFileSync(proof, JSON.stringify({ evidencePath: x.planEvidence }));
    const migrated = x.call('upgrade', statePath, proof); assert.equal(migrated.status, 0, migrated.stderr);
    const result = JSON.parse(migrated.stdout);
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), oldBytes);
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(saved.protocol, 3); assert.equal(saved.status, 'paused');
    assert.equal(x.call('next', statePath).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).status, 'paused');
    saved.status = 'retired'; fs.writeFileSync(statePath, JSON.stringify(saved));
    assert.notEqual(x.call('init', x.inputPath).status, 0);
    assert.notEqual(x.call('upgrade', statePath, proof).status, 0);
    assert.notEqual(x.call('drive', statePath).status, 0);
    for (const op of ['summary', 'inspect', 'metrics']) assert.equal(x.call(op, statePath).status, 0, op);
    saved.protocol = 99; fs.writeFileSync(statePath, JSON.stringify(saved));
    for (const op of ['summary', 'inspect', 'next']) {
      const unsupported = x.call(op, statePath); assert.notEqual(unsupported.status, 0, op);
      assert.match(unsupported.stderr, /不支持的运行协议/);
    }
  } finally { fs.rmSync(x.temp, { recursive: true, force: true }); }
});
