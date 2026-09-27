#!/usr/bin/env node
/** Materialize and verify one read-only candidate from an exact Git commit. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const self=fileURLToPath(import.meta.url);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ensure=(condition,message)=>{if(!condition)throw Error(message);};
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{maxBuffer:64*1024*1024,
  stdio:['ignore','pipe','pipe']});
const safeRelative=relative=>{
  ensure(typeof relative==='string'&&relative&&!path.isAbsolute(relative)&&
    !relative.split('/').some(part=>!part||part==='.'||part==='..')&&
    !relative.includes('\\')&&!relative.includes('\0'),'候选含不安全的相对路径');
  return relative;
};
const packageNames={implementation:'implement',diagnosis:'diagnosing-bugs',
  authorReview:'code-review',prReview:'code-review-from-claude',handoff:'handoff'};
const externalPackages=new Set(['implement','diagnosing-bugs','handoff']);
const originalSkillBaselines={
  implement:'6d3fd9e83b8f36e5213854779db49b256a457a7ebb4a503e53fa7dcff696adc3',
  handoff:'7c62de979fdc7ac32fb5ddb2146156c917f80ee070d30fadc9d40343c4b6ed25',
};

function tracked(repo,commit){
  const raw=git(repo,'ls-tree','-r','-z','--full-tree',commit);
  return raw.toString('utf8').split('\0').filter(Boolean).map(row=>{
    const tab=row.indexOf('\t');ensure(tab>0,'Git tree 条目格式无效');
    const [mode,type,oid]=row.slice(0,tab).split(' '),relative=safeRelative(row.slice(tab+1));
    ensure(type==='blob'&&['100644','100755'].includes(mode)&&/^[0-9a-f]{40,64}$/.test(oid),
      `候选包含不能独立物化的 Git 条目：${relative}`);
    return {relative,mode,oid};
  });
}
function writeFile(install,relative,bytes,mode,origin,files){
  safeRelative(relative);
  const destination=path.join(install,relative);
  fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
  // Exact owner-only modes make the snapshot independent of the caller's umask.
  fs.writeFileSync(destination,bytes,{flag:'wx',mode:0o600});
  fs.chmodSync(destination,mode==='100755'?0o500:0o400);
  files.push({path:relative,sha256:sha(bytes),bytes:bytes.length,mode,origin});
}
function visitDirectories(directory,action){
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(entry.isDirectory())visitDirectories(path.join(directory,entry.name),action);
  }
  action(directory);
}
function toolVersion(command,args){
  const result=spawnSync(command,args,{encoding:'utf8',timeout:10000});
  return result.status===0?(result.stdout||result.stderr).trim().split('\n')[0]:null;
}
function packageContents(directory){
  ensure(fs.statSync(directory).isDirectory(),`技能包目录不可读取：${directory}`);
  const found=[];let total=0;
  function walk(current,prefix=''){
    for(const entry of fs.readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.name==='.git')continue;
      const relative=prefix?`${prefix}/${entry.name}`:entry.name;
      safeRelative(relative);
      ensure(!entry.isSymbolicLink(),`技能依赖不能是符号链接：${relative}`);
      if(entry.isDirectory()){walk(path.join(current,entry.name),relative);continue;}
      ensure(entry.isFile(),`技能依赖不是普通文件：${relative}`);
      const bytes=fs.readFileSync(path.join(current,entry.name));total+=bytes.length;
      ensure(found.length<128&&total<=8*1024*1024,'技能包超过固定来源上限');
      found.push({relative,bytes,mode:fs.statSync(path.join(current,entry.name)).mode&0o111?'100755':'100644'});
    }
  }
  walk(directory);
  ensure(found.some(file=>file.relative==='SKILL.md'),'技能包缺少 SKILL.md');
  return found.sort((a,b)=>a.relative.localeCompare(b.relative));
}
function skillFingerprint(sourcePath,files){
  const source=fs.readFileSync(sourcePath,'utf8');
  const header=source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  ensure(header&&source.slice(header[0].length).trim(),'技能缺少有效 frontmatter 或正文');
  const name=header[1].match(/^name:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]?.trim();
  ensure(name,'技能缺少 name');
  return {name,fingerprint:sha(JSON.stringify({sourcePath,name,
    files:files.map(file=>[file.relativePath,file.sha256])}))};
}
function materialize(repoInput,commit,installInput,skillRootInput){
  ensure(path.isAbsolute(repoInput)&&path.isAbsolute(installInput)&&path.isAbsolute(skillRootInput),
    '仓库、安装和外部技能来源必须为绝对路径');
  ensure(/^[0-9a-f]{40,64}$/.test(commit),'候选必须是完整提交 SHA');
  const repo=fs.realpathSync(repoInput),skillRoot=fs.realpathSync(skillRootInput);
  const resolved=git(repo,'rev-parse','--verify',`${commit}^{commit}`).toString('utf8').trim();
  ensure(resolved===commit,'候选 SHA 不是确切的提交');
  ensure(fs.realpathSync(git(repo,'rev-parse','--show-toplevel').toString('utf8').trim())===repo,
    '仓库路径必须是工作树根');
  ensure(path.relative(repo,self)==='spec-delivery/candidate.mjs',
    '物化器须从目标仓库工作树运行');
  const entries=tracked(repo,commit),script=entries.find(x=>x.relative==='spec-delivery/candidate.mjs');
  ensure(script&&git(repo,'cat-file','blob',script.oid).equals(fs.readFileSync(self)),
    '物化器自身与目标提交不同；先从固定提交运行');
  ensure(entries.some(x=>x.relative==='spec-delivery.workflow.ts')&&
    entries.some(x=>x.relative==='package.json')&&
    entries.some(x=>x.relative==='spec-delivery/replay-coverage.json')&&
    entries.some(x=>x.relative==='.github/workflows/test.yml'),
    '候选缺少入口、依赖、回放覆盖索引或 CI 配置');
  const requestedInstall=path.resolve(installInput);
  ensure(!fs.existsSync(requestedInstall),'安装目录已存在，不能覆盖候选');
  fs.mkdirSync(path.dirname(requestedInstall),{recursive:true,mode:0o700});
  const install=path.join(fs.realpathSync(path.dirname(requestedInstall)),path.basename(requestedInstall));
  ensure(!fs.existsSync(install),'安装目录已存在，不能覆盖候选');
  fs.mkdirSync(install,{mode:0o700});
  const files=[];
  try{
    const sourceBaselines={};
    for(const [name,expectedSha256] of Object.entries(originalSkillBaselines)){
      const source=path.join(skillRoot,name,'SKILL.md');
      const sourceSha256Before=sha(fs.readFileSync(source));
      ensure(sourceSha256Before===expectedSha256,`原始 ${name}/SKILL.md 与任务启动基线不符`);
      sourceBaselines[name]={expectedSha256,sourceSha256Before};
    }
    for(const entry of entries)writeFile(install,entry.relative,git(repo,'cat-file','blob',entry.oid),
      entry.mode,{kind:'git',object:entry.oid},files);
    const skills=[];
    for(const [capability,packageName] of Object.entries(packageNames)){
      const external=externalPackages.has(packageName);
      const sourceDirectory=external?path.join(skillRoot,packageName):
        path.join(install,'spec-delivery','review-skills',packageName);
      const contents=packageContents(sourceDirectory),copied=[];
      for(const file of contents){
        const relative=`skills/${packageName}/${file.relative}`;
        writeFile(install,relative,file.bytes,file.mode,
          {kind:external?'external-skill':'git-skill',source:external?path.join(sourceDirectory,file.relative):
            `spec-delivery/review-skills/${packageName}/${file.relative}`},files);
        copied.push({relativePath:file.relative,sha256:sha(file.bytes),bytes:file.bytes.length});
      }
      // A mutable global package changing during copy must not silently become a mixed version.
      if(external){
        const after=packageContents(sourceDirectory);
        ensure(JSON.stringify(after.map(x=>[x.relative,sha(x.bytes)]))===
          JSON.stringify(contents.map(x=>[x.relative,sha(x.bytes)])),
          `外部技能来源在复制期间变化：${packageName}`);
      }
      const sourcePath=path.join(install,'skills',packageName,'SKILL.md');
      const identity=skillFingerprint(sourcePath,copied);
      skills.push({capability,package:packageName,source:external?sourceDirectory:
        `git:${commit}:spec-delivery/review-skills/${packageName}`,
        sourcePath,files:copied,...identity});
    }
    for(const [name,baseline] of Object.entries(sourceBaselines)){
      baseline.sourceSha256After=sha(fs.readFileSync(path.join(skillRoot,name,'SKILL.md')));
      baseline.installedSha256=sha(fs.readFileSync(path.join(install,'skills',name,'SKILL.md')));
      ensure(baseline.sourceSha256After===baseline.expectedSha256&&
        baseline.installedSha256===baseline.expectedSha256,
        `原始 ${name}/SKILL.md 在候选物化期间变化`);
    }
    const entry=path.join(install,'spec-delivery.workflow.ts');
    const version=spawnSync(process.execPath,[entry,'version'],{encoding:'utf8',timeout:10000});
    ensure(version.status===0,'候选入口不能报告版本');
    const workflowVersion=JSON.parse(version.stdout);
    ensure(workflowVersion?.workflow==='spec-delivery'&&workflowVersion.version,
      '候选入口版本响应无效');
    const packageJson=JSON.parse(fs.readFileSync(path.join(install,'package.json'),'utf8'));
    const manifest={schemaVersion:1,candidateCommit:commit,workflowVersion:workflowVersion.version,
      sourceCommitTime:git(repo,'show','-s','--format=%cI',commit).toString('utf8').trim(),
      entry:'spec-delivery.workflow.ts',skillRoot:'skills',
      dependencies:{node:packageJson.engines?.node||null,packageJson:'package.json',
        npmDependencies:packageJson.dependencies||{},npmDevDependencies:packageJson.devDependencies||{},
        externalTools:['git','gh','host adapter (selected at run time)'],
        buildEnvironment:{node:process.version,git:toolVersion('git',['--version']),
          npm:toolVersion('npm',['--version']),gh:toolVersion('gh',['--version'])}},
      files:files.sort((a,b)=>a.path.localeCompare(b.path)),skills,sourceBaselines};
    const manifestPath=path.join(install,'candidate-manifest.json');
    fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    fs.chmodSync(manifestPath,0o400);
    const manifestSha256=sha(fs.readFileSync(manifestPath));
    visitDirectories(install,directory=>fs.chmodSync(directory,0o500));
    return {installPath:install,manifestPath,manifestSha256,candidateCommit:commit,
      workflowVersion:workflowVersion.version,fileCount:files.length,skillCount:skills.length,
      materializedAt:new Date().toISOString()};
  }catch(error){
    visitDirectories(install,directory=>fs.chmodSync(directory,0o700));
    fs.rmSync(install,{recursive:true,force:true});throw error;
  }
}
function verify(installInput,expectedSha){
  ensure(path.isAbsolute(installInput)&&/^[0-9a-f]{64}$/.test(expectedSha),
    '验证需要绝对安装路径和外部记录的清单 SHA-256');
  const install=fs.realpathSync(installInput),manifestPath=path.join(install,'candidate-manifest.json');
  ensure((fs.statSync(install).mode&0o777)===0o500,'候选安装目录权限已改变');
  ensure((fs.lstatSync(manifestPath).mode&0o777)===0o400,'候选清单权限已改变');
  const bytes=fs.readFileSync(manifestPath);
  ensure(sha(bytes)===expectedSha,'候选清单与冻结记录不符');
  const manifest=JSON.parse(bytes.toString('utf8'));
  ensure(manifest.schemaVersion===1&&/^[0-9a-f]{40,64}$/.test(manifest.candidateCommit)&&
    Array.isArray(manifest.files)&&Array.isArray(manifest.skills)&&manifest.skills.length===5,
    '候选清单格式不完整');
  for(const [name,expectedSha256] of Object.entries(originalSkillBaselines)){
    const record=manifest.sourceBaselines?.[name];
    ensure(record?.expectedSha256===expectedSha256&&
      record.sourceSha256Before===expectedSha256&&record.sourceSha256After===expectedSha256&&
      record.installedSha256===expectedSha256&&
      sha(fs.readFileSync(path.join(install,'skills',name,'SKILL.md')))===expectedSha256,
      `原始 ${name}/SKILL.md 基线不符`);
  }
  const seen=new Set();
  const expectedDirectories=new Set(['']);
  for(const file of manifest.files){
    safeRelative(file.path);ensure(!seen.has(file.path),'候选清单有重复文件');seen.add(file.path);
    const parts=file.path.split('/');
    for(let n=1;n<parts.length;n++)expectedDirectories.add(parts.slice(0,n).join('/'));
    const target=path.join(install,file.path),stat=fs.lstatSync(target);
    ensure(stat.isFile()&&!stat.isSymbolicLink(),'候选文件不是普通文件');
    ensure((stat.mode&0o777)===(file.mode==='100755'?0o500:0o400),
      `候选文件权限已改变：${file.path}`);
    const actual=fs.readFileSync(target);
    ensure(actual.length===file.bytes&&sha(actual)===file.sha256,`候选文件指纹不符：${file.path}`);
    if(file.origin?.kind==='git'){
      const object=createHash(file.origin.object.length===64?'sha256':'sha1')
        .update(`blob ${actual.length}\0`).update(actual).digest('hex');
      ensure(object===file.origin.object,`候选 Git 对象不符：${file.path}`);
    }
  }
  const actualFiles=[],actualDirectories=[];
  function walk(directory,prefix=''){
    const stat=fs.lstatSync(directory);
    ensure(stat.isDirectory()&&!stat.isSymbolicLink()&&
      (stat.mode&0o777)===0o500,`候选目录权限已改变：${prefix||'.'}`);
    actualDirectories.push(prefix);
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const relative=prefix?`${prefix}/${entry.name}`:entry.name;
      if(entry.isDirectory())walk(path.join(directory,entry.name),relative);
      else actualFiles.push(relative);
    }
  }
  walk(install);
  ensure(actualFiles.length===manifest.files.length+1&&
    actualFiles.every(file=>file==='candidate-manifest.json'||seen.has(file)),
    '候选安装包含清单之外的文件');
  ensure(actualDirectories.length===expectedDirectories.size&&
    actualDirectories.every(directory=>expectedDirectories.has(directory)),
    '候选安装包含清单之外的目录');
  for(const skill of manifest.skills){
    ensure(packageNames[skill.capability]===skill.package,'候选技能能力与包不匹配');
    const sourcePath=path.join(install,'skills',skill.package,'SKILL.md');
    ensure(skill.sourcePath===sourcePath,'候选技能路径与安装目录不符');
    const prefix=`skills/${skill.package}/`;
    const declared=skill.files.map(file=>[file.relativePath,file.sha256]).sort((a,b)=>a[0].localeCompare(b[0]));
    const installed=manifest.files.filter(file=>file.path.startsWith(prefix)).map(file=>
      [file.path.slice(prefix.length),file.sha256]).sort((a,b)=>a[0].localeCompare(b[0]));
    ensure(JSON.stringify(declared)===JSON.stringify(installed),
      `候选技能依赖清单不完整：${skill.capability}`);
    const identity=skillFingerprint(sourcePath,skill.files);
    ensure(identity.name===skill.name&&identity.fingerprint===skill.fingerprint,
      `候选技能包指纹不符：${skill.capability}`);
  }
  return {installPath:install,manifestPath,manifestSha256:expectedSha,
    candidateCommit:manifest.candidateCommit,workflowVersion:manifest.workflowVersion,
    fileCount:manifest.files.length,skillCount:manifest.skills.length,verified:true};
}
function replay(installInput,expectedSha,outputInput){
  ensure(path.isAbsolute(outputInput),'回放证据目录必须是绝对路径');
  const before=verify(installInput,expectedSha),output=path.resolve(outputInput);
  ensure(!fs.existsSync(output),'回放证据目录已存在，不能覆盖旧结果');
  ensure(!output.startsWith(before.installPath+path.sep),'回放证据不能写入只读候选');
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  fs.chmodSync(output,0o700);
  const env={...process.env,SPEC_DELIVERY_SKILL_ROOT:path.join(before.installPath,'skills')};
  for(const key of ['SPEC_DELIVERY_HOST_ADAPTER','SPEC_DELIVERY_HOST_OBSERVER',
    'SPEC_DELIVERY_MAIN_OBSERVER','SPEC_DELIVERY_SKILL_OBSERVER',
    'SPEC_DELIVERY_MIGRATION_OBSERVER',
    'NODE_TEST_CONTEXT'])delete env[key];
  // npm test remains the tested command. Node's TAP reporter prefixes console
  // output with "#", so only runner result records can satisfy the index.
  env.NODE_OPTIONS='--test-reporter=tap';
  const startedAt=new Date().toISOString(),start=Date.now();
  const testRun=spawnSync('npm',['test'],{cwd:before.installPath,env,encoding:'utf8',
    timeout:15*60*1000,maxBuffer:64*1024*1024});
  const stdoutPath=path.join(output,'npm-test.stdout.txt'),stderrPath=path.join(output,'npm-test.stderr.txt');
  fs.writeFileSync(stdoutPath,testRun.stdout||'',{mode:0o600});
  fs.writeFileSync(stderrPath,testRun.stderr||'',{mode:0o600});
  const coveragePath=path.join(before.installPath,'spec-delivery','replay-coverage.json');
  const coverageIndex=JSON.parse(fs.readFileSync(coveragePath,'utf8'));
  ensure(coverageIndex.schemaVersion===1&&Array.isArray(coverageIndex.requirements)&&
    coverageIndex.requirements.length>0,'候选回放覆盖索引无效');
  const stdoutText=testRun.stdout||'',lines=stdoutText.split('\n');
  const tapVersion=lines.includes('TAP version 13');
  const passedNames=lines.map(line=>line.match(/^ok [1-9]\d* - (.+)$/)?.[1])
    .filter(name=>name&&!/ # (?:SKIP|TODO)(?:\s|$)/.test(name));
  const tapCount=label=>Number(lines.find(line=>line.startsWith(`# ${label} `))?.slice(label.length+3)||0);
  const coverage=coverageIndex.requirements.map(requirement=>{
    ensure(typeof requirement.id==='string'&&Array.isArray(requirement.checks)&&
      requirement.checks.length>0,'候选回放覆盖要求无效');
    const checks=requirement.checks.map(fragment=>{
      ensure(typeof fragment==='string'&&fragment.trim(),'候选回放测试名称无效');
      return {testName:fragment,passedTest:passedNames.includes(fragment)?fragment:null};
    });
    return {id:requirement.id,checks,covered:checks.every(check=>check.passedTest)};
  });
  let afterVerified=false,afterError=null;
  try{verify(before.installPath,expectedSha);afterVerified=true;}
  catch(error){afterError=error.message;}
  const summary={schemaVersion:1,candidateCommit:before.candidateCommit,
    manifestSha256:expectedSha,workflowVersion:before.workflowVersion,
    command:['npm','test'],nodeOptions:env.NODE_OPTIONS,reporter:'tap-v13',
    cwd:before.installPath,skillRoot:env.SPEC_DELIVERY_SKILL_ROOT,
    hostMode:'local_fixtures',coverageLimitations:[
      'No full native DeepSeek/Codex/ZCode software round',
      'Single-ledger v3 replay delivers issue 101; parallel 102 remains active and dependent 103 remains blocked',
      'Single-ledger fixture does not close the parent spec',
      'No live GitHub multi-PR delivery, branch protection, or CI billing-not-started event',
      'No formal installation switch or human acceptance'],
    coverageIndex:{path:coveragePath,sha256:sha(fs.readFileSync(coveragePath)),
      evidenceLevel:coverageIndex.evidenceLevel,requirements:coverage},
    startedAt,finishedAt:new Date().toISOString(),elapsedMs:Date.now()-start,
    environment:{node:process.version,npm:toolVersion('npm',['--version']),
      git:toolVersion('git',['--version']),platform:process.platform,arch:process.arch},
    exitCode:testRun.status,signal:testRun.signal,error:testRun.error?.message||null,
    tests:tapCount('tests'),passed:tapCount('pass'),failed:tapCount('fail'),
    skipped:tapCount('skipped'),cancelled:tapCount('cancelled'),todo:tapCount('todo'),
    tapVersion,passedTestEvents:passedNames.length,
    candidateVerifiedBefore:true,candidateVerifiedAfter:afterVerified,afterError,
    stdout:{path:stdoutPath,sha256:sha(fs.readFileSync(stdoutPath))},
    stderr:{path:stderrPath,sha256:sha(fs.readFileSync(stderrPath))}};
  const summaryPath=path.join(output,'replay.json');
  fs.writeFileSync(summaryPath,JSON.stringify(summary,null,2)+'\n',{mode:0o600});
  ensure(testRun.status===0&&afterVerified&&tapVersion&&summary.tests>0&&
    summary.passedTestEvents===summary.passed&&summary.failed===0&&
    summary.skipped===0&&summary.cancelled===0&&summary.todo===0&&summary.passed===summary.tests&&
    coverage.every(requirement=>requirement.covered),
    `候选回放未通过；原始结果和校验记录：${summaryPath}`);
  return {summaryPath,...summary};
}
try{
  const [command,...args]=process.argv.slice(2);
  const result=command==='materialize'&&args.length===4?materialize(...args):
    command==='verify'&&args.length===2?verify(...args):
    command==='replay'&&args.length===3?replay(...args):null;
  ensure(result,'用法：candidate.mjs materialize <repo> <commit> <install> <external-skills-root> | verify <install> <manifest-sha256> | replay <install> <manifest-sha256> <new-evidence-directory>');
  process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){process.stderr.write(`candidate: ${error.message}\n`);process.exitCode=1;}
