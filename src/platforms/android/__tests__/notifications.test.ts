import { expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { pushAndroidNotification } from '../notifications.ts';
import { withFakeAdb } from '../../../__tests__/test-utils/fake-adb.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

// The fake adb provider installs through the production withAndroidAdbProvider
// scope, so `calls` records device-scoped args without a leading `-s <serial>`.

test('pushAndroidNotification broadcasts action with typed extras', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      const result = await pushAndroidNotification(device, 'com.example.app', {
        action: 'com.example.app.PUSH',
        extras: {
          title: 'Hello',
          unread: 3,
          promo: true,
          ratio: 0.5,
        },
      });
      assert.equal(result.action, 'com.example.app.PUSH');
      assert.equal(result.extrasCount, 4);
      assert.deepEqual(calls, [
        [
          'shell',
          'am',
          'broadcast',
          '-a',
          'com.example.app.PUSH',
          '-p',
          'com.example.app',
          '--es',
          'title',
          'Hello',
          '--ei',
          'unread',
          '3',
          '--ez',
          'promo',
          'true',
          '--ef',
          'ratio',
          '0.5',
        ],
      ]);
    },
  );
});

test('pushAndroidNotification ignores empty extra keys when reporting extrasCount', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      const result = await pushAndroidNotification(device, 'com.example.app', {
        extras: {
          '': 'ignored',
          title: 'Welcome',
        },
      });
      assert.equal(result.extrasCount, 1);
      const flatArgs = calls.flat();
      assert.equal(flatArgs.includes(''), false);
      assert.equal(flatArgs.includes('ignored'), false);
    },
  );
});

test('aborts an in-flight adb push with the deployment binding signal', async () => {
  const controller = new AbortController();
  const aborted = new Error('request aborted');
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Abort emulator',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  };
  let receivedSignal: AbortSignal | undefined;
  let adbCalled = false;

  await withAndroidAdbProvider(
    {
      exec: async (_args, options) => {
        adbCalled = true;
        receivedSignal = options?.signal;
        return await rejectWhenAborted(options?.signal);
      },
    },
    { serial: device.id },
    async () => {
      const pending = pushAndroidNotification(
        device,
        'com.example.app',
        {},
        {
          signal: controller.signal,
        },
      );
      await vi.waitFor(() => expect(adbCalled).toBe(true));
      assert.equal(receivedSignal, controller.signal);
      controller.abort(aborted);
      await assert.rejects(pending, (error: unknown) => error === aborted);
    },
  );
});

async function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
