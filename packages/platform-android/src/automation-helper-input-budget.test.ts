import { beforeEach, expect, test, vi } from 'vitest';

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
import { AppError } from '@agent-device/kernel/errors';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { withRequestDeadline } from '@agent-device/host-kit/request';
import { runAndroidAutomationHelper } from './automation-helper.ts';
import { prepareAndroidAutomationHelper } from './automation-helper-artifact.ts';
import { runAndroidSnapshotHelperSessionTouchCommand } from './snapshot-helper-session.ts';
import { stopAndroidSnapshotHelperSession } from './snapshot-helper-session-lifecycle.ts';
import { ANDROID_EMULATOR } from './__tests__/test-utils/device-fixtures.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

function tap() {
  return runAndroidAutomationHelper(ANDROID_EMULATOR, {
    action: 'input',
    input: { kind: 'tap', x: 10, y: 20 },
  });
}

async function withinRequestDeadline<T>(remainingMs: number, run: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  const requestId = `budget-${remainingMs}-${Math.random()}`;
  await withDiagnosticsScope({ requestId }, () =>
    withRequestDeadline(requestId, remainingMs, async () => {
      result = await run();
      return { ok: true } as unknown as DaemonResponse;
    }),
  );
  return result as T;
}

function sentCommand() {
  const [command] = vi.mocked(runAndroidSnapshotHelperSessionTouchCommand).mock.calls[0]!;
  const payload = JSON.parse(Buffer.from(command.payloadBase64!, 'base64').toString('utf8'));
  return { payload, timeoutMs: command.timeoutMs };
}

test('without a request deadline, input carries the host cap less the answer margin', async () => {
  await expect(tap()).resolves.toBe(true);
  const { payload, timeoutMs } = sentCommand();
  expect(payload).toMatchObject({ kind: 'tap', x: 10, y: 20 });
  expect(payload.budgetMs).toBe(timeoutMs - 5_000);
});

test('a request with room sends the helper only what remains of its deadline', async () => {
  await withinRequestDeadline(34_000, tap);
  const { payload, timeoutMs } = sentCommand();
  expect(timeoutMs).toBeLessThanOrEqual(34_000);
  expect(timeoutMs).toBeGreaterThan(32_000);
  expect(payload.budgetMs).toBe(timeoutMs - 5_000);
});

test('a request with room for one attempt but not the answer margin sends a zero budget', async () => {
  await withinRequestDeadline(3_000, tap);
  expect(sentCommand().payload.budgetMs).toBe(0);
});

test('a request without room for one attempt is refused before anything reaches the helper', async () => {
  const refusal = await withinRequestDeadline(1_000, () => tap().catch((error: unknown) => error));
  expect(refusal).toBeInstanceOf(AppError);
  expect((refusal as AppError).details).toMatchObject({
    reason: 'android-input-budget-exhausted',
    minimumMs: 2_000,
    dispatched: 'no',
  });
  expect(runAndroidSnapshotHelperSessionTouchCommand).not.toHaveBeenCalled();
  expect(prepareAndroidAutomationHelper).not.toHaveBeenCalled();
  expect(stopAndroidSnapshotHelperSession).not.toHaveBeenCalled();
});
