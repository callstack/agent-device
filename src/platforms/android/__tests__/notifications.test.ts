import { test } from 'vitest';
import assert from 'node:assert/strict';
import { pushAndroidNotification } from '../notifications.ts';
import { withFakeAdb } from '../../../__tests__/test-utils/index.ts';

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
