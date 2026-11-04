import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { LimrunDeviceSession } from './device-session.ts';
import { readLimrunAppState } from './app-state-read.ts';

const liveSignal = () => new AbortController().signal;

function iosSession(listApps: () => Promise<unknown[]>): LimrunDeviceSession {
  return { platform: 'ios', listApps } as unknown as LimrunDeviceSession;
}

test('a live iOS instance answers with no state, because Limrun cannot read one', async () => {
  const listApps = vi.fn(async () => []);

  await expect(readLimrunAppState(iosSession(listApps), liveSignal())).resolves.toEqual({});
  expect(listApps).toHaveBeenCalledTimes(1);
});

test('an iOS instance that does not answer fails typed and keeps the cause', async () => {
  const cause = new Error('socket closed');

  const refusal = await readLimrunAppState(
    iosSession(async () => {
      throw cause;
    }),
    liveSignal(),
  ).catch((error: unknown) => error);

  expect(refusal).toBeInstanceOf(AppError);
  expect(refusal).toMatchObject({
    code: 'COMMAND_FAILED',
    cause,
    details: { reason: 'limrun_instance_unreachable' },
  });
});

test('an iOS check cancelled in flight stays cancelled instead of reporting the instance gone', async () => {
  const controller = new AbortController();
  const reason = new AppError('COMMAND_FAILED', 'request canceled', {
    reason: 'request_canceled',
  });
  const listApps = vi.fn(() => new Promise<unknown[]>(() => {}));

  const read = readLimrunAppState(iosSession(listApps), controller.signal);
  controller.abort(reason);

  await expect(read).rejects.toBe(reason);
  expect(listApps).toHaveBeenCalledTimes(1);
});

test('an Android session answers from its foreground app', async () => {
  const session = {
    platform: 'android',
    getForegroundApp: async () => ({ appId: 'com.example.app', activity: '.MainActivity' }),
  } as unknown as LimrunDeviceSession;

  await expect(readLimrunAppState(session, liveSignal())).resolves.toEqual({
    package: 'com.example.app',
    activity: '.MainActivity',
  });
});

test('a provider session lost before the read is refused with a typed reason', async () => {
  await expect(readLimrunAppState(undefined, liveSignal())).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    message: 'Limrun appstate requires an active provider session',
    details: { reason: 'owner-capability-missing' },
  });
});
