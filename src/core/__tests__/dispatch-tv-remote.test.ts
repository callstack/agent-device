import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: vi.fn() };
});

import { dispatchCommand } from '../dispatch.ts';
import { runAppleRunnerCommand } from '../../platforms/apple/core/runner/runner-client.ts';
import { ANDROID_TV_DEVICE, TVOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { withMockedAdb } from '../../__tests__/test-utils/mocked-binaries.ts';

const mockRunAppleRunnerCommand = vi.mocked(runAppleRunnerCommand);

// R45 retired `tv-remote` from `DISPATCH_HANDLERS` and its dedicated handler function. Its
// ADB D-pad-keyevent parity pin now lives on `pressAndroidTvRemote` directly
// (`src/platforms/android/__tests__/input-actions.test.ts`); its tvOS runner routing is covered
// by the Apple interactor's own runner-provider suite
// (`src/platforms/apple/__tests__/interactor-runner-provider.test.ts`); its TV-target admission
// (formerly an in-handler check, now an owner fact) and admitted-runtime behavior are covered in
// `src/daemon/__tests__/tv-remote-runtime.test.ts`.
test('legacy dispatch no longer reaches the tv-remote leaf on Android TV', async () => {
  await withMockedAdb('agent-device-dispatch-tv-remote-retired-android-', async () => {
    await assert.rejects(dispatchCommand(ANDROID_TV_DEVICE, 'tv-remote', ['right']), {
      code: 'INVALID_ARGS',
      message: 'Unknown command: tv-remote',
    });
  });
});

test('legacy dispatch no longer reaches the tv-remote leaf on tvOS', async () => {
  await assert.rejects(dispatchCommand(TVOS_SIMULATOR, 'tv-remote', ['back']), {
    code: 'INVALID_ARGS',
    message: 'Unknown command: tv-remote',
  });
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});
