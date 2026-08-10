// Explicit, owned classifications for everything the derived gate manifest cannot prove.
//
// The manifest fails closed: an execution edge it cannot follow, or a suite no lane reaches, is
// a failure. That is only honest if there is a way to say "yes, and here is why" — otherwise the
// pressure is to weaken the derivation instead of classifying the exception. Every entry here
// carries a reason and a tracking reference, and every entry is itself checked: a waiver that
// stops matching anything fails the gate, so this list cannot rot into a pile of dead excuses.

import type { Terminal } from './execution-terminals.ts';

/** A unit of work that deliberately does not run in CI. */
export type LocalOnlyWaiver = {
  readonly terminal: Terminal;
  readonly reason: string;
  readonly issue: string;
};

/**
 * An executable whose real work the static walk cannot see, because it spawns a runner itself.
 * Declaring what it reaches keeps the suites behind it owned rather than invisible.
 */
export type DeclaredEdge = {
  readonly file: string;
  readonly reaches: readonly Terminal[];
  readonly reason: string;
  readonly issue: string;
};

/**
 * A file that forwards its argv verbatim to another process. The wrapper is not the unit of
 * work; what it wraps is. Declared rather than detected — "does this file re-spawn node?" is
 * not something to guess at.
 */
export const TRANSPARENT_WRAPPERS: readonly { file: string; reason: string }[] = [
  {
    file: 'scripts/node-test-tmpdir.ts',
    reason:
      'Redirects TMPDIR and forwards every remaining argument to a fresh `node`, so the test ' +
      'files after it are the real units of work (see the script comment, #1595).',
  },
];

/**
 * A `reason(check, file, rule, detail)` call in the affected selector whose rule argument is not
 * a string literal, and the claim that it adds no category the derivation has not already seen.
 *
 * Keyed on the exact source text of the call (whitespace collapsed). Blunt on purpose: this is a
 * human claim about one specific call, not a shape the reader recognizes, and selector-rules.ts
 * explains at length why the shape-recognizing version had to go. check.ts fails the gate if an
 * entry here matches no call (inert) or more than one (too broad to have been reviewed).
 */
export type ForwardedRule = {
  readonly call: string;
  readonly reason: string;
  readonly issue: string;
};

export const FORWARDED_SELECTOR_RULES: readonly ForwardedRule[] = [
  {
    call: 'reason(entry.check, file, entry.rule, entry.detail)',
    reason:
      'buildOwnership maps BUILD_OWNERSHIP onto selections, so `entry.rule` can only ever be ' +
      "one of that table's own `rule:` literals — which selector-rules.ts already collects " +
      'directly from the table entries. The forward re-states categories the universe has; it ' +
      'cannot introduce one. Checked by reading model.ts:368, not by static proof: the ' +
      'upstream `.filter((entry) => entry.owns(file))` callback invokes a member on the entry, ' +
      'and no sound reader can rule out that such a call mutates it.',
    issue: '#1429',
  },
];

export const DECLARED_EDGES: readonly DeclaredEdge[] = [
  {
    file: 'scripts/lib/contention-retry-run.ts',
    // Kept in sync by the manifest itself: these are Vitest project ids, and an id that stops
    // existing fails vitestProjectNames' universe check on the next run.
    reaches: [
      'vitest:unit-core',
      'vitest:subprocess-stub',
      'vitest:provider-integration',
      'vitest:interaction-contract',
      'vitest:output-economy',
    ],
    reason:
      'The single-retry policy runner (#1419) spawns `pnpm exec vitest run` itself with ' +
      'argv assembled at runtime, so no static walk can see which projects it covers. It ' +
      'passes no --project filter on the first run, which is every project.',
    issue: '#1419',
  },
];

export const LOCAL_ONLY: readonly LocalOnlyWaiver[] = [
  {
    terminal: 'exec:scripts/check-affected/run.ts',
    reason:
      'The affected-check selector is advisory and fail-open by design — GitHub CI stays ' +
      'authoritative, and running the selector in CI would only re-derive what CI already ' +
      'runs. Its derivation model IS gated: the Affected-check Selector job runs ' +
      '`pnpm check:affected:test`, which is where a wrong selection fails.',
    issue: '#1181',
  },
  {
    terminal: 'exec:src/bin.ts test test/integration/replays/android',
    reason:
      'The Android replay corpus runs nightly, but enumerated file by file inside the ' +
      'android-emulator-runner `script:` input (replays-nightly.yml, nightly-android) rather ' +
      'than through this directory-wide script — the emulator harness needs each replay ' +
      'wrapped in its own artifacts/junit paths. The script is the local entry point for the ' +
      'same corpus. The manifest does not walk third-party action inputs, so the coverage is ' +
      'real but unprovable here.',
    issue: '#1429',
  },
];

/**
 * A catalog entry whose `ciJobs` claim is true, but not provable terminal-for-terminal because
 * the job reaches the work through something this manifest does not walk. Keyed by check id.
 */
export const CATALOG_CLAIM_WAIVERS: readonly LocalOnlyWaiver[] = [
  {
    terminal: 'android-helpers',
    reason:
      'The Android smoke lane reaches the helper build through a shell script, not a package ' +
      'script: setup-android-replay-host runs `scripts/package-android-helper.sh`, which execs ' +
      '`scripts/build-android-helper.sh` (package-android-helper.sh:64). The manifest resolves ' +
      'workflow/action/package-script edges and deliberately stops at shell-script contents, ' +
      'so the last hop is asserted here instead of walked.',
    issue: '#1429',
  },
];

/**
 * Docs paths that ci.yml deliberately ignores, and the lane that gates them instead. This is
 * the #1420 hole, declared rather than left implicit: the manifest asserts each named job
 * exists AND that its workflow really triggers on the path, so narrowing pr-preview.yml's
 * `paths:` or deleting the job fails here.
 */
export type DocsLaneOwner = {
  readonly path: string;
  readonly workflow: string;
  readonly job: string;
  readonly reason: string;
  readonly issue: string;
};

export const DOCS_LANE_OWNERS: readonly DocsLaneOwner[] = [
  {
    path: 'website/docs/commands.md',
    workflow: '.github/workflows/pr-preview.yml',
    job: 'command-docs-gate',
    reason:
      'ci.yml ignores website/**, so the unit lane carrying the command-reference coverage ' +
      'gate never fires on a docs-only PR. pr-preview.yml runs `pnpm check:command-docs` on ' +
      'exactly the paths ci.yml drops, with no fork guard, so the gate still covers them.',
    issue: '#1420',
  },
];
