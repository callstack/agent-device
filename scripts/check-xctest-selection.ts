// `pnpm check:xctest-selection` — hold the hand-written `-only-testing:` list in
// .github/workflows/ios.yml to the tests that actually exist (#1781 A7).
//
// The PR lane runs a subset of the runner XCTest suite by naming each method on the
// xcodebuild command line. `xcodebuild test-without-building` treats an
// `-only-testing:` identifier that matches nothing as an empty selection rather than an
// error, so a renamed or deleted test does not fail the lane — it silently stops being
// tested, and the lane stays green with fewer tests than the list claims. That failure
// mode is invisible in logs unless someone counts, which is what this check does.
//
// Deliberately one-directional: a test that exists but is NOT in the PR list is fine, it
// runs in the nightly full-suite lane (.github/workflows/xctest-nightly.yml). Only the
// reverse — a listed name no source declares — is a defect.
//
// The declaration scan is source-level, so a method compiled out by an `#if os(...)`
// guard still counts as declared. That is the intended precision: this check guards the
// list against renames and deletions, not against platform availability, which the
// nightly full-suite run observes directly.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** The XCTest target directory; its basename is the target name the identifiers use. */
export const RUNNER_TESTS_DIR = 'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests';

/** The workflow whose `-only-testing:` list this check guards. */
export const PR_WORKFLOW_FILE = '.github/workflows/ios.yml';

/** The workflow that runs everything the PR list leaves out. */
const NIGHTLY_WORKFLOW_FILE = '.github/workflows/xctest-nightly.yml';

const RUNNER_TESTS_SOURCE = /^RunnerTests.*\.swift$/;

// One ordered pass over the source. A column-0 type declaration moves the enclosing type;
// a `func test…` indented exactly one level binds to it. Position carries the meaning
// rather than brace counting, which would have to know which `{` sits inside a string
// literal. It is also the more precise rule: only a method declared directly in a
// top-level `class`/`extension` block is addressable as `Target/Class/method`, so a
// helper type nested inside a test body (`final class ResultBox` — several of these
// exist) contributes no test identifiers, and neither does a closure-local `func test…`.
const DECLARATION =
  /^(?:[\w@]+[ \t]+)*(?:class|extension|struct|enum|actor|protocol)[ \t]+([A-Za-z_]\w*)|^ {2}(?:[\w@]+[ \t]+)*func[ \t]+(test\w*)[ \t]*\(/gm;

const ONLY_TESTING = /-only-testing:(\S+)/;

export type SwiftSource = { readonly file: string; readonly text: string };

/** One `-only-testing:` identifier as written, with the line that carries it. */
export type SelectedTest = { readonly identifier: string; readonly line: number };

export type SelectionReport = {
  readonly target: string;
  /** Every `Target/Class/method` the Swift sources declare, sorted. */
  readonly declared: readonly string[];
  /** Every `-only-testing:` identifier in the PR workflow, in file order. */
  readonly selected: readonly SelectedTest[];
  /** Selected identifiers naming no declared method — the failure. */
  readonly unknown: readonly SelectedTest[];
};

export function readSwiftSources(directory: string): SwiftSource[] {
  return fs
    .readdirSync(directory)
    .filter((entry) => RUNNER_TESTS_SOURCE.test(entry))
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

/** Every `-only-testing:` identifier the workflow names, with its line number. */
export function parseSelectedTests(workflowText: string): SelectedTest[] {
  return workflowText.split('\n').flatMap((text, index) => {
    const identifier = ONLY_TESTING.exec(text)?.[1];
    return identifier ? [{ identifier, line: index + 1 }] : [];
  });
}

export function buildReport(
  target: string,
  sources: readonly SwiftSource[],
  workflowText: string,
): SelectionReport {
  const declared = parseDeclaredTests(target, sources);
  const known = new Set(declared);
  const selected = parseSelectedTests(workflowText);
  return {
    target,
    declared,
    selected,
    // Identifiers for another target are left alone: this check owns one target's
    // sources and cannot speak for anything else the workflow might select.
    unknown: selected.filter(
      (entry) => entry.identifier.startsWith(`${target}/`) && !known.has(entry.identifier),
    ),
  };
}

export function loadReport(root: string = repoRoot): SelectionReport {
  const directory = path.join(root, RUNNER_TESTS_DIR);
  return buildReport(
    path.basename(directory),
    readSwiftSources(directory),
    fs.readFileSync(path.join(root, PR_WORKFLOW_FILE), 'utf8'),
  );
}

/** The failures, or an empty list. Kept separate from formatting so the test can assert both. */
export function reportFailures(report: SelectionReport): string[] {
  // A parser that stops matching would report "0 unknown" forever, which reads exactly
  // like a healthy list. Both inputs are non-empty by construction, so an empty parse is
  // the check going blind, not a real state of the tree.
  if (report.declared.length === 0) {
    return [
      `Found no test methods in ${RUNNER_TESTS_DIR}. The declaration scan is broken, ` +
        'so this check can no longer see a dropped test.',
    ];
  }
  if (report.selected.length === 0) {
    return [
      `Found no \`-only-testing:\` entries in ${PR_WORKFLOW_FILE}. Either the PR lane stopped ` +
        'filtering (drop this check), or the scan is broken and can no longer see a dropped test.',
    ];
  }
  if (report.unknown.length === 0) return [];
  return [
    `${PR_WORKFLOW_FILE} selects ${report.unknown.length} XCTest method(s) that no source declares:`,
    ...report.unknown.map((entry) => `  - line ${entry.line}: ${entry.identifier}`),
    'xcodebuild runs nothing for an unmatched `-only-testing:` identifier and still exits 0, so a',
    `rename or deletion drops the test silently. Update the entry to the current name, or remove`,
    `it — ${NIGHTLY_WORKFLOW_FILE} runs the whole suite either way.`,
  ];
}

export function formatSummary(report: SelectionReport): string {
  const remaining = report.declared.length - report.selected.length;
  return (
    `xctest selection: ${report.selected.length} of ${report.declared.length} ${report.target} ` +
    `methods run on every PR (${PR_WORKFLOW_FILE}); the other ${remaining} run in ` +
    `${NIGHTLY_WORKFLOW_FILE}.\n`
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
