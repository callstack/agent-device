import { expect, test, vi } from 'vitest';

vi.mock('./snapshot-helper-session-lifecycle.ts', () => ({
  getLiveAndroidSnapshotHelperSession: () => ({ commands: new Set(['snapshot']) }),
  stopAndroidSnapshotHelperSession: vi.fn(),
}));
vi.mock('./automation-helper-artifact.ts', () => ({
  prepareAndroidAutomationHelper: vi.fn(() => {
    throw new Error('An unsupported command must not prepare or replace the helper');
  }),
  androidAutomationHelperIdentity: vi.fn(),
}));
import { runAndroidAutomationHelper } from './automation-helper.ts';
import { prepareAndroidAutomationHelper } from './automation-helper-artifact.ts';
import { ANDROID_EMULATOR } from './__tests__/test-utils/device-fixtures.ts';

test('an older helper is not sent unadvertised input, screenshot, or focus commands', async () => {
  for (const action of ['input', 'screenshot', 'focus'] as const) {
    await expect(runAndroidAutomationHelper(ANDROID_EMULATOR, action)).resolves.toBeUndefined();
  }
  expect(prepareAndroidAutomationHelper).not.toHaveBeenCalled();
});
