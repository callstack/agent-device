import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv, type ShellWord } from '@agent-device/kernel/device-shell';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { button, node, text } from './alert-fixtures.ts';

const runAndroidAdb = vi.fn(async (_device: DeviceInfo, _args: readonly string[]) => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
}));
const runAndroidShell = vi.fn(
  async (device: DeviceInfo, words: ShellWord[]) =>
    await runAndroidAdb(device, deviceShellArgv('adb', 'shell', words)),
);
vi.mock('../adb.ts', () => ({ runAndroidAdb, runAndroidShell }));

const { handleAndroidAlert } = await import('../alert.ts');

const dialog = [
  node(0, 'android.app.AlertDialog'),
  text(1, 'Automation confirmation', 'android:id/alertTitle'),
  button(2, 'Cancel', 'android:id/button2', { x: 210, y: 612 }),
];

/** Runs an alert action whose polls sleep between captures, without waiting the sleeps out. */
async function underFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const outcome = run();
    outcome.catch(() => {});
    await vi.runAllTimersAsync();
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

/** The dialog is in the tree until the button press lands, then gone — the real timeline. */
function dialogUntilPressed(nodes = dialog) {
  return async () => (runAndroidAdb.mock.calls.length === 0 ? nodes : []);
}

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

test('dismissing a button alert records the tapped button and its coordinates', async () => {
  runAndroidAdb.mockClear();
  const result = await handleAndroidAlert(device, 'dismiss', {
    captureNodes: dialogUntilPressed(),
  });

  assert.deepEqual(result, {
    kind: 'alertHandled',
    platform: 'android',
    action: 'dismiss',
    handled: true,
    alert: {
      title: 'Automation confirmation',
      buttons: ['Cancel'],
      platform: 'android',
      source: 'native-dialog',
      packageName: 'com.example.app',
    },
    button: 'Cancel',
    coordinates: { x: 274, y: 638 },
    message: 'Alert dismissed',
  });
  assert.deepEqual(runAndroidAdb.mock.calls[0]?.[1], ['shell', 'input', 'tap', '274', '638']);
});

test('accepting a button alert records the tapped button and its coordinates', async () => {
  runAndroidAdb.mockClear();
  const result = await handleAndroidAlert(device, 'accept', {
    captureNodes: dialogUntilPressed([
      node(0, 'android.app.AlertDialog'),
      text(1, 'Automation confirmation', 'android:id/alertTitle'),
      button(2, 'OK', 'android:id/button1', { x: 52, y: 612 }),
    ]),
  });

  assert.equal(result.kind, 'alertHandled');
  assert.deepEqual('coordinates' in result ? result.coordinates : undefined, { x: 116, y: 638 });
});

test('accepting the Android 11+ permission sheet taps the preferred grant once', async () => {
  runAndroidAdb.mockClear();
  // The regression the maintainer asked for at the action seam: both permission_allow_* ids
  // classify accept, and the shared preference table must land one tap on the lasting grant.
  const sheet = [
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.google.android.permissioncontroller',
    }),
    text(
      1,
      'Allow Probe to access location in the background?',
      'com.android.permissioncontroller:id/permission_message',
    ),
    button(
      2,
      'While using the app',
      'permission_allow_foreground_only_button',
      { x: 32, y: 1420 },
      true,
    ),
    button(3, 'Only this time', 'permission_allow_one_time_button', { x: 32, y: 1490 }, true),
    button(4, 'Deny', 'permission_deny_button', { x: 32, y: 1560 }, true),
  ];
  const result = await handleAndroidAlert(device, 'accept', {
    captureNodes: dialogUntilPressed(sheet),
  });

  assert.equal(result.kind, 'alertHandled');
  assert.equal(result.kind === 'alertHandled' ? result.button : undefined, 'While using the app');
  assert.deepEqual('coordinates' in result ? result.coordinates : undefined, { x: 96, y: 1446 });
  assert.equal(runAndroidAdb.mock.calls.filter(([, args]) => args.includes('tap')).length, 1);
});

test('a fallback Back dismissal (no matching button) carries no coordinates', async () => {
  runAndroidAdb.mockClear();
  const result = await handleAndroidAlert(device, 'dismiss', {
    captureNodes: dialogUntilPressed([
      node(0, 'android.app.AlertDialog'),
      text(1, 'Automation confirmation', 'android:id/alertTitle'),
    ]),
  });

  assert.equal(result.kind, 'alertHandled');
  assert.ok(result.kind === 'alertHandled' && !('coordinates' in result));
  assert.equal(result.kind === 'alertHandled' ? result.button : undefined, 'Back');
  assert.deepEqual(runAndroidAdb.mock.calls[0]?.[1], ['shell', 'input', 'keyevent', '4']);
});

test('dismiss returns only after the dialog has left the tree', async () => {
  runAndroidAdb.mockClear();
  // Pre-press lookup, then two captures that still show the closing dialog, then the app.
  const captures = [dialog, dialog, dialog, []];
  let reads = 0;
  const result = await underFakeTimers(
    async () =>
      await handleAndroidAlert(device, 'dismiss', {
        captureNodes: async () => captures[Math.min(reads++, captures.length - 1)] ?? [],
      }),
  );

  assert.equal(result.kind, 'alertHandled');
  assert.equal(reads, 4);
  assert.equal(runAndroidAdb.mock.calls.length, 1);
});

test('a different alert replacing the pressed one counts as dismissed', async () => {
  runAndroidAdb.mockClear();
  const followUp = [
    node(0, 'android.app.AlertDialog'),
    text(1, 'Discard changes?', 'android:id/alertTitle'),
    button(2, 'Keep', 'android:id/button2', { x: 210, y: 612 }),
  ];
  const result = await handleAndroidAlert(device, 'dismiss', {
    captureNodes: async () => (runAndroidAdb.mock.calls.length === 0 ? dialog : followUp),
  });

  assert.equal(result.kind, 'alertHandled');
  assert.equal(
    result.kind === 'alertHandled' ? result.alert.title : undefined,
    'Automation confirmation',
  );
});

test('dismiss fails when the dialog is still visible after the action budget', async () => {
  runAndroidAdb.mockClear();
  await assert.rejects(
    underFakeTimers(
      async () => await handleAndroidAlert(device, 'dismiss', { captureNodes: async () => dialog }),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'alert dismiss did not dismiss the visible alert' &&
      (error as { code?: string }).code === 'COMMAND_FAILED',
  );
  assert.equal(runAndroidAdb.mock.calls.length, 1);
});

test('wait with a spent budget still reports an alert that is already visible', async () => {
  const result = await handleAndroidAlert(device, 'wait', {
    timeoutMs: 0,
    captureNodes: async () => dialog,
  });

  assert.equal(result.kind, 'alertWait');
  assert.equal(result.alert?.title, 'Automation confirmation');
});

test('the read-first capture rides the caller cancellation and dies with it', async () => {
  // Android's transport is cancellable, so the invariant here is the actual child-process cut:
  // the capture seam receives the leg's live AbortSignal, and aborting the caller cuts the
  // in-flight capture before any press exists.
  runAndroidAdb.mockClear();
  const caller = new AbortController();
  const seamSignals: AbortSignal[] = [];
  let rejectCapture: ((error: Error) => void) | undefined;
  const result = handleAndroidAlert(device, 'dismiss', {
    signal: caller.signal,
    captureNodes: (seam) =>
      new Promise<RawSnapshotNode[]>((_resolve, reject) => {
        seamSignals.push(seam.signal);
        rejectCapture = reject;
        seam.signal.addEventListener('abort', () => reject(new Error('adb killed')), {
          once: true,
        });
      }),
  });
  result.catch(() => {});
  await Promise.resolve();
  caller.abort();
  rejectCapture?.(new Error('adb killed'));

  await assert.rejects(result, (error: unknown) => isRequestCanceledError(error));
  assert.equal(seamSignals.length, 1);
  assert.equal(seamSignals[0]?.aborted, true);
  assert.equal(runAndroidAdb.mock.calls.length, 0);
});

test('a slow first read is not cut off by its own action budget', async () => {
  // The Android smoke timeline: the session's first capture pays the snapshot-helper cold
  // start (install + session bring-up), landing well past the 2s action budget. That read is
  // the leg's read-first observation — consumed whatever it costs — and the press rides the
  // window it arms behind it. Without the read-first exemption this is the executed CI
  // failure: `alert-window-expired, dispatched: no` with the dialog plainly on screen.
  runAndroidAdb.mockClear();
  let reads = 0;
  const slowWarmRead = async () => {
    reads += 1;
    if (reads > 1) return runAndroidAdb.mock.calls.length === 0 ? dialog : [];
    // 2.5 driven seconds: past the 2s lookup window the old guarded first probe enforced.
    await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
    return dialog;
  };

  const result = await underFakeTimers(
    async () => await handleAndroidAlert(device, 'dismiss', { captureNodes: slowWarmRead }),
  );

  assert.equal(result.kind, 'alertHandled');
  assert.equal(runAndroidAdb.mock.calls.length, 1);
});
