import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

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

// R44 retired `orientation` from `DISPATCH_HANDLERS`. Its ADB-command-level parity pin now lives
// on `setAndroidOrientation` directly (`src/platforms/android/__tests__/input-actions.test.ts`);
// its iOS runner routing (including the mismatched-readback rejection) is covered by the Apple
// interactor's own runner-provider suite
// (`src/platforms/apple/__tests__/interactor-runner-provider.test.ts`); its admitted-runtime
// behavior is covered in `src/daemon/__tests__/orientation-runtime.test.ts`.
test('legacy dispatch no longer reaches the orientation leaf on Android', async () => {
  await withMockedAdb('agent-device-dispatch-orientation-retired-android-', async () => {
    await assert.rejects(dispatchCommand(ANDROID_EMULATOR, 'orientation', ['left']), {
      code: 'INVALID_ARGS',
      message: 'Unknown command: orientation',
    });
  });
});

test('legacy dispatch no longer reaches the orientation leaf on iOS', async () => {
  await assert.rejects(dispatchCommand(IOS_DEVICE, 'orientation', ['left']), {
    code: 'INVALID_ARGS',
    message: 'Unknown command: orientation',
  });
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});
