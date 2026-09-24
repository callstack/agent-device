import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { actorIsolationDiagnostics } from '../runner-isolation-diagnostics.ts';

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

function log(...lines: string[]): string {
  return [
    'CompileSwift normal arm64 (in target AgentDeviceRunnerUITests)',
    ...lines,
    '** TEST BUILD SUCCEEDED **',
    '',
  ].join('\n');
}

describe('actorIsolationDiagnostics', () => {
  test('a log carrying only the baseline warnings has no isolation diagnostic', () => {
    expect(actorIsolationDiagnostics(log(...BASELINE_WARNINGS))).toEqual([]);
  });

  test('main actor-isolated and loses-global-actor warnings are reported once each', () => {
    expect(
      actorIsolationDiagnostics(
        log(
          ...BASELINE_WARNINGS,
          MAIN_ACTOR_ISOLATED_WARNING,
          `  201 |       _ = self.mainOwned.bundleId`,
          "      |                          `- warning: main actor-isolated property 'bundleId' can not be referenced from a Sendable closure",
          LOSES_GLOBAL_ACTOR_WARNING,
          MAIN_ACTOR_ISOLATED_WARNING,
        ),
      ),
    ).toEqual([MAIN_ACTOR_ISOLATED_WARNING, LOSES_GLOBAL_ACTOR_WARNING]);
  });

  test('an isolation error line is reported like a warning', () => {
    const error = `${RUNNER}/RunnerTests+ScreenRecorder.swift:308:11: error: call to main actor-isolated parameter 'capture' in a synchronous nonisolated context [#ActorIsolatedCall]`;
    expect(actorIsolationDiagnostics(log(error))).toEqual([error]);
  });
});

// Runs the real build script against a stand-in `xcodebuild` that prints `output` and exits with
// `status`, so the scan and the status plumbing are exercised without Xcode.
function runBuildScript(output: string, status: number) {
  const root = mkdtempForTestSync('runner-isolation-scan-');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'xcodebuild-output.txt'), output);
  const fakeXcodebuild = path.join(bin, 'xcodebuild');
  fs.writeFileSync(
    fakeXcodebuild,
    `#!/bin/sh\ncat ${JSON.stringify(path.join(root, 'xcodebuild-output.txt'))}\nexit ${status}\n`,
  );
  fs.chmodSync(fakeXcodebuild, 0o755);
  const derived = path.join(root, 'derived');
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
  return { ...result, derived };
}

describe('scripts/build-xcuitest-apple.sh isolation scan', () => {
  test('a build that printed an isolation warning fails after succeeding', () => {
    const result = runBuildScript(log(...BASELINE_WARNINGS, MAIN_ACTOR_ISOLATED_WARNING), 0);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(MAIN_ACTOR_ISOLATED_WARNING);
    expect(result.stderr).toMatch(/runner isolation scan: 1 actor-isolation diagnostic/);
    expect(
      fs.readFileSync(
        path.join(result.derived, 'Logs', 'agent-device-build-for-testing.log'),
        'utf8',
      ),
    ).toContain(MAIN_ACTOR_ISOLATED_WARNING);
  });

  test("a failing build keeps xcodebuild's exit status and skips the scan", () => {
    const result = runBuildScript(log(MAIN_ACTOR_ISOLATED_WARNING), 65);
    expect(result.status).toBe(65);
    expect(result.stderr).not.toMatch(/runner isolation scan/);
  });
});
