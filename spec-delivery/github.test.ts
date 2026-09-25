import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('批量观测只读取易变事实，API 故障不会冒充空状态', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-gh-'));
  const gh=path.join(dir,'gh'); const module=fileURLToPath(new URL('./github.ts',import.meta.url));
  fs.writeFileSync(gh,`#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);if(!a.includes('graphql'))throw Error('unexpected endpoint');console.log(JSON.stringify({data:{repository:{target:{target:{oid:'${'a'.repeat(40)}'}},i101:{number:101,state:'OPEN'},p201:{number:201,url:'https://github.com/example/test/pull/201',state:'OPEN',headRefOid:'${'b'.repeat(40)}',baseRefOid:'${'a'.repeat(40)}',baseRefName:'main',headRefName:'task',isDraft:false,mergeable:'MERGEABLE',mergeCommit:null}}}}));\n`);fs.chmodSync(gh,0o755);
  try {
    const run=spawnSync(process.execPath,['--input-type=module','-e',`import * as gh from ${JSON.stringify(module)};console.log(JSON.stringify(gh.snapshot({root:${JSON.stringify(dir)},slug:'example/test',host:'github.com',defaultBranch:'main'},'main',[101],[201])))`],{encoding:'utf8',env:{...process.env,PATH:dir+path.delimiter+process.env.PATH}});
    assert.equal(run.status,0,run.stderr); const facts=JSON.parse(run.stdout);
    assert.equal(facts.issueStates['101'],'OPEN'); assert.equal(facts.prs['201'].head,'b'.repeat(40));
    fs.writeFileSync(gh,'#!/usr/bin/env node\nconsole.error("HTTP 403 permission denied");process.exit(1);\n');
    const failed=spawnSync(process.execPath,['--input-type=module','-e',`import * as gh from ${JSON.stringify(module)};gh.snapshot({root:${JSON.stringify(dir)},slug:'example/test',host:'github.com',defaultBranch:'main'},'main',[101],[])`],{encoding:'utf8',env:{...process.env,PATH:dir+path.delimiter+process.env.PATH}});
    assert.notEqual(failed.status,0); assert.match(failed.stderr,/403/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
