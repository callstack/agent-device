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
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { withRequestDeadline } from '@agent-device/host-kit/request';
import { runAndroidAutomationHelper } from './automation-helper.ts';
import { runAndroidSnapshotHelperSessionTouchCommand } from './snapshot-helper-session.ts';
import { ANDROID_EMULATOR } from './__tests__/test-utils/device-fixtures.ts';

function tap() {
  return runAndroidAutomationHelper(ANDROID_EMULATOR, {
    action: 'input',
    input: { kind: 'tap', x: 10, y: 20 },
  });
}

async function tapWithinRequestDeadline(remainingMs: number) {
  vi.mocked(runAndroidSnapshotHelperSessionTouchCommand).mockClear();
  await withDiagnosticsScope({ requestId: `budget-${remainingMs}` }, () =>
    withRequestDeadline(`budget-${remainingMs}`, remainingMs, async () => {
      await tap();
      return { ok: true } as unknown as DaemonResponse;
    }),
  );
  const [command] = vi.mocked(runAndroidSnapshotHelperSessionTouchCommand).mock.calls[0]!;
  const payload = JSON.parse(Buffer.from(command.payloadBase64!, 'base64').toString('utf8'));
  return { budgetMs: payload.budgetMs as number, timeoutMs: command.timeoutMs };
}

test('a request near its deadline sends the helper only what remains of it', async () => {
  const near = await tapWithinRequestDeadline(7_000);
  expect(near.timeoutMs).toBeLessThanOrEqual(7_000);
  expect(near.timeoutMs).toBeGreaterThan(6_000);
  expect(near.budgetMs).toBe(near.timeoutMs - 5_000);

  const exhausted = await tapWithinRequestDeadline(3_000);
  expect(exhausted.budgetMs).toBe(0);
});

test('input carries a press budget that ends before the host stops waiting for the helper', async () => {
  vi.mocked(runAndroidSnapshotHelperSessionTouchCommand).mockClear();
  await expect(tap()).resolves.toBe(true);

  const [command] = vi.mocked(runAndroidSnapshotHelperSessionTouchCommand).mock.calls[0]!;
  const payload = JSON.parse(Buffer.from(command.payloadBase64!, 'base64').toString('utf8'));
  expect(payload).toMatchObject({ kind: 'tap', x: 10, y: 20 });
  expect(payload.budgetMs).toBeGreaterThan(0);
  expect(payload.budgetMs).toBeLessThan(command.timeoutMs);
});
