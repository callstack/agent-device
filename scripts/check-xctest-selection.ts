// `pnpm check:xctest-selection` — derive, from the Swift sources and the workflow files, which
// runner XCTest methods each CI lane actually reaches, and fail when a method reaches none
// (#1781 A7). Also ensures those unit-test methods are stripped from the Apple runner source
// copied into the npm package.
//
// Three lanes run the `AgentDeviceRunnerUITests` bundle, and each reaches a different set:
//
//   - host    macos.yml, macOS host, every PR: the whole bundle as compiled for macOS, minus
//             `-skip-testing:` — the pure runner-decision tests, whose guard is
//             `#if AGENT_DEVICE_RUNNER_UNIT_TESTS` alone.
//   - pr      ios.yml, iOS Simulator, every PR: the hand-written `-only-testing:` list.
//   - nightly xctest-nightly.yml, iOS Simulator, scheduled: the whole bundle as compiled for
//             iOS, minus `-skip-testing:` — includes the simulator-only tests, whose guard is
//             `… && os(iOS)` (they launch the host app, route through SpringBoard, or assert an
//             iOS-only branch).
//
// The classification therefore lives in the `#if` guards, so this check evaluates them per
// platform rather than treating a source-level `func test…` as running everywhere. What it
// holds:
//
//   1. Every `-only-testing:`/`-skip-testing:` identifier names a declared method that
//      compiles for that lane's platform. `xcodebuild` treats an identifier matching nothing
//      as an empty set rather than an error, in BOTH directions: an unknown `-only-testing:`
//      drops a test from the PR lane silently, and an unknown `-skip-testing:` re-admits
//      `RunnerTests/testCommand` — not a test but the runner's server entry point, which opens
//      an NWListener and waits 24 hours — into a whole-bundle lane and hangs it.
//   2. Every declared method is reachable by at least one lane. A test gated to a platform
//      no lane runs (the tvOS-only pair this check found) is dark from the day it is written.
//   3. The entry point is reachable by no lane at all.
//
// The nightly and host lanes also assert their executed count equals the reach derived here
// (scripts/xctest-run-summary.ts), so a build variant without the unit-test compile flag, or a
// guard that quietly compiles a file out, reads as red instead of as a smaller green.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import type { Platform } from './swift-conditional-compilation.ts';
import {
  parseDeclaredTestsByPlatform,
  readSwiftSources,
  RUNNER_TESTS_DIR,
  type DeclaredTest,
  type SwiftSource,
} from './xctest-declarations.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packageAppleRunnerScript = path.join(repoRoot, 'scripts/package-apple-runner-source.mjs');

/** The macOS host lane, which runs the whole macOS-compiled bundle on every PR. */
export const HOST_WORKFLOW_FILE = '.github/workflows/macos.yml';

/** The PR lane, whose `-only-testing:` list decides what every pull request runs on the simulator. */
export const PR_WORKFLOW_FILE = '.github/workflows/ios.yml';

/** The nightly lane, whose `-skip-testing:` list decides what the full simulator suite leaves out. */
export const NIGHTLY_WORKFLOW_FILE = '.github/workflows/xctest-nightly.yml';

export type LaneId = 'host' | 'pr' | 'nightly';

export type Lane = {
  readonly id: LaneId;
  readonly workflow: string;
  readonly platform: Platform;
  /** `whole`: everything compiled minus `-skip-testing:`; `list`: the `-only-testing:` entries. */
  readonly selection: 'whole' | 'list';
  /** The job-summary heading the lane's reporter prints. */
  readonly title: string;
};

export const LANES: readonly Lane[] = [
  {
    id: 'host',
    workflow: HOST_WORKFLOW_FILE,
    platform: 'macOS',
    selection: 'whole',
    title: 'iOS runner host XCTest lane (macOS, no simulator)',
  },
  {
    id: 'pr',
    workflow: PR_WORKFLOW_FILE,
    platform: 'iOS',
    selection: 'list',
    title: 'iOS runner PR XCTest list',
  },
  {
    id: 'nightly',
    workflow: NIGHTLY_WORKFLOW_FILE,
    platform: 'iOS',
    selection: 'whole',
    title: 'iOS runner full XCTest suite',
  },
];

export function lane(id: string): Lane {
  const found = LANES.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(
      `Unknown XCTest lane "${id}"; expected one of ${LANES.map((e) => e.id).join(', ')}.`,
    );
  }
  return found;
}

/**
 * Every workflow whose test identifiers this check owns. All are read, so a workflow that is
 * renamed or deleted fails here rather than leaving a stale claim in the output.
 */
export const GUARDED_WORKFLOWS: readonly string[] = LANES.map((entry) => entry.workflow);

/**
 * The one method that must be reachable by no lane: `testCommand` is the runner's server
 * entry point (RunnerTests.swift), compiled unconditionally.
 */
export const ENTRY_POINT_METHOD = 'RunnerTests/testCommand';

// Two guards against reading prose as configuration, both learned the hard way: these
// workflows discuss their own flags in comments, and this check's first draft counted the
// comments. A line whose first non-space character is `#` is a comment in YAML and in the
// `run:` shell alike, so it can never be a flag xcodebuild sees; and the identifier must
// have the `Target/Class/method` shape, so a prose mention with no identifier after the
// colon matches nothing. A typo'd identifier is still identifier-shaped, so both guards
// narrow what counts as a flag without narrowing what counts as a defect.
const YAML_COMMENT = /^\s*#/;
// Global: a `run:` line may carry more than one flag (nothing stops `-only-testing:A -only-testing:B`
// on one line), and matching only the first would make the second invisible — silently permissive in
// the skip direction, where an unseen entry is a lane that stops skipping the 24-hour entry point.
const TEST_FLAG = /-(only|skip)-testing:([A-Za-z_][\w.+-]*(?:\/[A-Za-z_]\w*){1,2})/g;

export type TestFlag = 'only-testing' | 'skip-testing';

/** One `-only-testing:`/`-skip-testing:` identifier as written, and where it was written. */
export type FlaggedTest = {
  readonly workflow: string;
  readonly flag: TestFlag;
  readonly identifier: string;
  readonly line: number;
};

export type SelectionReport = {
  readonly target: string;
  /** Every `Target/Class/method` the Swift sources declare, sorted, regardless of guards. */
  readonly declared: readonly string[];
  /** The same set with the platforms each method compiles for. */
  readonly declaredTests: readonly DeclaredTest[];
  /** Every flagged identifier across the guarded workflows, in file order. */
  readonly flagged: readonly FlaggedTest[];
  /** Guarded workflows that do not exist — a claim this check can no longer make. */
  readonly missingWorkflows: readonly string[];
  /** Flagged identifiers naming no declared method — a failure. */
  readonly unknown: readonly FlaggedTest[];
  /** Flagged identifiers naming a method its lane's platform never compiles — a failure. */
  readonly uncompiled: readonly FlaggedTest[];
  /** What each lane reaches, once guards and flags are resolved. */
  readonly reach: Readonly<Record<LaneId, ReadonlySet<string>>>;
  /** Declared methods no lane reaches, entry point excluded — a failure. */
  readonly dark: readonly string[];
  /** Lanes that reach the entry point — a failure (a 24-hour hang). */
  readonly entryPointReachedBy: readonly LaneId[];
};

export type WorkflowSource = { readonly workflow: string; readonly text: string | null };

/** Every `-only-testing:`/`-skip-testing:` identifier a workflow names, with its line. */
export function parseFlaggedTests(workflow: string, text: string): FlaggedTest[] {
  return text.split('\n').flatMap((line, index) => {
    if (YAML_COMMENT.test(line)) return [];
    return [...line.matchAll(TEST_FLAG)].map((match) => ({
      workflow,
      flag: `${match[1]}-testing` as TestFlag,
      identifier: match[2] as string,
      line: index + 1,
    }));
  });
}

/** Attributed per workflow, not just per flag: each lane's number has to be its own. */
function identifiers(
  flagged: readonly FlaggedTest[],
  workflow: string,
  flag: TestFlag,
): Set<string> {
  return new Set(
    flagged
      .filter((entry) => entry.workflow === workflow && entry.flag === flag)
      .map((entry) => entry.identifier),
  );
}

/** What one lane reaches: its platform's compiled set, narrowed by its flags. */
function laneReach(
  entry: Lane,
  declaredTests: readonly DeclaredTest[],
  flagged: readonly FlaggedTest[],
): Set<string> {
  const only = identifiers(flagged, entry.workflow, 'only-testing');
  const skipped = identifiers(flagged, entry.workflow, 'skip-testing');
  return new Set(
    declaredTests
      .filter((test) => test.platforms.includes(entry.platform))
      .map((test) => test.identifier)
      .filter((id) => (entry.selection === 'whole' || only.has(id)) && !skipped.has(id)),
  );
}

export function buildReport(
  target: string,
  sources: readonly SwiftSource[],
  workflows: readonly WorkflowSource[],
): SelectionReport {
  const declaredTests = parseDeclaredTestsByPlatform(target, sources);
  const declared = declaredTests.map((test) => test.identifier);
  const known = new Map(declaredTests.map((test) => [test.identifier, test]));
  const flagged = workflows.flatMap((entry) =>
    entry.text === null ? [] : parseFlaggedTests(entry.workflow, entry.text),
  );
  const platformOf = new Map(LANES.map((entry) => [entry.workflow, entry.platform]));
  // Identifiers for another target are left alone: this check owns one target's sources
  // and cannot speak for anything else a workflow might select.
  const owned = flagged.filter((entry) => entry.identifier.startsWith(`${target}/`));
  const reach = Object.fromEntries(
    LANES.map((entry) => [entry.id, laneReach(entry, declaredTests, flagged)]),
  ) as Record<LaneId, ReadonlySet<string>>;
  const entryPoint = `${target}/${ENTRY_POINT_METHOD}`;
  const reachedAnywhere = new Set(LANES.flatMap((entry) => [...reach[entry.id]]));
  return {
    target,
    declared,
    declaredTests,
    flagged,
    missingWorkflows: workflows.filter((entry) => entry.text === null).map((e) => e.workflow),
    unknown: owned.filter((entry) => !known.has(entry.identifier)),
    uncompiled: owned.filter((entry) => {
      const test = known.get(entry.identifier);
      const platform = platformOf.get(entry.workflow);
      return test !== undefined && platform !== undefined && !test.platforms.includes(platform);
    }),
    reach,
    dark: declared.filter((id) => id !== entryPoint && !reachedAnywhere.has(id)),
    entryPointReachedBy: LANES.filter((entry) => reach[entry.id].has(entryPoint)).map(
      (entry) => entry.id,
    ),
  };
}

export function loadReport(root: string = repoRoot): SelectionReport {
  const directory = path.join(root, RUNNER_TESTS_DIR);
  return buildReport(
    path.basename(directory),
    readSwiftSources(directory),
    GUARDED_WORKFLOWS.map((workflow) => {
      const file = path.join(root, workflow);
      return { workflow, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
    }),
  );
}

/** The partition a reader needs: how many methods each lane reaches, and how many none does. */
export function counts(report: SelectionReport): {
  declared: number;
  host: number;
  pr: number;
  nightly: number;
  dark: number;
} {
  return {
    declared: report.declared.length,
    host: report.reach.host.size,
    pr: report.reach.pr.size,
    nightly: report.reach.nightly.size,
    dark: report.dark.length,
  };
}

/** The failures, or an empty list. Kept apart from formatting so the test can assert both. */
export function reportFailures(report: SelectionReport): string[] {
  // A parser that stops matching would report "0 unknown" forever, which reads exactly
  // like a healthy list. Both inputs are non-empty by construction, so an empty parse is
  // the check going blind, not a real state of the tree.
  if (report.missingWorkflows.length > 0) {
    return [
      `Missing guarded workflow(s): ${report.missingWorkflows.join(', ')}. This check names ` +
        'them in its own output, so a renamed or deleted lane must be reflected in ' +
        'LANES rather than leaving a claim nothing backs.',
    ];
  }
  if (report.declared.length === 0) {
    return [
      `Found no test methods in ${RUNNER_TESTS_DIR}. The declaration scan is broken, ` +
        'so this check can no longer see a dropped test.',
    ];
  }
  if (report.flagged.length === 0) {
    return [
      'Found no `-only-testing:`/`-skip-testing:` entries in ' +
        `${GUARDED_WORKFLOWS.join(', ')}. Either every lane stopped filtering (drop this ` +
        'check), or the scan is broken and can no longer see a dropped test.',
    ];
  }
  const failures: string[] = [];
  const flagLine = (entry: FlaggedTest) =>
    `  - ${entry.workflow}:${entry.line} (-${entry.flag}) ${entry.identifier}`;
  if (report.unknown.length > 0) {
    failures.push(
      `${report.unknown.length} XCTest identifier(s) name a method no source declares:`,
      ...report.unknown.map(flagLine),
      'xcodebuild matches nothing and still exits 0 for an unknown identifier, in both',
      'directions: an unknown `-only-testing:` drops a test from the PR lane silently, and an',
      'unknown `-skip-testing:` re-admits whatever a whole-bundle lane meant to leave out —',
      `including ${report.target}/${ENTRY_POINT_METHOD}, the runner's 24-hour server entry point.`,
      'Update the entry to the current name, or remove it.',
    );
  }
  if (report.uncompiled.length > 0) {
    failures.push(
      `${report.uncompiled.length} XCTest identifier(s) name a method that lane's platform ` +
        'never compiles:',
      ...report.uncompiled.map(flagLine),
      "The method exists, but its `#if` guard compiles it out of that lane's build, so the",
      'flag matches nothing there. Move the entry to a lane whose platform compiles it, or',
      'widen the guard.',
    );
  }
  if (report.dark.length > 0) {
    failures.push(
      `${report.dark.length} declared XCTest method(s) are reachable by no lane:`,
      ...report.dark.map((identifier) => `  - ${identifier}`),
      'The host lane runs everything the macOS build compiles, the nightly everything the iOS',
      'build compiles, and the PR list names its methods; a method outside all three — usually',
      'a guard naming a platform no lane runs — is dark from the day it is written. Widen the',
      'guard, list it, or delete it.',
    );
  }
  if (report.entryPointReachedBy.length > 0) {
    failures.push(
      `${report.target}/${ENTRY_POINT_METHOD} is reachable by lane(s): ` +
        `${report.entryPointReachedBy.join(', ')}.`,
      'It is not a test: it opens an NWListener and waits 24 hours for a client, so a lane that',
      'runs it hangs until timeout-minutes. Whole-bundle lanes must keep their -skip-testing:',
      'entry for it; the PR list must not name it.',
    );
  }
  return failures;
}

export function formatSummary(report: SelectionReport): string {
  const { declared, host, pr, nightly, dark } = counts(report);
  return (
    `xctest selection: ${declared} declared ${report.target} methods — host lane ` +
    `(${HOST_WORKFLOW_FILE}, macOS, every PR) reaches ${host}, PR list (${PR_WORKFLOW_FILE}, ` +
    `iOS Simulator, every PR) selects ${pr}, nightly (${NIGHTLY_WORKFLOW_FILE}, iOS Simulator) ` +
    `reaches ${nightly}; ${dark} reachable by no lane; ${ENTRY_POINT_METHOD} skipped everywhere.\n`
  );
}

/** Reuse the package builder's source guard without writing dist or packing a tarball. */
export function runnerPackageSourceFailures(root: string = repoRoot): string[] {
  const result = runCmdSync(
    process.execPath,
    [packageAppleRunnerScript, '--root', root, '--check', '--quiet'],
    { allowFailure: true },
  );
  if (result.exitCode === 0) return [];
  const detail = (result.stderr || result.stdout).trim();
  return [`Apple runner package source guard failed:\n${detail || 'unknown failure'}`];
}

function main(): number {
  const report = loadReport();
  const failures = [...reportFailures(report), ...runnerPackageSourceFailures()];
  process.stdout.write(formatSummary(report));
  if (failures.length === 0) return 0;
  process.stderr.write(`${failures.join('\n')}\n`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
