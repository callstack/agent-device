import { beforeAll, describe, test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { CONTACT_SHEET_UNSUPPORTED_HOST_REASON } from '../contact-sheet-report.ts';
import { assertContactSheetHostSupport } from '../contact-sheet-frames.ts';
import { getRecordingOverlaySupportWarning } from '../overlay.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const recordingScriptsDir = path.resolve(
  __dirname,
  '../../../../../apple/runner/AgentDeviceRunner/RecordingScripts',
);
const recordingTestSupportDir = path.resolve(__dirname, '../../../../../test/integration/support');
const SWIFT_TYPECHECK_TIMEOUT_MS = 60_000;

type TypecheckOutcome = { exitCode: number; stderr: string; source: string };

// The three `swiftc -typecheck` invocations run in beforeAll, not in the test bodies: each is a
// real compiler launch, and the unit slow-test gate budgets `packages/**` test cases far below one
// compile (see the budget note in docs/agents/testing.md). The snapshot-bridge and fold-helper
// gates in platform-apple keep their native compiles out of test-case wall time the same way.
// One beforeAll covers all three so the SDK probe and the two shared-source compiles are paid once
// per file rather than once per case.
describe.skipIf(process.platform !== 'darwin')('recording Swift scripts typecheck', () => {
  let outcomes: TypecheckOutcome[] = [];

  beforeAll(
    async () => {
      const [compiler, sdk] = await Promise.all([
        runCmd('xcrun', ['--find', 'swiftc']),
        runCmd('xcrun', ['--show-sdk-path', '--sdk', 'macosx']),
      ]);
      const swiftCompilerPath = compiler.stdout.trim() || 'swiftc';
      const swiftSdkPath = sdk.stdout.trim();
      const sharedSupport = path.join(recordingScriptsDir, 'RecordingExportSupport.swift');
      const targets: Array<{ source: string; extraSources: string[] }> = [
        { source: path.join(recordingTestSupportDir, 'recording-inspect.swift'), extraSources: [] },
        {
          source: path.join(recordingScriptsDir, 'recording-overlay.swift'),
          extraSources: [sharedSupport],
        },
        {
          source: path.join(recordingScriptsDir, 'recording-frames.swift'),
          extraSources: [sharedSupport],
        },
      ];

      outcomes = await Promise.all(
        targets.map(async ({ source, extraSources }): Promise<TypecheckOutcome> => {
          const result = await runCmd(
            swiftCompilerPath,
            ['-sdk', swiftSdkPath, '-typecheck', source, ...extraSources],
            { allowFailure: true, timeoutMs: SWIFT_TYPECHECK_TIMEOUT_MS },
          );
          return { source, exitCode: result.exitCode, stderr: result.stderr };
        }),
      );
    },
    SWIFT_TYPECHECK_TIMEOUT_MS * 3 + 30_000,
  );

  test('recording inspect Swift script typechecks', () => {
    assertTypechecked(outcomes, 'recording-inspect.swift');
  });

  test('recording overlay Swift script typechecks', () => {
    assertTypechecked(outcomes, 'recording-overlay.swift');
  });

  test('recording frames Swift script typechecks', () => {
    assertTypechecked(outcomes, 'recording-frames.swift');
  });
});

function assertTypechecked(outcomes: readonly TypecheckOutcome[], basename: string): void {
  const outcome = outcomes.find((entry) => path.basename(entry.source) === basename);
  assert.ok(outcome, `${basename} was never typechecked`);
  assert.equal(outcome.exitCode, 0, `${basename} should typecheck\n${outcome.stderr}`);
}

test('recording overlays are explicitly unsupported on non-macOS hosts', () => {
  assert.equal(
    getRecordingOverlaySupportWarning('linux'),
    'touch overlay burn-in is only available on macOS hosts; returning raw video plus gesture telemetry',
  );
  assert.equal(getRecordingOverlaySupportWarning('darwin'), undefined);
});

test('contact sheets are explicitly unsupported on non-macOS hosts', () => {
  assert.throws(
    () => assertContactSheetHostSupport('linux'),
    (error: unknown) => {
      return (
        error instanceof AppError &&
        error.code === 'UNSUPPORTED_OPERATION' &&
        error.details?.reason === CONTACT_SHEET_UNSUPPORTED_HOST_REASON
      );
    },
  );
  assert.doesNotThrow(() => assertContactSheetHostSupport('darwin'));
});
