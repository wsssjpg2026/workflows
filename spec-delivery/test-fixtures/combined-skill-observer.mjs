#!/usr/bin/env node
/** Reports source execution and the exact files archived for one bound invocation. */
import fs from 'node:fs';

const statePath=process.env.SPEC_DELIVERY_COMBINED_STATE;
if (!statePath) throw Error('missing combined workflow state');
const [operation,id,jobId]=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
if (operation==='capabilities') {
  console.log(JSON.stringify({source:'native_host',jobId,capability:id,
    capabilities:{sourceExecution:{allowed:true,acceptsOriginalFiles:true}}}));
} else if (operation==='result') {
  const invocation=state.v3.skillInvocations.find(value=>value.id===id);
  if (!invocation || invocation.jobId!==jobId) throw Error('unknown bound skill invocation');
  const source=JSON.parse(fs.readFileSync(invocation.sourceArchivePath,'utf8'));
  console.log(JSON.stringify({source:'native_host',invocationId:id,jobId,
    nativeId:invocation.session.nativeId,observationId:invocation.session.observationId,
    mode:invocation.mode,bindingFingerprint:invocation.bindingFingerprint,terminal:true,
    loadedFiles:source.files.map(value=>({relativePath:value.relativePath,sha256:value.sha256}))}));
} else throw Error('unknown skill observation');
