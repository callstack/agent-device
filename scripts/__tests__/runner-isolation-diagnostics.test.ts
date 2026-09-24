import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import {
  ISOLATION_CANARY_PATH,
  isolationCanaryLines,
  scanRunnerBuildLog,
} from '../runner-isolation-diagnostics.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const RUNNER = '/src/apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests';

// The four warnings the base build printed on CI run 35981303070 (#2882). None is an isolation
// diagnostic, so a log carrying only them passes.
const BASELINE_WARNINGS = [
  `${RUNNER}/RunnerTests+Lifecycle.swift:313:11: warning: conditional cast from 'NSNumber' to 'NSNumber' always succeeds`,
  `${RUNNER}/RunnerXCTestEventBridge.h:67:16: warning: pointer is missing a nullability type specifier (_Nonnull, _Nullable, or _Null_unspecified)`,
  `${RUNNER}/UnitTests/RunnerTests+SnapshotTimingTests.swift:112:5: warning: using '_' to ignore the result of a Void-returning function is redundant`,
  `${RUNNER}/UnitTests/RunnerTests+SnapshotTimingTests.swift:115:5: warning: using '_' to ignore the result of a Void-returning function is redundant`,
];
const MAIN_ACTOR_ISOLATED_WARNING = `${RUNNER}/RunnerTests+Transport.swift:201:26: warning: main actor-isolated property 'bundleId' can not be referenced from a Sendable closure`;
const LOSES_GLOBAL_ACTOR_WARNING = `${RUNNER}/RunnerTests+Lifecycle.swift:451:61: warning: converting function value of type '@MainActor () -> ()' to '() -> ()' loses global actor 'MainActor'`;

const CANARY_SOURCE = fs.readFileSync(path.join(repoRoot, ISOLATION_CANARY_PATH), 'utf8');
const CANARY_FILE = `${RUNNER}/RunnerIsolationCanary.swift`;
const [READ_LINE = 0, CALL_LINE = 0, DROP_LINE = 0, CAPTURE_LINE = 0] =
  isolationCanaryLines(CANARY_SOURCE);
// What Swift 6.2.3 (Xcode 26.2) prints for the canary under the runner's flags.
const CANARY_DIAGNOSTICS = [
  `${CANARY_FILE}:${READ_LINE}:17: warning: main actor-isolated property 'bundleId' can not be referenced from a Sendable closure`,
  `${CANARY_FILE}:${CALL_LINE}:7: warning: call to main actor-isolated parameter 'work' in a synchronous nonisolated context [#ActorIsolatedCall]`,
  `${CANARY_FILE}:${DROP_LINE}:5: warning: converting function value of type '@MainActor @Sendable () -> Void' to '@Sendable () -> Void' loses global actor 'MainActor'; this is an error in the Swift 6 language mode`,
  `${CANARY_FILE}:${CAPTURE_LINE}:7: warning: capture of 'counter' with non-Sendable type 'RunnerIsolationCanary.Counter' in a '@Sendable' closure [#SendableClosureCaptures]`,
];

function scan(...lines: string[]) {
  return scanRunnerBuildLog(log(...lines), CANARY_SOURCE);
}

function log(...lines: string[]): string {
  return [
    'CompileSwift normal arm64 (in target AgentDeviceRunnerUITests)',
    ...lines,
    '** TEST BUILD SUCCEEDED **',
    '',
  ].join('\n');
}

describe('scanRunnerBuildLog', () => {
  test('the canary marks one line per diagnosed shape', () => {
    expect(isolationCanaryLines(CANARY_SOURCE)).toHaveLength(4);
  });

  test('a log carrying the baseline warnings and the full canary passes', () => {
    expect(scan(...BASELINE_WARNINGS, ...CANARY_DIAGNOSTICS)).toEqual({
      violations: [],
      missingCanaryLines: [],
    });
  });

  test('main actor-isolated and loses-global-actor warnings are reported once each', () => {
    expect(
      scan(
        ...BASELINE_WARNINGS,
        ...CANARY_DIAGNOSTICS,
        MAIN_ACTOR_ISOLATED_WARNING,
        `  201 |       _ = self.mainOwned.bundleId`,
        "      |                          `- warning: main actor-isolated property 'bundleId' can not be referenced from a Sendable closure",
        LOSES_GLOBAL_ACTOR_WARNING,
        MAIN_ACTOR_ISOLATED_WARNING,
      ).violations,
    ).toEqual([MAIN_ACTOR_ISOLATED_WARNING, LOSES_GLOBAL_ACTOR_WARNING]);
  });

  test('an isolation error line is reported like a warning', () => {
    const error = `${RUNNER}/RunnerTests+ScreenRecorder.swift:308:11: error: call to main actor-isolated parameter 'capture' in a synchronous nonisolated context [#ActorIsolatedCall]`;
    expect(scan(...CANARY_DIAGNOSTICS, error).violations).toEqual([error]);
  });

  test('a Sendable-capture diagnostic is reported by its group or by its prose', () => {
    const grouped = `${RUNNER}/RunnerTests.swift:319:9: warning: capture of 'timer' with non-Sendable type 'Timer' in a '@Sendable' closure [#SendableClosureCaptures]`;
    const ungrouped = `${RUNNER}/RunnerTests.swift:320:9: warning: mutation of captured var 'count' in concurrently-executing code`;
    expect(scan(...CANARY_DIAGNOSTICS, grouped, ungrouped).violations).toEqual([
      grouped,
      ungrouped,
    ]);
  });

  test('a build log without the canary fails on every canary line', () => {
    expect(scan(...BASELINE_WARNINGS)).toEqual({
      violations: [],
      missingCanaryLines: [READ_LINE, CALL_LINE, DROP_LINE, CAPTURE_LINE],
    });
  });

  test('a reworded canary diagnostic the scan no longer matches fails its line', () => {
    const reworded = `${CANARY_FILE}:${READ_LINE}:17: warning: property 'bundleId' belongs to the main actor and is read from a Sendable closure`;
    expect(scan(reworded, ...CANARY_DIAGNOSTICS.slice(1)).missingCanaryLines).toEqual([READ_LINE]);
  });

  test('a concurrency diagnostic on an unmarked canary line is a violation', () => {
    const stray = `${CANARY_FILE}:${READ_LINE - 1}:5: warning: main actor-isolated property 'bundleId' can not be referenced from a Sendable closure`;
    expect(scan(...CANARY_DIAGNOSTICS, stray).violations).toEqual([stray]);
  });
});

// Runs the real build script against a stand-in `xcodebuild` that prints `output` and exits with
// `status`, so the scan and the status plumbing are exercised without Xcode.
function runBuildScript(
  output: string,
  status: number,
  options: { reuseDerivedData?: boolean } = {},
) {
  const root = mkdtempForTestSync('runner-isolation-scan-');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'xcodebuild-output.txt'), output);
  const fakeXcodebuild = path.join(bin, 'xcodebuild');
  const xcodebuildArgs = path.join(root, 'xcodebuild-args.txt');
  fs.writeFileSync(
    fakeXcodebuild,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(xcodebuildArgs)}\ncat ${JSON.stringify(path.join(root, 'xcodebuild-output.txt'))}\nexit ${status}\n`,
  );
  fs.chmodSync(fakeXcodebuild, 0o755);
  const derived = path.join(root, 'derived');
  if (options.reuseDerivedData) {
    fs.mkdirSync(path.join(derived, 'Build', 'Intermediates.noindex'), { recursive: true });
  }
  const result = spawnSync('sh', ['scripts/build-xcuitest-apple.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      AGENT_DEVICE_XCUITEST_PLATFORM: 'macos',
      AGENT_DEVICE_XCUITEST_DESTINATION: 'platform=macOS',
      AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: derived,
    },
  });
  return { ...result, derived, xcodebuildArgs };
}

describe('scripts/build-xcuitest-apple.sh isolation scan', () => {
  test('a build that printed an isolation warning fails after succeeding', () => {
    const result = runBuildScript(
      log(...BASELINE_WARNINGS, ...CANARY_DIAGNOSTICS, MAIN_ACTOR_ISOLATED_WARNING),
      0,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(MAIN_ACTOR_ISOLATED_WARNING);
    expect(result.stderr).toMatch(/runner isolation scan: 1 concurrency diagnostic/);
    expect(result.stderr).not.toMatch(/no concurrency diagnostic on/);
    expect(
      fs.readFileSync(
        path.join(result.derived, 'Logs', 'agent-device-build-for-testing.log'),
        'utf8',
      ),
    ).toContain(MAIN_ACTOR_ISOLATED_WARNING);
  });

  test('a build that did not print the canary fails', () => {
    const result = runBuildScript(log(...BASELINE_WARNINGS), 0);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no concurrency diagnostic on .*RunnerIsolationCanary\.swift/);
  });

  test('a failed scan drops the intermediates so the rerun recompiles and rescans every file', () => {
    const result = runBuildScript(log(...CANARY_DIAGNOSTICS, MAIN_ACTOR_ISOLATED_WARNING), 0, {
      reuseDerivedData: true,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Isolation scan covers only the files this build recompiled/);
    expect(fs.existsSync(path.join(result.derived, 'Build', 'Intermediates.noindex'))).toBe(false);
  });

  test('the build compiles the canary', () => {
    const result = runBuildScript(log(...CANARY_DIAGNOSTICS), 65);
    expect(result.status).toBe(65);
    expect(fs.readFileSync(result.xcodebuildArgs, 'utf8')).toContain(
      '-D AGENT_DEVICE_RUNNER_ISOLATION_CANARY',
    );
  });

  test("a failing build keeps xcodebuild's exit status and skips the scan", () => {
    const result = runBuildScript(log(MAIN_ACTOR_ISOLATED_WARNING), 65);
    expect(result.status).toBe(65);
    expect(result.stderr).not.toMatch(/runner isolation scan/);
  });
});
