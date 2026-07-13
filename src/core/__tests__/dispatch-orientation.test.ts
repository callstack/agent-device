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
  mockRunAppleRunnerCommand.mockResolvedValue({ message: 'rotate', orientation: 'landscape-left' });
});

test('dispatch orientation normalizes value aliases before Android execution', async () => {
  await withMockedAdb('agent-device-dispatch-orientation-android-', async (argsLogPath) => {
    const result = await dispatchCommand(ANDROID_EMULATOR, 'orientation', ['left']);

    assert.equal(result?.action, 'orientation');
    assert.equal(result?.orientation, 'landscape-left');

    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.match(logged, /shell\nsettings\nput\nsystem\naccelerometer_rotation\n0/);
    assert.match(logged, /shell\nsettings\nput\nsystem\nuser_rotation\n1/);
  });
});

test('dispatch orientation sends normalized orientation to the iOS runner', async () => {
  const result = await dispatchCommand(IOS_DEVICE, 'orientation', ['right'], undefined, {
    appBundleId: 'com.example.app',
  });

  assert.equal(result?.action, 'orientation');
  assert.equal(result?.orientation, 'landscape-right');
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    // `rotate` is the runner-protocol command name; the CLI command is `orientation`.
    command: 'rotate',
    orientation: 'landscape-right',
    appBundleId: 'com.example.app',
  });
});
