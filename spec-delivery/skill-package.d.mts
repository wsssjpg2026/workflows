export declare const skillPackageNames: Readonly<{
  implementation:'implement'; diagnosis:'diagnosing-bugs'; authorReview:'code-review';
  prReview:'code-review-from-claude'; handoff:'handoff';
}>;
export type SkillPackageCapability=keyof typeof skillPackageNames;
export declare const skillCapabilities: readonly SkillPackageCapability[];
export declare const externalSkillPackages: readonly string[];
export declare const originalSkillBaselines: Readonly<{implement:string;handoff:string}>;
export declare function skillIdentity(sourcePath:string,source:string,
  files:readonly {relativePath:string;sha256:string}[]): {name:string;fingerprint:string};
