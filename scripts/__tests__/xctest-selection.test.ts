// The check that keeps the runner XCTest lanes honest is itself only as good as its
// parsers, and all of its inputs are files nobody edits with this check in mind. So: the
// real tree must pass, a planted typo in the real workflow text must fail — in both flag
// directions, because an unknown `-skip-testing:` entry re-arms a whole-bundle lane's
// 24-hour hang on `RunnerTests/testCommand` — and a planted guard that compiles a test out
// of every lane must fail as "dark". Synthetic sources cover the shapes the real tree
// happens not to contain today.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, onTestFinished, test } from 'vitest';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import {
  buildReport,
  counts,
  ENTRY_POINT_METHOD,
  formatSummary,
  GUARDED_WORKFLOWS,
  HOST_WORKFLOW_FILE,
  LANES,
  loadReport,
  NIGHTLY_WORKFLOW_FILE,
  parseFlaggedTests,
  PR_WORKFLOW_FILE,
  reportFailures,
  runnerPackageSourceFailures,
  type WorkflowSource,
} from '../check-xctest-selection.ts';
import { activeSource, PLATFORMS } from '../swift-conditional-compilation.ts';
import { readSwiftSources, RUNNER_TESTS_DIR } from '../xctest-declarations.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const TARGET = 'AgentDeviceRunnerUITests';
const ENTRY_POINT = `${TARGET}/${ENTRY_POINT_METHOD}`;

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

/** Workflow texts that skip the entry point on both whole-bundle lanes and list `pr` on the PR lane. */
function laneWorkflows(pr: readonly string[] = []): WorkflowSource[] {
  return [
    { workflow: HOST_WORKFLOW_FILE, text: `-skip-testing:${ENTRY_POINT}` },
    { workflow: NIGHTLY_WORKFLOW_FILE, text: `-skip-testing:${ENTRY_POINT}` },
    { workflow: PR_WORKFLOW_FILE, text: pr.map((id) => `-only-testing:${id}`).join('\n') },
  ];
}

const ENTRY_SOURCE = 'final class RunnerTests: XCTestCase {\n  func testCommand() {}\n}\n';

describe('the real tree', () => {
  test('every flagged identifier names a declared test its lane compiles, and nothing is dark', () => {
    expect(reportFailures(loadReport(repoRoot))).toEqual([]);
  });

  test('the three lanes partition the suite the way the classification says', () => {
    const report = loadReport(repoRoot);
    const { declared, host, pr, nightly, dark } = counts(report);
    // Not pinned to today's exact numbers; the invariants are the shape. The host lane
    // (macOS) and the nightly (iOS) both skip only the entry point, so together with the
    // simulator-only guard they cover everything else; the PR list is a proper subset of
    // the nightly; and the entry point is the only method outside every lane.
    expect(host).toBeGreaterThan(0);
    expect(nightly).toBeGreaterThan(pr);
    expect(pr).toBeGreaterThan(0);
    expect(dark).toBe(0);
    const reachedAnywhere = new Set(LANES.flatMap((entry) => [...report.reach[entry.id]]));
    expect(reachedAnywhere.size).toBe(declared - 1);
    expect(reachedAnywhere.has(ENTRY_POINT)).toBe(false);
    for (const id of report.reach.pr) expect(report.reach.nightly.has(id)).toBe(true);
  });

  test('the whole-bundle lanes skip the runner server entry point, which is not a test', () => {
    // The whole reason -skip-testing: exists in this repo. `testCommand` opens an
    // NWListener and waits 24 hours; an unfiltered run would hang the lane to its timeout.
    const skipped = loadReport(repoRoot).flagged.filter((entry) => entry.flag === 'skip-testing');
    for (const entry of LANES.filter((entry) => entry.selection === 'whole')) {
      expect(
        skipped.filter((flag) => flag.workflow === entry.workflow).map((flag) => flag.identifier),
      ).toContain(ENTRY_POINT);
    }
    for (const entry of skipped) expect(entry.identifier).toBe(ENTRY_POINT);
  });

  test('the simulator-only tests are exactly the ones the macOS build compiles out', () => {
    // The classification convention (RunnerTests.swift): a test the host lane must not run
    // says so with an `os(iOS)` guard. Everything the iOS build compiles and the macOS build
    // does not is therefore simulator-only, and the nightly is the lane that runs it.
    const report = loadReport(repoRoot);
    const simulatorOnly = report.declaredTests.filter(
      (test) => test.platforms.includes('iOS') && !test.platforms.includes('macOS'),
    );
    expect(simulatorOnly.length).toBeGreaterThan(0);
    for (const test of simulatorOnly) {
      expect(report.reach.host.has(test.identifier)).toBe(false);
      expect(report.reach.nightly.has(test.identifier)).toBe(true);
    }
  });

  test('the declared set covers every addressable method in the target directory', () => {
    // Derived independently of the check: the directory is globbed here, with this test's
    // own regex, because the Xcode project uses a PBXFileSystemSynchronizedRootGroup — every
    // .swift file in it is a member. Reusing the check's own file filter would make this
    // tautological, and a name-based filter is exactly the bug it caught
    // (RunnerTapPointPolicy.swift declares a test and does not start with "RunnerTests").
    const directory = path.join(repoRoot, RUNNER_TESTS_DIR);
    const countAddressableMethods = (sourceDirectory: string): number =>
      fs.readdirSync(sourceDirectory, { withFileTypes: true }).reduce((total, entry) => {
        const entryPath = path.join(sourceDirectory, entry.name);
        if (entry.isDirectory()) return total + countAddressableMethods(entryPath);
        if (!entry.isFile() || !entry.name.endsWith('.swift')) return total;
        const text = fs.readFileSync(entryPath, 'utf8');
        return total + (text.match(/^ {2}(?:[\w@]+ )*func test/gm)?.length ?? 0);
      }, 0);
    const counted = countAddressableMethods(directory);

    expect(counted).toBeGreaterThan(0);
    expect(loadReport(repoRoot).declared).toHaveLength(counted);
  });

  test('every #if condition in the tree is one the evaluator understands', () => {
    // The evaluator throws on vocabulary it does not know rather than guessing; the tree
    // must therefore stay inside that vocabulary, or the check goes red on the new guard.
    for (const entry of realSources()) {
      for (const platform of PLATFORMS) {
        expect(() => activeSource(entry.text, platform, entry.file)).not.toThrow();
      }
    }
  });

  test('the package-source boundary rejects an unguarded runner unit test', () => {
    const root = mkdtempForTestSync('agent-device-runner-package-selection-');
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const packageManifestPath = path.join(root, 'apple/snapshot-presentation/Package.runner.swift');
    fs.mkdirSync(path.dirname(packageManifestPath), { recursive: true });
    fs.writeFileSync(packageManifestPath, '// fixture package manifest\n');
    const sourcePath = path.join(
      root,
      'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Fixture.swift',
    );
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'extension RunnerTests {\n  func testLeaksIntoPackage() {}\n}\n');

    expect(runnerPackageSourceFailures(root).join('\n')).toContain('testLeaksIntoPackage');

    fs.writeFileSync(
      sourcePath,
      '#if AGENT_DEVICE_RUNNER_UNIT_TESTS\nextension RunnerTests {\n' +
        '  func testStaysInTests() {}\n}\n#endif\n',
    );
    expect(runnerPackageSourceFailures(root)).toEqual([]);
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

  test.each([
    ['nightly', NIGHTLY_WORKFLOW_FILE],
    ['host', HOST_WORKFLOW_FILE],
  ])(
    'a renamed `-skip-testing:` entry on the %s lane is reported as unknown AND as the hang it re-arms',
    (laneId, workflow) => {
      // Without this the typo is invisible: the lane would simply stop skipping, run
      // testCommand, and hang until timeout-minutes with no clue in the log.
      const text = fs.readFileSync(path.join(repoRoot, workflow), 'utf8');
      const typo = `${ENTRY_POINT}d`;
      const report = buildReport(
        TARGET,
        realSources(),
        realWorkflows({ [workflow]: text.replace(ENTRY_POINT, typo) }),
      );

      expect(report.unknown.map((entry) => [entry.flag, entry.identifier])).toEqual([
        ['skip-testing', typo],
      ]);
      const failures = reportFailures(report).join('\n');
      expect(failures).toContain('testCommand');
      expect(failures).toContain(`reachable by lane(s): ${laneId}`);
    },
  );

  test('a deleted test is reported even though the surviving list still passes', () => {
    const kept = `${ENTRY_SOURCE}extension RunnerTests {\n  func testKept() {}\n}\n`;
    const workflows = laneWorkflows([
      `${TARGET}/RunnerTests/testKept`,
      `${TARGET}/RunnerTests/testGone`,
    ]);

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

  test('a listed test the PR lane platform never compiles is reported, not silently unmatched', () => {
    // Declared, so the rename check passes — but ios.yml builds for iOS, and an
    // `os(macOS)` guard means the identifier matches nothing there.
    const report = buildReport(
      TARGET,
      source(
        `${ENTRY_SOURCE}extension RunnerTests {\n#if os(macOS)\n  func testHostOnly() {}\n#endif\n}\n`,
      ),
      laneWorkflows([`${TARGET}/RunnerTests/testHostOnly`]),
    );
    expect(report.unknown).toEqual([]);
    expect(report.uncompiled.map((entry) => entry.identifier)).toEqual([
      `${TARGET}/RunnerTests/testHostOnly`,
    ]);
    expect(reportFailures(report).join('\n')).toContain('never compiles');
  });
});

describe('a planted guard', () => {
  test('a test gated to a platform no lane runs is reported as dark', () => {
    // The real instance this rule was written for: two tests under `#if os(tvOS)` that no
    // lane had ever executed. Widening the guard to `|| os(macOS)` put them on the host lane.
    const report = buildReport(
      TARGET,
      source(
        `${ENTRY_SOURCE}#if AGENT_DEVICE_RUNNER_UNIT_TESTS\nextension RunnerTests {\n` +
          '  func testEverywhere() {}\n#if os(tvOS)\n  func testTvOnly() {}\n#endif\n}\n#endif\n',
      ),
      laneWorkflows(),
    );
    expect(report.dark).toEqual([`${TARGET}/RunnerTests/testTvOnly`]);
    expect(report.reach.host.has(`${TARGET}/RunnerTests/testEverywhere`)).toBe(true);
    expect(report.reach.nightly.has(`${TARGET}/RunnerTests/testEverywhere`)).toBe(true);
    expect(reportFailures(report).join('\n')).toContain('reachable by no lane');
  });

  test('a simulator-only guard keeps a test off the host lane and on the nightly', () => {
    const report = buildReport(
      TARGET,
      source(
        `${ENTRY_SOURCE}extension RunnerTests {\n#if AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)\n` +
          '  func testLaunchesApp() {}\n#endif\n}\n',
      ),
      laneWorkflows(),
    );
    const id = `${TARGET}/RunnerTests/testLaunchesApp`;
    expect(report.reach.host.has(id)).toBe(false);
    expect(report.reach.nightly.has(id)).toBe(true);
    expect(report.reach.pr.has(id)).toBe(false);
    expect(reportFailures(report)).toEqual([]);
  });

  test('a whole-bundle lane that stops skipping the entry point is reported as reaching it', () => {
    const report = buildReport(TARGET, source(ENTRY_SOURCE), [
      { workflow: HOST_WORKFLOW_FILE, text: 'run: xcodebuild test-without-building' },
      { workflow: NIGHTLY_WORKFLOW_FILE, text: `-skip-testing:${ENTRY_POINT}` },
      { workflow: PR_WORKFLOW_FILE, text: `-only-testing:${TARGET}/RunnerTests/testOther` },
    ]);
    expect(report.entryPointReachedBy).toEqual(['host']);
    expect(reportFailures(report).join('\n')).toContain('reachable by lane(s): host');
  });

  test('the PR list naming the entry point is reported too', () => {
    const report = buildReport(TARGET, source(ENTRY_SOURCE), laneWorkflows([ENTRY_POINT]));
    expect(report.entryPointReachedBy).toEqual(['pr']);
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

  test('reads every flag on one line, not just the first', () => {
    // Nothing stops two flags sharing a line, and matching only the first is silently
    // permissive in the skip direction — the unseen entry would be a lane that stopped
    // skipping the 24-hour entry point with no signal.
    expect(
      parseFlaggedTests(
        NIGHTLY_WORKFLOW_FILE,
        `-skip-testing:${TARGET}/RunnerTests/testOne -skip-testing:${TARGET}/RunnerTests/testTwo`,
      ).map((entry) => entry.identifier),
    ).toEqual([`${TARGET}/RunnerTests/testOne`, `${TARGET}/RunnerTests/testTwo`]);
  });

  test('a bare flag mention with no identifier after it is not a selection', () => {
    expect(parseFlaggedTests(PR_WORKFLOW_FILE, 'run: echo "-only-testing: is a flag"')).toEqual([]);
  });

  test('leaves another target alone rather than guessing about sources it cannot see', () => {
    const report = buildReport(
      TARGET,
      source(`${ENTRY_SOURCE}extension RunnerTests {\n  func testOne() {}\n}\n`),
      [
        {
          workflow: PR_WORKFLOW_FILE,
          text: `-only-testing:SomeOtherTarget/OtherTests/testUnknown\n-only-testing:${TARGET}/RunnerTests/testOne`,
        },
        { workflow: HOST_WORKFLOW_FILE, text: `-skip-testing:${ENTRY_POINT}` },
        { workflow: NIGHTLY_WORKFLOW_FILE, text: `-skip-testing:${ENTRY_POINT}` },
      ],
    );
    expect(report.unknown).toEqual([]);
    expect(report.uncompiled).toEqual([]);
    expect(report.flagged).toHaveLength(4);
  });
});

describe('the blind-parse guards', () => {
  const oneTest = () => source(`${ENTRY_SOURCE}extension RunnerTests {\n  func testOne() {}\n}\n`);

  test('a guarded workflow that no longer exists fails instead of leaving a stale claim', () => {
    const report = buildReport(TARGET, oneTest(), [
      ...laneWorkflows([`${TARGET}/RunnerTests/testOne`]).filter(
        (entry) => entry.workflow !== NIGHTLY_WORKFLOW_FILE,
      ),
      { workflow: NIGHTLY_WORKFLOW_FILE, text: null },
    ]);
    expect(reportFailures(report).join('\n')).toContain(NIGHTLY_WORKFLOW_FILE);
  });

  test('an empty declaration scan fails instead of reporting a healthy list', () => {
    const report = buildReport(TARGET, source('// nothing here\n'), laneWorkflows());
    expect(reportFailures(report).join('\n')).toContain('declaration scan is broken');
  });

  test('an empty workflow scan fails instead of reporting a healthy list', () => {
    const report = buildReport(TARGET, oneTest(), [{ workflow: PR_WORKFLOW_FILE, text: '' }]);
    expect(reportFailures(report).join('\n')).toContain('stopped filtering');
  });
});

describe('the summary line', () => {
  test('reports the per-lane reach a reader needs to see the partition', () => {
    const report = loadReport(repoRoot);
    const { declared, host, pr, nightly, dark } = counts(report);
    const summary = formatSummary(report);
    expect(summary).toContain(`${declared} declared`);
    expect(summary).toContain(`reaches ${host}, PR list`);
    expect(summary).toContain(`selects ${pr}, nightly`);
    expect(summary).toContain(`reaches ${nightly};`);
    expect(summary).toContain(`${dark} reachable by no lane`);
  });
});
