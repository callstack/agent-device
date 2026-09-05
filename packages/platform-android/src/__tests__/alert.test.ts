import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { button, node, text } from './alert-fixtures.ts';

const runAndroidAdb = vi.fn(async (_device: DeviceInfo, _args: string[]) => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
}));
vi.mock('../adb.ts', () => ({ runAndroidAdb }));
// The dismissal re-check polls at the contract interval; the clock is the assertion, not the wait.
vi.mock('@agent-device/host-kit/retry', () => ({ sleep: async () => {} }));

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
  const result = await handleAndroidAlert(device, 'dismiss', {
    captureNodes: async () => captures[Math.min(reads++, captures.length - 1)] ?? [],
  });

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
  vi.useFakeTimers({ now: 0, toFake: ['Date'] });
  try {
    let reads = 0;
    await assert.rejects(
      handleAndroidAlert(device, 'dismiss', {
        captureNodes: async () => {
          // Every post-press capture costs wall clock; the dialog never leaves.
          if (reads++ > 0) vi.setSystemTime(Date.now() + 700);
          return dialog;
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'alert dismiss did not dismiss the visible alert' &&
        (error as { code?: string }).code === 'COMMAND_FAILED',
    );
    assert.equal(runAndroidAdb.mock.calls.length, 1);
    assert.ok(
      reads >= 4,
      `expected the re-check to poll until the budget expired, got ${reads} reads`,
    );
  } finally {
    vi.useRealTimers();
  }
});
