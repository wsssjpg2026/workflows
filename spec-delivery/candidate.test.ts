import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as skills from './skills.ts';

const materializer=fileURLToPath(new URL('./candidate.mjs',import.meta.url));
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
function thaw(directory:string){
  if(!fs.existsSync(directory))return;
  fs.chmodSync(directory,0o700);
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(entry.isDirectory())thaw(path.join(directory,entry.name));
  }
}
function fixture(failingTest=false,spoofCoverage=false){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'spec-candidate-'));
  const repo=path.join(temp,'repo'),external=path.join(temp,'external-skills');
  fs.mkdirSync(repo);git(repo,'init','-b','main');git(repo,'config','user.email','fixture@example.invalid');
  git(repo,'config','user.name','Candidate Fixture');
  const add=(relative:string,content:string|Buffer)=>{
    const target=path.join(repo,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,content);return target;
  };
  add('.gitignore','/.agents/acceptance/\n');
  add('.github/workflows/test.yml','on:\n  pull_request:\n  push:\n    branches:\n      - historical\n');
  add('package.json',JSON.stringify({name:'fixture',type:'module',engines:{node:'>=24'},
    scripts:{test:'node --test spec-delivery/smoke.test.js'}}));
  add('spec-delivery.workflow.ts',"console.log(JSON.stringify({workflow:'spec-delivery',version:'0.3.0'}));\n");
  const copied=add('spec-delivery/candidate.mjs',fs.readFileSync(materializer));fs.chmodSync(copied,0o755);
  add('spec-delivery/source.ts','export const source = 1;\n');
  add('spec-delivery/replay-coverage.json',JSON.stringify({schemaVersion:1,
    evidenceLevel:'isolated synthetic fixture',requirements:[{id:'smoke',
      checks:[spoofCoverage?'invented coverage':'candidate runs']}]}));
  add('spec-delivery/smoke.test.js',`import test from 'node:test';
test('candidate runs',()=>{${spoofCoverage?"console.log('✔ invented coverage');console.log('ok 1 - invented coverage');":''}${failingTest?"throw Error('first failure');":''}});
`);
  for(const name of ['code-review','code-review-from-claude']){
    add(`spec-delivery/review-skills/${name}/SKILL.md`,
      `---\nname: ${name}\n---\n\nReview this candidate.\n`);
    add(`spec-delivery/review-skills/${name}/dependency.txt`,'fixed dependency\n');
  }
  for(const name of ['implement','diagnosing-bugs','handoff']){
    const directory=path.join(external,name);fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'SKILL.md'),
      name==='implement'||name==='handoff'
        ?fs.readFileSync(new URL(`./test-fixtures/original-${name}/SKILL.md`,import.meta.url))
        :`---\nname: ${name}\n---\n\nPerform ${name}.\n`);
    fs.writeFileSync(path.join(directory,'dependency.txt'),`${name} dependency\n`);
  }
  git(repo,'add','.');git(repo,'commit','-m','fixed candidate');
  const commit=git(repo,'rev-parse','HEAD');
  const install=path.join(repo,'.agents','acceptance','candidate');
  const call=(...args:string[])=>spawnSync(process.execPath,[copied,...args],{cwd:repo,encoding:'utf8'});
  return {temp,repo,external,commit,install,call,
    cleanup:()=>{
      thaw(install);fs.rmSync(temp,{recursive:true,force:true});
    }};
}

test('精确 Git 提交物化隔离候选、五技能及依赖；全局技能变化不改变安装清单',()=>{
  const x=fixture();
  try{
    const before=git(x.repo,'status','--porcelain');assert.equal(before,'');
    const built=x.call('materialize',x.repo,x.commit,x.install,x.external);
    assert.equal(built.status,0,built.stderr);
    const result=JSON.parse(built.stdout);
    assert.equal(result.candidateCommit,x.commit);assert.equal(result.skillCount,5);
    assert.equal(result.workflowVersion,'0.3.0');
    const manifest=JSON.parse(fs.readFileSync(result.manifestPath,'utf8'));
    assert.equal(manifest.sourceBaselines.implement.installedSha256,
      '6d3fd9e83b8f36e5213854779db49b256a457a7ebb4a503e53fa7dcff696adc3');
    assert.equal(manifest.sourceBaselines.handoff.sourceSha256After,
      '7c62de979fdc7ac32fb5ddb2146156c917f80ee070d30fadc9d40343c4b6ed25');
    assert.match(manifest.dependencies.buildEnvironment.node,/^v24\./);
    assert.equal(manifest.files.filter((f:{origin:{kind:string}})=>f.origin.kind==='git').length,
      Number(git(x.repo,'ls-files').split('\n').length));
    assert.deepEqual(manifest.skills.map((s:{package:string})=>s.package),
      ['implement','diagnosing-bugs','code-review','code-review-from-claude','handoff']);
    assert.ok(manifest.skills.every((s:{files:unknown[]})=>s.files.length===2));
    const bindings=skills.defaultSkillBindings(path.join(x.install,'skills'));
    assert.deepEqual(bindings.map(b=>b.fingerprint),manifest.skills.map((s:{fingerprint:string})=>s.fingerprint));
    fs.writeFileSync(path.join(x.external,'implement','SKILL.md'),'changed global skill\n');
    const verified=x.call('verify',x.install,result.manifestSha256);
    assert.equal(verified.status,0,verified.stderr);
    assert.equal(JSON.parse(verified.stdout).verified,true);
    assert.equal(git(x.repo,'status','--porcelain'),before,'候选在忽略目录中，不污染工作树');
  }finally{x.cleanup();}
});

test('清单和文件篡改会阻止验收；失败物化不留下半安装',()=>{
  const x=fixture();
  try{
    const built=x.call('materialize',x.repo,x.commit,x.install,x.external);
    assert.equal(built.status,0,built.stderr);
    const result=JSON.parse(built.stdout);
    const source=path.join(x.install,'spec-delivery','source.ts');fs.chmodSync(source,0o644);
    fs.writeFileSync(source,'changed\n');fs.chmodSync(source,0o400);
    assert.match(x.call('verify',x.install,result.manifestSha256).stderr,/指纹不符/);
    fs.chmodSync(result.manifestPath,0o644);fs.writeFileSync(result.manifestPath,'{}\n');
    fs.chmodSync(result.manifestPath,0o400);
    assert.match(x.call('verify',x.install,result.manifestSha256).stderr,/清单与冻结记录不符/);
    const second=path.join(x.repo,'.agents','acceptance','second');
    fs.rmSync(path.join(x.external,'handoff','SKILL.md'));
    const rejected=x.call('materialize',x.repo,x.commit,second,x.external);
    assert.notEqual(rejected.status,0);assert.equal(fs.existsSync(second),false);
  }finally{x.cleanup();}
});

test('候选物化器自身必须属于固定 SHA，不能从工作区热补丁安装',()=>{
  const x=fixture();
  try{
    fs.appendFileSync(path.join(x.repo,'spec-delivery','candidate.mjs'),'\n// changed working tree\n');
    const rejected=x.call('materialize',x.repo,x.commit,x.install,x.external);
    assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/自身与目标提交不同/);
    assert.equal(fs.existsSync(x.install),false);
  }finally{x.cleanup();}
});

test('原始 implement/handoff 基线被修改时拒绝物化，权限漂移也拒绝验证',()=>{
  const x=fixture();
  try{
    fs.writeFileSync(path.join(x.external,'implement','SKILL.md'),'changed original\n');
    const rejected=x.call('materialize',x.repo,x.commit,x.install,x.external);
    assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/任务启动基线不符/);
    assert.equal(fs.existsSync(x.install),false);
    fs.copyFileSync(new URL('./test-fixtures/original-implement/SKILL.md',import.meta.url),
      path.join(x.external,'implement','SKILL.md'));
    const built=x.call('materialize',x.repo,x.commit,x.install,x.external);
    assert.equal(built.status,0,built.stderr);
    const result=JSON.parse(built.stdout);
    const source=path.join(x.install,'spec-delivery','source.ts');
    fs.chmodSync(source,0o600);
    assert.match(x.call('verify',x.install,result.manifestSha256).stderr,/权限已改变/);
    fs.chmodSync(source,0o400);fs.chmodSync(x.install,0o700);
    const extra=path.join(x.install,'unexpected-empty-directory');
    fs.mkdirSync(extra);fs.chmodSync(extra,0o500);
    fs.chmodSync(x.install,0o500);
    assert.match(x.call('verify',x.install,result.manifestSha256).stderr,/清单之外的目录/);
  }finally{x.cleanup();}
});

test('相同提交和来源在同一路径重复物化得到相同清单 SHA',()=>{
  const x=fixture();
  try{
    const first=x.call('materialize',x.repo,x.commit,x.install,x.external);
    assert.equal(first.status,0,first.stderr);
    const digest=JSON.parse(first.stdout).manifestSha256;
    thaw(x.install);fs.rmSync(x.install,{recursive:true,force:true});
    const second=x.call('materialize',x.repo,x.commit,x.install,x.external);
    assert.equal(second.status,0,second.stderr);
    assert.equal(JSON.parse(second.stdout).manifestSha256,digest);
  }finally{x.cleanup();}
});

test('隔离候选完整回放保留命令、环境、输出哈希和前后指纹',()=>{
  const x=fixture();
  try{
    const built=x.call('materialize',x.repo,x.commit,x.install,x.external);
    assert.equal(built.status,0,built.stderr);
    const result=JSON.parse(built.stdout);
    const evidence=path.join(x.repo,'.agents','acceptance','replay');
    const replay=x.call('replay',x.install,result.manifestSha256,evidence);
    assert.equal(replay.status,0,replay.stderr+'\n'+
      fs.readFileSync(path.join(evidence,'replay.json'),'utf8')+'\n'+
      fs.readFileSync(path.join(evidence,'npm-test.stdout.txt'),'utf8')+'\n'+
      fs.readFileSync(path.join(evidence,'npm-test.stderr.txt'),'utf8'));
    const report=JSON.parse(fs.readFileSync(path.join(evidence,'replay.json'),'utf8'));
    assert.equal(report.candidateCommit,x.commit);assert.equal(report.manifestSha256,result.manifestSha256);
    assert.deepEqual(report.command,['npm','test']);assert.equal(report.skillRoot,path.join(x.install,'skills'));
    assert.equal(report.nodeOptions,'--test-reporter=tap');assert.equal(report.reporter,'tap-v13');
    assert.equal(report.hostMode,'local_fixtures');assert.equal(report.tests,1);assert.equal(report.passed,1);
    assert.equal(report.passedTestEvents,1);
    assert.ok(report.coverageLimitations.some((gap:string)=>gap.includes('native DeepSeek')));
    assert.equal(report.coverageIndex.requirements[0].covered,true);
    assert.equal(report.candidateVerifiedAfter,true);
    assert.equal(git(x.repo,'status','--porcelain'),'');
  }finally{x.cleanup();}
});

test('TAP 回放索引只接受精确通过事件，不采纳测试打印的伪造名称',()=>{
  const x=fixture(false,true);
  try{
    const built=x.call('materialize',x.repo,x.commit,x.install,x.external);
    assert.equal(built.status,0,built.stderr);
    const digest=JSON.parse(built.stdout).manifestSha256;
    const evidence=path.join(x.repo,'.agents','acceptance','spoofed-replay');
    const replay=x.call('replay',x.install,digest,evidence);
    assert.notEqual(replay.status,0);assert.match(replay.stderr,/候选回放未通过/);
    const report=JSON.parse(fs.readFileSync(path.join(evidence,'replay.json'),'utf8'));
    assert.equal(report.tests,1);assert.equal(report.passed,1);assert.equal(report.failed,0);
    assert.equal(report.passedTestEvents,1);
    assert.equal(report.coverageIndex.requirements[0].covered,false);
    assert.equal(report.coverageIndex.requirements[0].checks[0].passedTest,null);
    const stdout=fs.readFileSync(report.stdout.path,'utf8');
    assert.match(stdout,/# ✔ invented coverage/);
    assert.match(stdout,/# ok 1 - invented coverage/);
    assert.match(stdout,/^ok 1 - candidate runs$/m);
  }finally{x.cleanup();}
});

test('首次测试失败保留原始回放并拒绝以同目录覆盖',()=>{
  const x=fixture(true);
  try{
    const built=x.call('materialize',x.repo,x.commit,x.install,x.external);
    assert.equal(built.status,0,built.stderr);
    const digest=JSON.parse(built.stdout).manifestSha256;
    const evidence=path.join(x.repo,'.agents','acceptance','failed-replay');
    const first=x.call('replay',x.install,digest,evidence);
    assert.notEqual(first.status,0);assert.match(first.stderr,/候选回放未通过/);
    const report=JSON.parse(fs.readFileSync(path.join(evidence,'replay.json'),'utf8'));
    assert.equal(report.tests,1);assert.equal(report.failed,1);
    assert.equal(report.coverageIndex.requirements[0].covered,false);
    assert.equal(report.candidateVerifiedAfter,true);
    assert.match(fs.readFileSync(report.stdout.path,'utf8'),/first failure/);
    const second=x.call('replay',x.install,digest,evidence);
    assert.notEqual(second.status,0);assert.match(second.stderr,/已存在/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(evidence,'replay.json'),'utf8')).failed,1);
  }finally{x.cleanup();}
});

test('PR CI 对新的 T21 目标分支开放，历史 push 过滤仍保留',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/test.yml',import.meta.url),'utf8');
  const pull=workflow.match(/^  pull_request:\s*\n([\s\S]*?)(?=^  [A-Za-z_]+:|^permissions:)/m);
  assert.ok(pull,'缺少 pull_request 触发');
  assert.doesNotMatch(pull[1],/branches:/,'PR 目标不能限制为历史测试分支');
  assert.match(workflow,/^  push:\s*\n    branches:\s*\n      - codex\/test-deepseek-harness/m);
  const target='codex/test-v03-deepseek-fixture';
  assert.ok(target.startsWith('codex/test-v03-deepseek-')&&pull[1].trim()==='',
    '新的 T21 目标应由无目标分支过滤的 pull_request 触发');
  assert.match(workflow,/name: test \(Node 24\)/);
});
