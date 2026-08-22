import { test } from 'vitest';
import assert from 'node:assert/strict';
import { dispatchCommand } from '../dispatch.ts';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { withMockedAdb } from '../../__tests__/test-utils/mocked-binaries.ts';

// R42 retired `back` from `DISPATCH_HANDLERS`; its ADB-command-level parity pin now lives on
// `backAndroid` directly (`src/platforms/android/__tests__/input-actions.test.ts`), and its
// admitted-runtime behavior in `src/daemon/__tests__/back-runtime.test.ts`.
test('legacy dispatch no longer reaches the back leaf', async () => {
  await withMockedAdb('agent-device-dispatch-back-retired-', async (argsLogPath) => {
    await assert.rejects(
      dispatchCommand(ANDROID_EMULATOR, 'back', [], undefined, { backMode: 'in-app' }),
      { code: 'INVALID_ARGS', message: 'Unknown command: back' },
    );

    const { promises: fs } = await import('node:fs');
    await assert.rejects(
      fs.readFile(argsLogPath, 'utf8'),
      { code: 'ENOENT' },
      'no adb command was ever issued, so the args log was never created',
    );
  });
});
