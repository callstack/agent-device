// Type surface for the plain-Node release planner (it must stay runnable by bare `node`).
// Keep it in step with the exports of `./release-plan.mjs`.
export type ReleaseRun = Readonly<{
  event: string;
  ref: string;
  sha: string;
  sourceBranch?: 'main' | '0.22';
  rootVersion: string;
  today: string;
  runNumber: string | number;
  /** Remote tag names, each resolved to the commit it points at. */
  tags: ReadonlyMap<string, string>;
  latestStable?: string | null;
  latestNightly?: string | null;
  ciConclusion: string;
  onMain?: boolean;
}>;

export type ReleasePlan =
  | { mode: 'dry-run'; version: string }
  | { mode: 'nightly'; version: string; distTag: 'nightly' | 'nightly-0.22'; commit: string }
  | { mode: 'stable'; version: string; distTag: 'latest'; commit: string; previousTag: string }
  | { mode: 'skip'; reason: string };

export function planRelease(run: ReleaseRun): ReleasePlan;

export type ReleaseCommit = Readonly<{
  parents: readonly unknown[];
  files: readonly Readonly<{ filename: string; patch?: string }>[];
}>;

export function isVersionOnlyCommit(commit: ReleaseCommit): boolean;

export type TagRuleset = Readonly<{
  enforcement: string;
  rules: readonly Readonly<{ type: string }>[];
  conditions?: Readonly<{
    ref_name?: Readonly<{ include?: readonly string[]; exclude?: readonly string[] }>;
  }>;
  bypass_actors?: readonly Readonly<{ actor_type: string; actor_id?: number | null }>[];
}>;

export type RepositorySetup = Readonly<{
  npmPublish: Readonly<{
    deployment_branch_policy?: Readonly<{ custom_branch_policies?: boolean }> | null;
  }> | null;
  npmPublishPolicies: readonly Readonly<{ type: string; name: string }>[];
  tagRulesets: readonly TagRuleset[];
}>;

export function repositorySetupGaps(setup: RepositorySetup): string[];
