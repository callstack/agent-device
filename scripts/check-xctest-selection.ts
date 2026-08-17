// `pnpm check:xctest-selection` — hold the hand-written `-only-testing:` and
// `-skip-testing:` lists in the iOS workflows to the tests that actually exist (#1781 A7).
//
// `xcodebuild` treats a test identifier that matches nothing as an empty set rather than an
// error, in BOTH directions, and each direction fails silently in its own way:
//
//   - `-only-testing:` (ios.yml, 37 hand-written entries) — a renamed or deleted test stops
//     running with no signal. The lane stays green with fewer tests than the list claims.
//   - `-skip-testing:` (xctest-nightly.yml) — the nightly skips `RunnerTests/testCommand`,
//     which is not a test at all: it is the runner's server entry point (RunnerTests.swift),
//     compiled unconditionally, and it starts an NWListener and waits 24 hours. A typo in
//     that entry re-arms a full-timeout hang, and a hang is the most expensive way a lane
//     can fail.
//
// Deliberately one-directional about coverage: a test in no `-only-testing:` list is fine,
// the nightly runs it. Only an identifier naming nothing is a defect.
//
// The declaration scan is source-level, so a method compiled out by `#if` still counts as
// declared. That is the intended precision — this check guards the lists against renames and
// deletions, not against platform availability, which the nightly observes directly.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** The XCTest target directory; its basename is the target name the identifiers use. */
export const RUNNER_TESTS_DIR = 'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests';

/** The PR lane, whose `-only-testing:` list decides what every pull request runs. */
export const PR_WORKFLOW_FILE = '.github/workflows/ios.yml';

/** The nightly lane, whose `-skip-testing:` list decides what the full suite leaves out. */
export const NIGHTLY_WORKFLOW_FILE = '.github/workflows/xctest-nightly.yml';

/**
 * Every workflow whose test identifiers this check owns. Both are read, so a workflow that
 * is renamed or deleted fails here rather than leaving a stale claim in the output.
 */
export const GUARDED_WORKFLOWS: readonly string[] = [PR_WORKFLOW_FILE, NIGHTLY_WORKFLOW_FILE];

// Every .swift file in the target directory is a member: the Xcode project uses a
// PBXFileSystemSynchronizedRootGroup, so membership is the directory, not a file list. A
// `RunnerTests*` name filter would miss RunnerTapPointPolicy.swift, which declares a real
// addressable test inside `extension RunnerTests`.
const SWIFT_SOURCE = /\.swift$/;

// One ordered pass over the source. A column-0 type declaration moves the enclosing type;
// a `func test…` indented exactly one level binds to it. Position carries the meaning
// rather than brace counting, which would have to know which `{` sits inside a string
// literal. It is also the more precise rule: only a method declared directly in a
// top-level `class`/`extension` block is addressable as `Target/Class/method`, so a
// helper type nested inside a test body (`final class ResultBox` — several of these
// exist) contributes no test identifiers, and neither does a closure-local `func test…`.
const DECLARATION =
  /^(?:[\w@]+[ \t]+)*(?:class|extension|struct|enum|actor|protocol)[ \t]+([A-Za-z_]\w*)|^ {2}(?:[\w@]+[ \t]+)*func[ \t]+(test\w*)[ \t]*\(/gm;

// Two guards against reading prose as configuration, both learned the hard way: these
// workflows discuss their own flags in comments, and this check's first draft counted the
// comments. A line whose first non-space character is `#` is a comment in YAML and in the
// `run:` shell alike, so it can never be a flag xcodebuild sees; and the identifier must
// have the `Target/Class/method` shape, so a prose mention with no identifier after the
// colon matches nothing. A typo'd identifier is still identifier-shaped, so both guards
// narrow what counts as a flag without narrowing what counts as a defect.
const YAML_COMMENT = /^\s*#/;
const TEST_FLAG = /-(only|skip)-testing:([A-Za-z_][\w.+-]*(?:\/[A-Za-z_]\w*){1,2})/;

export type SwiftSource = { readonly file: string; readonly text: string };

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
  /** Every `Target/Class/method` the Swift sources declare, sorted. */
  readonly declared: readonly string[];
  /** Every flagged identifier across the guarded workflows, in file order. */
  readonly flagged: readonly FlaggedTest[];
  /** Guarded workflows that do not exist — a claim this check can no longer make. */
  readonly missingWorkflows: readonly string[];
  /** Flagged identifiers naming no declared method — the failure. */
  readonly unknown: readonly FlaggedTest[];
};

export type WorkflowSource = { readonly workflow: string; readonly text: string | null };

export function readSwiftSources(directory: string): SwiftSource[] {
  return fs
    .readdirSync(directory)
    .filter((entry) => SWIFT_SOURCE.test(entry))
    .sort()
    .map((entry) => ({
      file: entry,
      text: fs.readFileSync(path.join(directory, entry), 'utf8'),
    }));
}

/** Every `Target/Class/method` identifier the sources declare. */
export function parseDeclaredTests(target: string, sources: readonly SwiftSource[]): string[] {
  const declared = new Set<string>();
  for (const source of sources) {
    let enclosing = '';
    for (const [, type, method] of source.text.matchAll(DECLARATION)) {
      if (type !== undefined) enclosing = type;
      else if (method !== undefined && enclosing) declared.add(`${target}/${enclosing}/${method}`);
    }
  }
  return [...declared].sort();
}

/** Every `-only-testing:`/`-skip-testing:` identifier a workflow names, with its line. */
export function parseFlaggedTests(workflow: string, text: string): FlaggedTest[] {
  return text.split('\n').flatMap((line, index) => {
    if (YAML_COMMENT.test(line)) return [];
    const match = TEST_FLAG.exec(line);
    if (!match) return [];
    return [
      {
        workflow,
        flag: `${match[1]}-testing` as TestFlag,
        identifier: match[2] as string,
        line: index + 1,
      },
    ];
  });
}

export function buildReport(
  target: string,
  sources: readonly SwiftSource[],
  workflows: readonly WorkflowSource[],
): SelectionReport {
  const declared = parseDeclaredTests(target, sources);
  const known = new Set(declared);
  const flagged = workflows.flatMap((entry) =>
    entry.text === null ? [] : parseFlaggedTests(entry.workflow, entry.text),
  );
  return {
    target,
    declared,
    flagged,
    missingWorkflows: workflows.filter((entry) => entry.text === null).map((e) => e.workflow),
    // Identifiers for another target are left alone: this check owns one target's
    // sources and cannot speak for anything else a workflow might select.
    unknown: flagged.filter(
      (entry) => entry.identifier.startsWith(`${target}/`) && !known.has(entry.identifier),
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

/** Attributed per workflow, not just per flag: each lane's number has to be its own. */
function identifiers(report: SelectionReport, workflow: string, flag: TestFlag): Set<string> {
  return new Set(
    report.flagged
      .filter((entry) => entry.workflow === workflow && entry.flag === flag)
      .map((entry) => entry.identifier),
  );
}

/** What each lane reaches, once the two flags are resolved against the declared set. */
export function counts(report: SelectionReport): {
  declared: number;
  pr: number;
  skipped: number;
  nightlyOnly: number;
} {
  const pr = identifiers(report, PR_WORKFLOW_FILE, 'only-testing');
  const skipped = identifiers(report, NIGHTLY_WORKFLOW_FILE, 'skip-testing');
  return {
    declared: report.declared.length,
    pr: pr.size,
    skipped: skipped.size,
    nightlyOnly: report.declared.filter((id) => !pr.has(id) && !skipped.has(id)).length,
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
        'GUARDED_WORKFLOWS rather than leaving a claim nothing backs.',
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
        `${GUARDED_WORKFLOWS.join(', ')}. Either both lanes stopped filtering (drop this ` +
        'check), or the scan is broken and can no longer see a dropped test.',
    ];
  }
  if (report.unknown.length === 0) return [];
  return [
    `${report.unknown.length} XCTest identifier(s) name a method no source declares:`,
    ...report.unknown.map(
      (entry) => `  - ${entry.workflow}:${entry.line} (-${entry.flag}) ${entry.identifier}`,
    ),
    'xcodebuild matches nothing and still exits 0 for an unknown identifier, in both',
    'directions: an unknown `-only-testing:` drops a test from the PR lane silently, and an',
    'unknown `-skip-testing:` re-admits whatever the nightly meant to leave out — including',
    `${report.target}/RunnerTests/testCommand, the runner's 24-hour server entry point.`,
    'Update the entry to the current name, or remove it.',
  ];
}

export function formatSummary(report: SelectionReport): string {
  const { declared, pr, skipped, nightlyOnly } = counts(report);
  return (
    `xctest selection: ${declared} declared ${report.target} methods — ${pr} selected on ` +
    `every PR (${PR_WORKFLOW_FILE}), ${skipped} skipped by the nightly ` +
    `(${NIGHTLY_WORKFLOW_FILE}), ${nightlyOnly} reached only by the nightly.\n`
  );
}

function main(): number {
  const report = loadReport();
  const failures = reportFailures(report);
  process.stdout.write(formatSummary(report));
  if (failures.length === 0) return 0;
  process.stderr.write(`${failures.join('\n')}\n`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
