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

// R46 retired `keyboard` from `DISPATCH_HANDLERS` and its dedicated
// `handleAndroidKeyboardCommand`/`handleHarmonyKeyboardCommand`/`handleIosKeyboardCommand`
// helpers. Its ADB ENTER-keyevent parity pin now lives on `pressAndroidEnter` directly
// (`src/platforms/android/__tests__/input-actions.test.ts`); its iOS runner routing (including
// the dismiss-mechanism disclosure and degradation cases) is covered by the Apple interactor's
// own runner-provider suite (`src/platforms/apple/__tests__/interactor-runner-provider.test.ts`)
// and by `src/daemon/__tests__/keyboard-runtime.test.ts`, which also covers the admitted-runtime
// action-selection and per-platform response shapes.
test('legacy dispatch no longer reaches the keyboard leaf on Android', async () => {
  await withMockedAdb('agent-device-dispatch-keyboard-retired-android-', async (argsLogPath) => {
    await assert.rejects(dispatchCommand(ANDROID_EMULATOR, 'keyboard', ['enter']), {
      code: 'INVALID_ARGS',
      message: 'Unknown command: keyboard',
    });

    const { promises: fs } = await import('node:fs');
    await assert.rejects(
      fs.readFile(argsLogPath, 'utf8'),
      { code: 'ENOENT' },
      'no adb command was ever issued, so the args log was never created',
    );
  });
});

test('legacy dispatch no longer reaches the keyboard leaf on iOS', async () => {
  await assert.rejects(
    dispatchCommand(IOS_DEVICE, 'keyboard', ['dismiss'], undefined, {
      appBundleId: 'com.example.app',
    }),
    {
      code: 'INVALID_ARGS',
      message: 'Unknown command: keyboard',
    },
  );
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});
