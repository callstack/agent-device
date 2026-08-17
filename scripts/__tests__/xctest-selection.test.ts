// The check that keeps the iOS workflows' hand-written test identifiers honest is itself
// only as good as its two parsers, and both of its inputs are files nobody edits with this
// check in mind. So: the real tree must pass, and a planted typo in the real workflow text
// must fail — in both directions, because an unknown `-skip-testing:` entry re-arms the
// nightly's 24-hour hang on `RunnerTests/testCommand`. Synthetic sources cover the shapes
// the real tree happens not to contain today.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildReport,
  counts,
  formatSummary,
  GUARDED_WORKFLOWS,
  loadReport,
  NIGHTLY_WORKFLOW_FILE,
  parseDeclaredTests,
  parseFlaggedTests,
  PR_WORKFLOW_FILE,
  readSwiftSources,
  reportFailures,
  RUNNER_TESTS_DIR,
  type WorkflowSource,
} from '../check-xctest-selection.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const TARGET = 'AgentDeviceRunnerUITests';

function source(text: string) {
  return [{ file: 'RunnerTests+Fixture.swift', text }];
}

function realWorkflows(overrides: Readonly<Record<string, string>> = {}): WorkflowSource[] {
  return GUARDED_WORKFLOWS.map((workflow) => ({
    workflow,
    text: overrides[workflow] ?? fs.readFileSync(path.join(repoRoot, workflow), 'utf8'),
  }));
}

function realSources() {
  return readSwiftSources(path.join(repoRoot, RUNNER_TESTS_DIR));
}

describe('the real tree', () => {
  test('every flagged identifier in both workflows names a declared test', () => {
    expect(reportFailures(loadReport(repoRoot))).toEqual([]);
  });

  test('the PR lane selects a real subset — most tests are reached only by the nightly', () => {
    const report = loadReport(repoRoot);
    const { declared, pr, skipped, nightlyOnly } = counts(report);
    // Not pinned to today's exact numbers; the invariants are that the PR list is a proper
    // subset, that the nightly skips something, and that the three partition the suite.
    expect(pr).toBeGreaterThan(0);
    expect(skipped).toBeGreaterThan(0);
    expect(declared).toBeGreaterThan(pr + skipped);
    expect(pr + skipped + nightlyOnly).toBe(declared);
  });

  test('the nightly skips the runner server entry point, which is not a test', () => {
    // The whole reason -skip-testing: exists in this repo. `testCommand` opens an
    // NWListener and waits 24 hours; an unfiltered run would hang the lane to its timeout.
    const skipped = loadReport(repoRoot).flagged.filter((entry) => entry.flag === 'skip-testing');
    expect(skipped.map((entry) => entry.identifier)).toContain(`${TARGET}/RunnerTests/testCommand`);
    for (const entry of skipped) expect(entry.workflow).toBe(NIGHTLY_WORKFLOW_FILE);
  });

  test('the declared set covers every addressable method in the target directory', () => {
    // Derived independently of the check: the directory is globbed here, with this test's
    // own regex, because the Xcode project uses a PBXFileSystemSynchronizedRootGroup — every
    // .swift file in it is a member. Reusing the check's own file filter would make this
    // tautological, and a name-based filter is exactly the bug it caught
    // (RunnerTapPointPolicy.swift declares a test and does not start with "RunnerTests").
    const directory = path.join(repoRoot, RUNNER_TESTS_DIR);
    const counted = fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith('.swift'))
      .reduce((total, entry) => {
        const text = fs.readFileSync(path.join(directory, entry), 'utf8');
        return total + (text.match(/^ {2}(?:[\w@]+ )*func test/gm)?.length ?? 0);
      }, 0);

    expect(counted).toBeGreaterThan(0);
    expect(loadReport(repoRoot).declared).toHaveLength(counted);
  });
});

describe('a planted typo', () => {
  test('a renamed test in the PR `-only-testing:` list is reported with its line', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, PR_WORKFLOW_FILE), 'utf8');
    const first = parseFlaggedTests(PR_WORKFLOW_FILE, workflow).find(
      (entry) => entry.flag === 'only-testing',
    );
    if (!first) throw new Error('ios.yml has no -only-testing entries to plant a typo in');
    const typo = `${first.identifier}Renamed`;

    const report = buildReport(
      TARGET,
      realSources(),
      realWorkflows({ [PR_WORKFLOW_FILE]: workflow.replace(first.identifier, typo) }),
    );

    expect(report.unknown).toEqual([
      { workflow: PR_WORKFLOW_FILE, flag: 'only-testing', identifier: typo, line: first.line },
    ]);
    expect(reportFailures(report).join('\n')).toContain(typo);
  });

  test('a renamed test in the nightly `-skip-testing:` list is reported too', () => {
    // Without this the typo is invisible: the nightly would simply stop skipping, run
    // testCommand, and hang until timeout-minutes with no clue in the log.
    const nightly = fs.readFileSync(path.join(repoRoot, NIGHTLY_WORKFLOW_FILE), 'utf8');
    const typo = `${TARGET}/RunnerTests/testCommandd`;
    const report = buildReport(
      TARGET,
      realSources(),
      realWorkflows({
        [NIGHTLY_WORKFLOW_FILE]: nightly.replace(`${TARGET}/RunnerTests/testCommand`, typo),
      }),
    );

    expect(report.unknown.map((entry) => [entry.flag, entry.identifier])).toEqual([
      ['skip-testing', typo],
    ]);
    expect(reportFailures(report).join('\n')).toContain('testCommand');
  });

  test('a deleted test is reported even though the surviving list still passes', () => {
    const workflows = [
      {
        workflow: PR_WORKFLOW_FILE,
        text: [
          `            -only-testing:${TARGET}/RunnerTests/testKept \\`,
          `            -only-testing:${TARGET}/RunnerTests/testGone`,
        ].join('\n'),
      },
      { workflow: NIGHTLY_WORKFLOW_FILE, text: `-skip-testing:${TARGET}/RunnerTests/testKept` },
    ];
    const kept = 'extension RunnerTests {\n  func testKept() {}\n}\n';

    expect(
      buildReport(
        TARGET,
        source(`${kept}extension RunnerTests {\n  func testGone() {}\n}\n`),
        workflows,
      ).unknown,
    ).toEqual([]);
    expect(
      buildReport(TARGET, source(kept), workflows).unknown.map((entry) => entry.identifier),
    ).toEqual([`${TARGET}/RunnerTests/testGone`]);
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

  test('reads a file whose name does not start with RunnerTests', () => {
    // RunnerTapPointPolicy.swift is the real instance: the synchronized-root-group project
    // compiles every .swift in the directory, so file naming carries no membership meaning.
    expect(
      parseDeclaredTests(TARGET, [
        {
          file: 'RunnerTapPointPolicy.swift',
          text: 'extension RunnerTests {\n  func testGolden() {}\n}\n',
        },
      ]),
    ).toEqual([`${TARGET}/RunnerTests/testGolden`]);
  });
});

describe('the workflow scan', () => {
  test('reads both flags on the multi-line xcodebuild invocation', () => {
    expect(
      parseFlaggedTests(
        PR_WORKFLOW_FILE,
        [
          '          xcodebuild test-without-building \\',
          '            -xctestrun "$XCTESTRUN_PATH" \\',
          `            -only-testing:${TARGET}/RunnerTests/testOne \\`,
          `            -skip-testing:${TARGET}/RunnerTests/testTwo`,
        ].join('\n'),
      ),
    ).toEqual([
      {
        workflow: PR_WORKFLOW_FILE,
        flag: 'only-testing',
        identifier: `${TARGET}/RunnerTests/testOne`,
        line: 3,
      },
      {
        workflow: PR_WORKFLOW_FILE,
        flag: 'skip-testing',
        identifier: `${TARGET}/RunnerTests/testTwo`,
        line: 4,
      },
    ]);
  });

  test('ignores comments, which is where these workflows discuss their own flags', () => {
    // A real defect in this check's first draft: both workflows explain `-only-testing:`
    // and `-skip-testing:` in comments, and the scan counted the prose as configuration —
    // inflating the reported PR selection and inventing a skip the nightly never makes.
    expect(
      parseFlaggedTests(
        NIGHTLY_WORKFLOW_FILE,
        [
          `      # A typo re-arms the hang: -skip-testing:${TARGET}/RunnerTests/testProse`,
          `            -skip-testing:${TARGET}/RunnerTests/testReal`,
        ].join('\n'),
      ),
    ).toEqual([
      {
        workflow: NIGHTLY_WORKFLOW_FILE,
        flag: 'skip-testing',
        identifier: `${TARGET}/RunnerTests/testReal`,
        line: 2,
      },
    ]);
  });

  test('a bare flag mention with no identifier after it is not a selection', () => {
    expect(parseFlaggedTests(PR_WORKFLOW_FILE, 'run: echo "-only-testing: is a flag"')).toEqual([]);
  });

  test('leaves another target alone rather than guessing about sources it cannot see', () => {
    const report = buildReport(
      TARGET,
      source('extension RunnerTests {\n  func testOne() {}\n}\n'),
      [
        {
          workflow: PR_WORKFLOW_FILE,
          text: `-only-testing:SomeOtherTarget/OtherTests/testUnknown\n-only-testing:${TARGET}/RunnerTests/testOne`,
        },
      ],
    );
    expect(report.unknown).toEqual([]);
    expect(report.flagged).toHaveLength(2);
  });
});

describe('the blind-parse guards', () => {
  const oneTest = () => source('extension RunnerTests {\n  func testOne() {}\n}\n');
  const oneFlag = (workflow: string) => [
    { workflow, text: `-only-testing:${TARGET}/RunnerTests/testOne` },
  ];

  test('a guarded workflow that no longer exists fails instead of leaving a stale claim', () => {
    const report = buildReport(TARGET, oneTest(), [
      ...oneFlag(PR_WORKFLOW_FILE),
      { workflow: NIGHTLY_WORKFLOW_FILE, text: null },
    ]);
    expect(reportFailures(report).join('\n')).toContain(NIGHTLY_WORKFLOW_FILE);
  });

  test('an empty declaration scan fails instead of reporting a healthy list', () => {
    const report = buildReport(TARGET, source('// nothing here\n'), oneFlag(PR_WORKFLOW_FILE));
    expect(reportFailures(report).join('\n')).toContain('declaration scan is broken');
  });

  test('an empty workflow scan fails instead of reporting a healthy list', () => {
    const report = buildReport(TARGET, oneTest(), [{ workflow: PR_WORKFLOW_FILE, text: '' }]);
    expect(reportFailures(report).join('\n')).toContain('stopped filtering');
  });
});

describe('the summary line', () => {
  test('reports the partition a reader needs to see the PR lane shrinking', () => {
    const report = loadReport(repoRoot);
    const { declared, pr, skipped, nightlyOnly } = counts(report);
    const summary = formatSummary(report);
    expect(summary).toContain(`${declared} declared`);
    expect(summary).toContain(`${pr} selected on every PR`);
    expect(summary).toContain(`${skipped} skipped by the nightly`);
    expect(summary).toContain(`${nightlyOnly} reached only by the nightly`);
  });
});
