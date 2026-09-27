/** Shared package identity for candidate materialization and live skill bindings. */
import {createHash} from 'node:crypto';

export const skillPackageNames=Object.freeze({
  implementation:'implement',diagnosis:'diagnosing-bugs',authorReview:'code-review',
  prReview:'code-review-from-claude',handoff:'handoff',
});
export const skillCapabilities=Object.freeze(Object.keys(skillPackageNames));
export const externalSkillPackages=Object.freeze(['implement','diagnosing-bugs','handoff']);
export const originalSkillBaselines=Object.freeze({
  implement:'6d3fd9e83b8f36e5213854779db49b256a457a7ebb4a503e53fa7dcff696adc3',
  handoff:'7c62de979fdc7ac32fb5ddb2146156c917f80ee070d30fadc9d40343c4b6ed25',
});

/** The fingerprint is over installed source path, frontmatter name, and sorted package bytes. */
export function skillIdentity(sourcePath,source,files){
  const header=source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if(!header||!source.slice(header[0].length).trim())throw Error('技能缺少有效 frontmatter 或正文');
  const name=header[1].match(/^name:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]?.trim();
  if(!name)throw Error('技能缺少 name');
  const sorted=files.map(file=>[file.relativePath,file.sha256])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  return {name,fingerprint:createHash('sha256').update(JSON.stringify({sourcePath,name,files:sorted})).digest('hex')};
}
