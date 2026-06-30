import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runIosRunnerCommand: vi.fn() };
});

import { dispatchCommand } from '../dispatch.ts';
import { runIosRunnerCommand } from '../../platforms/apple/core/runner/runner-client.ts';
import { ANDROID_EMULATOR, IOS_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { withMockedAdb } from '../../__tests__/test-utils/mocked-binaries.ts';

const mockRunIosRunnerCommand = vi.mocked(runIosRunnerCommand);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunIosRunnerCommand.mockResolvedValue({
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
  assert.equal(mockRunIosRunnerCommand.mock.calls.length, 1);
  assert.deepEqual(mockRunIosRunnerCommand.mock.calls[0]?.[1], {
    command: 'keyboardReturn',
    appBundleId: 'com.example.app',
  });
});
