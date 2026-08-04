import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: vi.fn() };
});

import { dispatchCommand } from '../dispatch.ts';
import { runAppleRunnerCommand } from '../../platforms/apple/core/runner/runner-client.ts';
import { ANDROID_EMULATOR, IOS_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { withMockedAdb } from '../../__tests__/test-utils/mocked-binaries.ts';

const mockRunAppleRunnerCommand = vi.mocked(runAppleRunnerCommand);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunAppleRunnerCommand.mockResolvedValue({
    message: 'keyboardReturn',
    wasVisible: true,
    visible: false,
  });
});

test('dispatch keyboard enter sends Android ENTER keyevent', async () => {
  await withMockedAdb('agent-device-dispatch-keyboard-enter-', async (argsLogPath) => {
    const result = await dispatchCommand(ANDROID_EMULATOR, 'keyboard', ['enter']);

    assert.equal(result?.action, 'enter');
    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.match(logged, /shell\ninput\nkeyevent\nENTER/);
  });
});

test('dispatch keyboard enter sends native iOS keyboard return command', async () => {
  const result = await dispatchCommand(IOS_DEVICE, 'keyboard', ['return'], undefined, {
    appBundleId: 'com.example.app',
  });

  assert.equal(result?.action, 'enter');
  assert.equal(result?.wasVisible, true);
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'keyboardReturn',
    appBundleId: 'com.example.app',
  });
});

// #1598: the response must disclose which mechanism the runner used to
// resign the keyboard — only the keyboard's own dismiss key is a mechanism the runner vouches for; an unrecognized wire value must degrade to the bare message rather than a false claim. The safe-area tap was removed (#1606 review):
// different reliability guarantees, and the CLI/SDK message must say which
// one actually fired rather than a bare "dismissed".
test('dispatch keyboard dismiss surfaces the dismissKey mechanism and message', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({
    message: 'keyboardDismiss',
    wasVisible: true,
    visible: false,
    dismissed: true,
    keyboardDismissMechanism: 'dismissKey',
  });

  const result = await dispatchCommand(IOS_DEVICE, 'keyboard', ['dismiss'], undefined, {
    appBundleId: 'com.example.app',
  });

  assert.equal(result?.action, 'dismiss');
  assert.equal(result?.dismissed, true);
  assert.equal(result?.mechanism, 'dismissKey');
  assert.equal(result?.message, 'Keyboard dismissed via its dismiss key');
});

test('dispatch keyboard dismiss degrades an unrecognized mechanism to the bare message', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({
    message: 'keyboardDismiss',
    wasVisible: true,
    visible: false,
    dismissed: true,
    keyboardDismissMechanism: 'legacySafeAreaTap',
  });

  const result = await dispatchCommand(IOS_DEVICE, 'keyboard', ['dismiss'], undefined, {
    appBundleId: 'com.example.app',
  });

  assert.equal(result?.mechanism, 'legacySafeAreaTap');
  assert.equal(String(result?.message), 'Keyboard dismissed');
});

test('dispatch keyboard dismiss omits mechanism when every mechanism failed', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({
    message: 'keyboardDismiss',
    wasVisible: true,
    visible: true,
    dismissed: false,
  });

  const result = await dispatchCommand(IOS_DEVICE, 'keyboard', ['dismiss'], undefined, {
    appBundleId: 'com.example.app',
  });

  assert.equal(result?.dismissed, false);
  assert.equal(result?.mechanism, undefined);
  assert.equal(result?.message, 'Keyboard already hidden');
});

test('dispatch keyboard dismiss omits mechanism when the keyboard was never visible', async () => {
  mockRunAppleRunnerCommand.mockResolvedValue({
    message: 'keyboardDismiss',
    wasVisible: false,
    visible: false,
    dismissed: false,
  });

  const result = await dispatchCommand(IOS_DEVICE, 'keyboard', ['dismiss'], undefined, {
    appBundleId: 'com.example.app',
  });

  assert.equal(result?.wasVisible, false);
  assert.equal(result?.mechanism, undefined);
  assert.equal(result?.message, 'Keyboard already hidden');
});
