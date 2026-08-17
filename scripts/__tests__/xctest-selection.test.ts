// The check that keeps ios.yml's hand-written `-only-testing:` list honest is itself only
// as good as its two parsers, and both of its inputs are files nobody edits with this check
// in mind. So: the real tree must pass, and a planted typo in the real workflow text must
// fail. Synthetic sources cover the shapes the real tree happens not to contain today.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildReport,
  formatSummary,
  loadReport,
  parseDeclaredTests,
  parseSelectedTests,
  PR_WORKFLOW_FILE,
  reportFailures,
  RUNNER_TESTS_DIR,
  readSwiftSources,
} from '../check-xctest-selection.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const TARGET = 'AgentDeviceRunnerUITests';

function source(text: string) {
  return [{ file: 'RunnerTests+Fixture.swift', text }];
}

describe('the real tree', () => {
  test('every `-only-testing:` entry in ios.yml names a declared test', () => {
    expect(reportFailures(loadReport(repoRoot))).toEqual([]);
  });

  test('the PR lane selects a real subset — some tests run only in the nightly', () => {
    const report = loadReport(repoRoot);
    // Not pinned to today's 37/153: the point is that the list is a proper subset, so
    // neither "the filter is gone" nor "the scan found nothing" reads as healthy.
    expect(report.selected.length).toBeGreaterThan(0);
    expect(report.declared.length).toBeGreaterThan(report.selected.length);
    for (const entry of report.selected) {
      expect(entry.identifier.startsWith(`${TARGET}/`)).toBe(true);
    }
    // The ratio is the whole point of the output — a passing run has to report it, or
    // nobody reading CI logs can see the PR lane shrinking.
    expect(formatSummary(report)).toContain(
      `${report.selected.length} of ${report.declared.length}`,
    );
    expect(formatSummary(report)).toContain(
      `the other ${report.declared.length - report.selected.length} run in`,
    );
  });

  test('every declared test is addressable as the identifier a filter would use', () => {
    // The count is the load-bearing claim: it must equal the `func test` methods in the
    // sources, derived here the crude way the issue counted them.
    const directory = path.join(repoRoot, RUNNER_TESTS_DIR);
    const grepped = readSwiftSources(directory).reduce(
      (total, entry) => total + (entry.text.match(/^ {2}(?:[\w@]+ )*func test/gm)?.length ?? 0),
      0,
    );
    expect(loadReport(repoRoot).declared).toHaveLength(grepped);
  });
});

describe('a planted typo', () => {
  test('a renamed test in the workflow list is reported with its line', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, PR_WORKFLOW_FILE), 'utf8');
    const first = parseSelectedTests(workflow)[0];
    if (!first) throw new Error('ios.yml has no -only-testing entries to plant a typo in');
    const typo = `${first.identifier}Renamed`;
    const report = buildReport(
      TARGET,
      readSwiftSources(path.join(repoRoot, RUNNER_TESTS_DIR)),
      workflow.replace(first.identifier, typo),
    );

    expect(report.unknown).toEqual([{ identifier: typo, line: first.line }]);
    expect(reportFailures(report).join('\n')).toContain(typo);
  });

  test('a deleted test is reported even though the surviving list still passes', () => {
    const swift = source(
      'extension RunnerTests {\n  func testKept() {}\n  func testGone() {}\n}\n',
    );
    const workflow = [
      `            -only-testing:${TARGET}/RunnerTests/testKept \\`,
      `            -only-testing:${TARGET}/RunnerTests/testGone`,
    ].join('\n');

    const before = buildReport(TARGET, swift, workflow);
    expect(before.unknown).toEqual([]);

    const after = buildReport(
      TARGET,
      source('extension RunnerTests {\n  func testKept() {}\n}\n'),
      workflow,
    );
    expect(after.unknown.map((entry) => entry.identifier)).toEqual([
      `${TARGET}/RunnerTests/testGone`,
    ]);
  });
});

describe('the declaration scan', () => {
  test('binds a method to the top-level type that encloses it', () => {
    expect(
      parseDeclaredTests(
        TARGET,
        source(
          'final class RunnerTests: XCTestCase {\n  func testInClass() {}\n}\n\n' +
            'extension RunnerTests {\n  func testInExtension() throws {}\n}\n\n' +
            'final class OtherTests: XCTestCase {\n  func testElsewhere() async throws {}\n}\n',
        ),
      ),
    ).toEqual([
      `${TARGET}/OtherTests/testElsewhere`,
      `${TARGET}/RunnerTests/testInClass`,
      `${TARGET}/RunnerTests/testInExtension`,
    ]);
  });

  test('ignores declarations no filter could address', () => {
    expect(
      parseDeclaredTests(
        TARGET,
        source(
          'extension RunnerTests {\n' +
            // A helper type declared inside a test body must not capture the methods after
            // it, and `class func` must not read as a type declaration named `func`.
            '  class func makeHelper() {}\n' +
            '  func testWithNestedHelper() {\n' +
            '    final class ResultBox {}\n' +
            '    func testLocal() {}\n' +
            '  }\n' +
            '  // func testCommentedOut() {}\n' +
            '  func testAfterNesting() {}\n' +
            '}\n',
        ),
      ),
    ).toEqual([
      `${TARGET}/RunnerTests/testAfterNesting`,
      `${TARGET}/RunnerTests/testWithNestedHelper`,
    ]);
  });
});

describe('the workflow scan', () => {
  test('reads every entry on the multi-line xcodebuild invocation', () => {
    expect(
      parseSelectedTests(
        [
          '          xcodebuild test-without-building \\',
          '            -xctestrun "$XCTESTRUN_PATH" \\',
          `            -only-testing:${TARGET}/RunnerTests/testOne \\`,
          `            -only-testing:${TARGET}/RunnerTests/testTwo`,
        ].join('\n'),
      ),
    ).toEqual([
      { identifier: `${TARGET}/RunnerTests/testOne`, line: 3 },
      { identifier: `${TARGET}/RunnerTests/testTwo`, line: 4 },
    ]);
  });

  test('leaves another target alone rather than guessing about sources it cannot see', () => {
    const report = buildReport(
      TARGET,
      source('extension RunnerTests {\n  func testOne() {}\n}\n'),
      `-only-testing:SomeOtherTarget/OtherTests/testUnknown\n-only-testing:${TARGET}/RunnerTests/testOne`,
    );
    expect(report.unknown).toEqual([]);
    expect(report.selected).toHaveLength(2);
  });
});

describe('the blind-parse guards', () => {
  test('an empty declaration scan fails instead of reporting a healthy list', () => {
    const report = buildReport(TARGET, source('// nothing here\n'), '-only-testing:a/b/c');
    expect(reportFailures(report).join('\n')).toContain('declaration scan is broken');
  });

  test('an empty workflow scan fails instead of reporting a healthy list', () => {
    const report = buildReport(
      TARGET,
      source('extension RunnerTests {\n  func testOne() {}\n}\n'),
      '',
    );
    expect(reportFailures(report).join('\n')).toContain('stopped filtering');
  });
});
