import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { underFakeTimers } from './test-utils/fake-timers.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceShellArgv, type ShellWord } from '@agent-device/kernel/device-shell';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { button, node, text } from './alert-fixtures.ts';

type FakeShellOptions = { signal?: AbortSignal };
const runAndroidAdb = vi.fn(
  async (_device: DeviceInfo, _args: readonly string[], _options?: FakeShellOptions) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }),
);
const runAndroidShell = vi.fn(
  async (device: DeviceInfo, words: ShellWord[], options?: FakeShellOptions) =>
    await runAndroidAdb(device, deviceShellArgv('adb', 'shell', words), options),
);
vi.mock('../adb.ts', () => ({ runAndroidAdb, runAndroidShell }));

const { handleAndroidAlert } = await import('../alert.ts');

const dialog = [
  node(0, 'android.app.AlertDialog'),
  text(1, 'Automation confirmation', 'android:id/alertTitle'),
  button(2, 'Cancel', 'android:id/button2', { x: 210, y: 612 }),
];

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

test('accepting the Android 14+ partial-media sheet taps "Allow all" once', async () => {
  runAndroidAdb.mockClear();
  // The media-sheet regression at the action seam: "Allow all" and "Select photos and videos"
  // both classify accept, and only the declared id scale orders them; the tap must land on the
  // lasting grant exactly once.
  const sheet = [
    node(0, 'android.widget.FrameLayout', {
      bundleId: 'com.google.android.permissioncontroller',
    }),
    text(
      1,
      'Allow Probe to access photos and videos on your device?',
      'com.android.permissioncontroller:id/permission_message',
    ),
    button(2, 'Allow all', 'permission_allow_all_button', { x: 32, y: 1420 }, true),
    button(
      3,
      'Select photos and videos',
      'permission_allow_selected_button',
      {
        x: 32,
        y: 1490,
      },
      true,
    ),
    button(4, "Don't allow", 'permission_deny_button', { x: 32, y: 1560 }, true),
  ];
  const result = await handleAndroidAlert(device, 'accept', {
    captureNodes: dialogUntilPressed(sheet),
  });

  assert.equal(result.kind, 'alertHandled');
  assert.equal(result.kind === 'alertHandled' ? result.button : undefined, 'Allow all');
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

const unknownGrantSheet = [
  node(0, 'android.widget.FrameLayout', { bundleId: 'com.vendor.permissioncontroller' }),
  text(1, 'Allow Probe?', 'com.android.permissioncontroller:id/permission_message'),
  button(
    2,
    'Allow everything and sync',
    'com.vendor.permissioncontroller:id/permission_allow_everything_button',
    { x: 32, y: 1420 },
    false,
  ),
];

test('accept never taps an undeclared grant that stands alone', async () => {
  // The action-seam certificate for the maintainer's literal rule: the sole button is an
  // allow-shaped id no slot declares with an affirmative-looking label. The refusal must reach
  // the real seam as alert_button_undecided with dispatched: no and zero adb calls — the
  // single-button-dialog fallback may not re-admit it.
  runAndroidAdb.mockClear();
  await assert.rejects(
    handleAndroidAlert(device, 'accept', { captureNodes: async () => unknownGrantSheet }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { details?: { reason?: unknown; dispatched?: unknown } }).details?.reason ===
        'alert_button_undecided' &&
      (error as { details?: { dispatched?: unknown } }).details?.dispatched === 'no',
  );
  assert.equal(runAndroidAdb.mock.calls.length, 0);
});

test('dismiss of an undeclared grant sheet falls back to Back and taps nothing', async () => {
  // The undeclared deny-side twin: with no declared leaving choice to name, dismiss answers the
  // same way a buttonless dialog does — the Back key, which Android treats as the cancel that
  // grants nothing — never a tap at the unranked grant's coordinates.
  runAndroidAdb.mockClear();
  const result = await handleAndroidAlert(device, 'dismiss', {
    captureNodes: dialogUntilPressed(unknownGrantSheet),
  });

  assert.equal(result.kind, 'alertHandled');
  assert.equal(result.kind === 'alertHandled' ? result.button : undefined, 'Back');
  assert.deepEqual(runAndroidAdb.mock.calls[0]?.[1], ['shell', 'input', 'keyevent', '4']);
  assert.equal(runAndroidAdb.mock.calls.filter(([, args]) => args.includes('tap')).length, 0);
});

test('dismiss of an unknown deny-shaped grant falls back to Back instead of pressing it', async () => {
  // The decline-side shape the review probed: a fork's own deny id alone with decline-shaped
  // copy. Old main pressed it; under the declaration rule it names no role, so dismiss takes
  // the Back key like any dialog with no nameable leaving choice — never a tap the fork's
  // unranked id would direct.
  runAndroidAdb.mockClear();
  const result = await handleAndroidAlert(device, 'dismiss', {
    captureNodes: dialogUntilPressed([
      node(0, 'android.widget.FrameLayout', { bundleId: 'com.vendor.permissioncontroller' }),
      text(1, 'Allow Probe?', 'com.android.permissioncontroller:id/permission_message'),
      button(
        2,
        'Never allow',
        'com.vendor.permissioncontroller:id/permission_deny_and_block_button',
        { x: 32, y: 1420 },
        false,
      ),
    ]),
  });

  assert.equal(result.kind, 'alertHandled');
  assert.equal(result.kind === 'alertHandled' ? result.button : undefined, 'Back');
  assert.equal(runAndroidAdb.mock.calls.filter(([, args]) => args.includes('tap')).length, 0);
});

test('accept refuses beside an undeclared grant even when a declared grant stands beside it', async () => {
  // Known + unknown at the seam: the sheet holds the real permission_allow_all_button AND a
  // fork's own grant id. The press would have landed on the lasting grant; the undeclared
  // grant stays represented and the whole sheet refuses with zero taps.
  runAndroidAdb.mockClear();
  await assert.rejects(
    handleAndroidAlert(device, 'accept', {
      captureNodes: async () => [
        node(0, 'android.widget.FrameLayout', {
          bundleId: 'com.google.android.permissioncontroller',
        }),
        text(
          1,
          '¿Permitir que Probe acceda a tus fotos?',
          'com.android.permissioncontroller:id/permission_message',
        ),
        button(2, 'Permitir todo', 'permission_allow_all_button', { x: 32, y: 1420 }, true),
        button(
          3,
          'Permitir con sincronización',
          'com.vendor.permissioncontroller:id/permission_allow_with_sync_button',
          { x: 32, y: 1490 },
          false,
        ),
        button(4, 'No permitir', 'permission_deny_button', { x: 32, y: 1560 }, true),
      ],
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { details?: { reason?: unknown; dispatched?: unknown } }).details?.reason ===
        'alert_button_undecided' &&
      (error as { details?: { dispatched?: unknown } }).details?.dispatched === 'no',
  );
  assert.equal(runAndroidAdb.mock.calls.length, 0);
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
      (error as { code?: string }).code === 'COMMAND_FAILED' &&
      (error as { details?: { reason?: unknown } }).details?.reason === 'alert-window-expired',
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

test('a caller cancel during the press discloses that the tap may or may not have landed', async () => {
  // The one dispatched-unknown exit: the budget never stops a press, so the only way a press
  // dies mid-flight is the caller's own cancellation. The adb child is killed between the tap's
  // dispatch and its rejection, so the device may already have received it — the cancellation
  // carries that typed, never a clean 'no'. The fake reacts to its seam signal the way the adb
  // executor does — a child killed on abort — and the caller speaks only after the tap is
  // verifiably in flight, so the test exercises the mid-press cut, not a pre-aborted shortcut.
  runAndroidAdb.mockClear();
  const caller = new AbortController();
  const tapSignals: (AbortSignal | undefined)[] = [];
  let markTapStarted!: () => void;
  const tapStarted = new Promise<void>((resolve) => {
    markTapStarted = resolve;
  });
  runAndroidAdb.mockImplementationOnce(async (_device, args, options) => {
    if (args.includes('tap')) {
      tapSignals.push(options?.signal);
      await new Promise<void>((_resolve, reject) => {
        markTapStarted();
        options?.signal?.addEventListener('abort', () => reject(new Error('adb killed')), {
          once: true,
        });
      });
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  const result = handleAndroidAlert(device, 'dismiss', {
    signal: caller.signal,
    captureNodes: dialogUntilPressed(),
  });
  result.catch(() => {});
  await tapStarted;
  caller.abort();

  await assert.rejects(
    result,
    (error: unknown) =>
      isRequestCanceledError(error) &&
      (error as { details?: { dispatched?: unknown } }).details?.dispatched === 'unknown',
  );
  assert.equal(tapSignals.length, 1);
  assert.equal(tapSignals[0]?.aborted, true);
});

test('a quiet screen with captures straddling the lookup answers alert-not-found', async () => {
  // The maintainer's budget-rule pin: ~900 ms captures against the 2 s lookup, so the probe
  // that starts at 1.2 s cannot answer before the deadline. The deadline ends the loop, it
  // does not cancel the started capture, and a window that only ever answered quiet is absence
  // — never the old timing-dependent `alert-window-expired` this timeline used to throw at
  // the straddling probe.
  runAndroidAdb.mockClear();
  const quietWithSlowCaptures = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 900));
    return [];
  };

  await assert.rejects(
    underFakeTimers(
      async () =>
        await handleAndroidAlert(device, 'dismiss', { captureNodes: quietWithSlowCaptures }),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'alert not found' &&
      (error as { details?: { reason?: unknown; dispatched?: unknown } }).details?.reason ===
        'alert-not-found' &&
      (error as { details?: { dispatched?: unknown } }).details?.dispatched === 'no',
  );
  assert.equal(runAndroidAdb.mock.calls.length, 0);
});

test('the read-first capture rides the caller cancellation and dies with it', async () => {
  // Android's transport is cancellable, so the invariant here is the actual child-process cut:
  // the capture seam receives the leg's live AbortSignal, and aborting the caller cuts the
  // in-flight capture before any press exists. The caller speaks only after the capture is
  // verifiably started, so the seam is on the in-flight path rather than a pre-aborted short
  // circuit.
  runAndroidAdb.mockClear();
  const caller = new AbortController();
  const seamSignals: AbortSignal[] = [];
  let rejectCapture: ((error: Error) => void) | undefined;
  let markCaptureStarted!: () => void;
  const captureStarted = new Promise<void>((resolve) => {
    markCaptureStarted = resolve;
  });
  const result = handleAndroidAlert(device, 'dismiss', {
    signal: caller.signal,
    captureNodes: (seam) =>
      new Promise<RawSnapshotNode[]>((_resolve, reject) => {
        seamSignals.push(seam.signal);
        rejectCapture = reject;
        markCaptureStarted();
        seam.signal.addEventListener('abort', () => reject(new Error('adb killed')), {
          once: true,
        });
      }),
  });
  result.catch(() => {});
  await captureStarted;
  caller.abort();
  rejectCapture?.(new Error('adb killed'));

  await assert.rejects(
    result,
    (error: unknown) =>
      isRequestCanceledError(error) &&
      (error as { details?: { dispatched?: unknown } }).details?.dispatched === 'no',
  );
  assert.equal(seamSignals.length, 1);
  assert.equal(seamSignals[0]?.aborted, true);
  assert.equal(runAndroidAdb.mock.calls.length, 0);
});

test('a slow first read is never cut off by its own action budget', async () => {
  // The Android smoke timeline: the session's first capture pays the snapshot-helper cold
  // start (install + session bring-up), landing well past the 2s action budget. Under the
  // budget rule the deadline only ends the polling loop — every probe that started inside the
  // window finishes and its answer counts — so this read resolves the alert and the press
  // rides only the caller's cancellation. Before the rule, this was the executed CI failure:
  // `alert-window-expired, dispatched: no` with the dialog plainly on screen.
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
