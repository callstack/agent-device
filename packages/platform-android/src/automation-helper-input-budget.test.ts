import { expect, test, vi } from 'vitest';

vi.mock('./snapshot-helper-session-lifecycle.ts', () => ({
  getLiveAndroidSnapshotHelperSession: () => ({ commands: new Set(['input']) }),
  stopAndroidSnapshotHelperSession: vi.fn(),
}));
vi.mock('./automation-helper-artifact.ts', () => ({
  prepareAndroidAutomationHelper: vi.fn(async () => ({ artifact: {} })),
  androidAutomationHelperIdentity: vi.fn(() => ({})),
}));
vi.mock('./snapshot-helper-session.ts', () => ({
  runAndroidSnapshotHelperSessionTouchCommand: vi.fn(async () => ({ ok: 'true' })),
}));
import { runAndroidAutomationHelper } from './automation-helper.ts';
import { runAndroidSnapshotHelperSessionTouchCommand } from './snapshot-helper-session.ts';
import { ANDROID_EMULATOR } from './__tests__/test-utils/device-fixtures.ts';

test('input carries a press budget that ends before the host stops waiting for the helper', async () => {
  await expect(
    runAndroidAutomationHelper(ANDROID_EMULATOR, {
      action: 'input',
      input: { kind: 'tap', x: 10, y: 20 },
    }),
  ).resolves.toBe(true);

  const [command] = vi.mocked(runAndroidSnapshotHelperSessionTouchCommand).mock.calls[0]!;
  const payload = JSON.parse(Buffer.from(command.payloadBase64!, 'base64').toString('utf8'));
  expect(payload).toMatchObject({ kind: 'tap', x: 10, y: 20 });
  expect(payload.budgetMs).toBeGreaterThan(0);
  expect(payload.budgetMs).toBeLessThan(command.timeoutMs);
});
