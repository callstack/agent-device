import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, test, vi } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';
import {
  androidAdbResultError,
  withAndroidAdbProvider,
  type AndroidAdbExecutor,
} from '../adb-executor.ts';
import { completeAndroidFillVerification } from '../fill-verification.ts';
import { doubleTapAndroid, pressAndroid } from '../input-actions.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { fillAndroid, typeAndroid } from '../text-input.ts';
import { executeAndroidTouchHelperPlan } from '../touch-helper.ts';
import { lowerAndroidTouchPlan } from '../touch-plan-lowering.ts';
import {
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  createAndroidSnapshotHelperExecutor,
} from './test-utils/android-snapshot-helper.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { withFakeAdb } from './test-utils/fake-adb.ts';
import {
  ANDROID_TOUCH_HELPER_MANIFEST as manifest,
  androidTouchHelperResultRecord as resultRecord,
  currentVersionAdb,
  flingPlan,
  makeIsolatedDevice,
} from './touch-helper.fixtures.ts';

// contracts/fixtures/dispatch-disclosure.json, adb-input and one-shot helper rows: each drives the
// production entry point over a scripted adb and asserts the `details.dispatched` it fails with.

vi.mock('../helper-package-install.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helper-package-install.ts')>();
  return {
    ...actual,
    resolveAndroidHelperArtifact: vi.fn(async () => ({
      apkPath: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.apkPath,
      manifest: { ...manifest, sha256: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest.sha256 },
    })),
  };
});

beforeEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

function isShellInput(args: readonly string[], subcommand: 'tap' | 'text' | 'keyevent'): boolean {
  return args[0] === 'shell' && args[1] === 'input' && args[2] === subcommand;
}

async function tapWithAdbAnswer(answer: Error | { exitCode: number; stderr: string }) {
  await withFakeAdb(
    (args) => (isShellInput(args, 'tap') ? answer : undefined),
    async ({ device }) => await pressAndroid(device, 10, 20),
  );
}

async function doubleTapWithSecondTapRefused(): Promise<void> {
  let taps = 0;
  await withFakeAdb(
    (args) => {
      if (!isShellInput(args, 'tap')) return undefined;
      taps += 1;
      return taps === 2 ? new AppError('TOOL_MISSING', 'adb not found in PATH') : undefined;
    },
    async ({ device }) => await doubleTapAndroid(device, 10, 20),
  );
  assert.equal(taps, 2);
}

const HELPER_IME_ACTIVE = 'mInputShown=true mCurMethodId=com.callstack.agentdevice.imehelper/.Ime';

/** `type` on a device whose active input method is the helper IME, with the broadcast scripted. */
async function typeThroughHelperIme(broadcast: Error | { exitCode: number; stderr: string }) {
  let broadcasts = 0;
  await withFakeAdb(
    (args) => {
      if (args.includes('dumpsys') && args.includes('input_method')) return HELPER_IME_ACTIVE;
      if (!(args.includes('am') && args.includes('broadcast'))) return undefined;
      broadcasts += 1;
      return broadcast;
    },
    async ({ device }) => await typeAndroid(device, 'filed'),
  );
  assert.equal(broadcasts, 1);
}

async function typeFailingOnSecondChunk(): Promise<void> {
  let textChunks = 0;
  await withFakeAdb(
    (args) => {
      if (!isShellInput(args, 'text')) return undefined;
      textChunks += 1;
      return textChunks === 2 ? { exitCode: 1, stderr: 'error: device offline' } : undefined;
    },
    async ({ device }) => await typeAndroid(device, 'filed the expense'),
  );
}

async function typeLeadingNewlineWithoutAdb(): Promise<void> {
  await withFakeAdb(
    (args) =>
      isShellInput(args, 'text') || isShellInput(args, 'keyevent')
        ? new AppError('TOOL_MISSING', 'adb not found in PATH')
        : undefined,
    async ({ device }) => await typeAndroid(device, '\nfiled'),
  );
}

const FILL_MISMATCH_XML =
  '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="zzz" focused="true" bounds="[0,0][200,100]"/></hierarchy>';

/**
 * The first clear-and-retype pass types and reads back other text; the second pass's `input text`
 * then fails. Each capture advances the clock past the verification deadline, so the first pass
 * gives up after one sample instead of waiting the real deadline out.
 */
async function fillFailingInSecondPass(): Promise<void> {
  let offsetMs = 0;
  const realNow = Date.now.bind(Date);
  const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
  let textInputs = 0;
  const exec: AndroidAdbExecutor = async (args) => {
    const result = { exitCode: 0, stdout: '', stderr: '' };
    if (!isShellInput(args, 'text')) return result;
    textInputs += 1;
    if (textInputs < 2) return result;
    throw androidAdbResultError(`adb ${args.join(' ')} exited with code 1`, {
      exitCode: 1,
      stdout: '',
      stderr: 'error: device offline',
    });
  };
  try {
    await withAndroidAdbProvider(
      {
        exec: createAndroidSnapshotHelperExecutor({
          exec,
          captureXml: () => {
            offsetMs += 2_000;
            return FILL_MISMATCH_XML;
          },
        }),
        snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
      },
      { serial: ANDROID_EMULATOR.id },
      async () => {
        await fillAndroid(ANDROID_EMULATOR, 10, 10, 'filed');
      },
    );
  } finally {
    now.mockRestore();
    assert.equal(textInputs, 2);
  }
}

async function oneShotGesture(instrument: AndroidAdbExecutor): Promise<void> {
  const device = makeIsolatedDevice();
  await withAndroidAdbProvider(
    { exec: currentVersionAdb(instrument) },
    { serial: device.id },
    async () => await executeAndroidTouchHelperPlan(device, lowerAndroidTouchPlan(flingPlan())),
  );
}

const HELPER_REPORTED_FAILURE = resultRecord({
  ok: 'false',
  errorType: 'java.lang.IllegalStateException',
  message: 'injectInputEvent returned false',
});
const HELPER_RESULT = resultRecord({ ok: 'true', kind: 'swipe', injectedEvents: '4' });

/** The host adb's stderr for each refusal the classifier marks `hostRefusal`, keyed by row suffix. */
const HOST_REFUSAL_STDERR: Record<string, string> = {
  'device-unauthorized':
    "error: device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set",
  'device-offline': 'error: device offline',
  'multiple-devices': 'error: more than one device/emulator',
  'no-devices': 'adb: no devices/emulators found',
  'device-not-found': "error: device 'emulator-5554' not found",
};

const DRIVERS: Record<string, { drive: () => Promise<unknown>; dispatchedSteps?: number }> = {
  'android-adb.input-tap.tool-missing': {
    drive: () => tapWithAdbAnswer(new AppError('TOOL_MISSING', 'adb not found in PATH')),
  },
  'android-adb.input-tap.failed': {
    drive: () => tapWithAdbAnswer({ exitCode: 1, stderr: 'Killed' }),
  },
  'android-adb.input-tap.refusal-text-beside-other-output': {
    drive: () =>
      tapWithAdbAnswer({
        exitCode: 1,
        stderr: 'error: device offline\nKilled',
      }),
  },
  ...Object.fromEntries(
    Object.entries(HOST_REFUSAL_STDERR).map(([name, stderr]) => [
      `android-adb.input-tap.host-refused.${name}`,
      { drive: () => tapWithAdbAnswer({ exitCode: 1, stderr }) },
    ]),
  ),
  'android-adb.input-tap.double-tap-second-refused': {
    drive: doubleTapWithSecondTapRefused,
    dispatchedSteps: 1,
  },
  'android-helper.ime.broadcast-tool-missing': {
    drive: () => typeThroughHelperIme(new AppError('TOOL_MISSING', 'adb not found in PATH')),
  },
  'android-helper.ime.broadcast-failed': {
    drive: () => typeThroughHelperIme({ exitCode: 1, stderr: 'Broadcast failed' }),
  },
  'android-adb.input-text.failed-after-chunk': {
    drive: typeFailingOnSecondChunk,
    dispatchedSteps: 1,
  },
  'android-adb.input-text.tool-missing-before-first-input': {
    drive: typeLeadingNewlineWithoutAdb,
  },
  'android-adb.fill.second-pass-input-failed': {
    drive: fillFailingInSecondPass,
    dispatchedSteps: 2,
  },
  'android-adb.fill.unverified': {
    drive: async () =>
      completeAndroidFillVerification('filed the expense', null, {
        ok: false,
        actual: 'filed the',
        reason: 'text_mismatch',
        targetInput: null,
        actualInput: null,
      }),
  },
  'android-helper.gesture.reported-failure': {
    drive: () =>
      oneShotGesture(async () => ({ exitCode: 0, stdout: HELPER_REPORTED_FAILURE, stderr: '' })),
  },
  'android-helper.gesture.failed-after-result': {
    drive: () => oneShotGesture(async () => ({ exitCode: 1, stdout: HELPER_RESULT, stderr: '' })),
  },
  'android-helper.gesture.host-refused': {
    drive: () =>
      oneShotGesture(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'error: device unauthorized.',
      })),
  },
  'android-helper.gesture.no-parseable-output': {
    drive: () => oneShotGesture(async () => ({ exitCode: 1, stdout: '', stderr: 'boom' })),
  },
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every adb-input and one-shot helper dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DRIVERS));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const driver = DRIVERS[row.id];
    assert.ok(driver, `no driver for ${row.id}`);
    await assert.rejects(driver.drive(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, row.dispatched);
      assert.equal(error.details?.dispatchedSteps, driver.dispatchedSteps);
      return true;
    });
  });
}
