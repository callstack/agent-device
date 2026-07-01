import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmd } from '../../utils/exec.ts';
import { getRecordingOverlaySupportWarning } from '../overlay.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const recordingScriptsDir = path.resolve(
  __dirname,
  '../../../apple-runner/AgentDeviceRunner/RecordingScripts',
);
const recordingTestSupportDir = path.resolve(__dirname, '../../../test/integration/support');
const SWIFT_TYPECHECK_TIMEOUT_MS = 60_000;

async function assertSwiftScriptTypechecks(scriptPath: string): Promise<void> {
  const result = await runCmd('xcrun', ['swiftc', '-typecheck', scriptPath], {
    allowFailure: true,
  });
  assert.equal(result.exitCode, 0, `${path.basename(scriptPath)} should typecheck`);
}

test(
  'recording overlay Swift script typechecks',
  async (t) => {
    if (process.platform !== 'darwin') {
      t.skip('Swift recording scripts are only validated on macOS');
    }

    await assertSwiftScriptTypechecks(path.join(recordingScriptsDir, 'recording-overlay.swift'));
  },
  SWIFT_TYPECHECK_TIMEOUT_MS,
);

test(
  'recording trim Swift script typechecks',
  async (t) => {
    if (process.platform !== 'darwin') {
      t.skip('Swift recording scripts are only validated on macOS');
    }

    await assertSwiftScriptTypechecks(path.join(recordingScriptsDir, 'recording-trim.swift'));
  },
  SWIFT_TYPECHECK_TIMEOUT_MS,
);

test(
  'recording resize Swift script typechecks',
  async (t) => {
    if (process.platform !== 'darwin') {
      t.skip('Swift recording scripts are only validated on macOS');
    }

    await assertSwiftScriptTypechecks(path.join(recordingScriptsDir, 'recording-resize.swift'));
  },
  SWIFT_TYPECHECK_TIMEOUT_MS,
);

test(
  'recording inspect Swift script typechecks',
  async (t) => {
    if (process.platform !== 'darwin') {
      t.skip('Swift recording scripts are only validated on macOS');
    }

    await assertSwiftScriptTypechecks(
      path.join(recordingTestSupportDir, 'recording-inspect.swift'),
    );
  },
  SWIFT_TYPECHECK_TIMEOUT_MS,
);

test('recording overlays are explicitly unsupported on non-macOS hosts', () => {
  assert.equal(
    getRecordingOverlaySupportWarning('linux'),
    'touch overlay burn-in is only available on macOS hosts; returning raw video plus gesture telemetry',
  );
  assert.equal(getRecordingOverlaySupportWarning('darwin'), undefined);
});
