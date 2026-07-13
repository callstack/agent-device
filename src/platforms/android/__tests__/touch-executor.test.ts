import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';
import { buildGesturePlan } from '../../../contracts/gesture-plan.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import { executeAndroidTouchPlan, readAndroidGestureViewport } from '../touch-executor.ts';

const viewport = { x: 0, y: 0, width: 400, height: 800 };

test('provider-native touch receives the plan as its only source of truth', async () => {
  const plan = buildGesturePlan(
    { intent: 'pinch', origin: { x: 200, y: 300 }, scale: 1.5 },
    viewport,
  );
  const calls: unknown[] = [];
  const result = await withAndroidAdbProvider(
    {
      exec: async () => {
        throw new Error('adb must not run');
      },
      gestureViewport: async () => viewport,
      touch: async (request) => {
        calls.push(request);
        return { injected: true };
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => await executeAndroidTouchPlan(ANDROID_EMULATOR, plan),
  );
  assert.deepEqual(calls, [plan]);
  assert.deepEqual(result, { backend: 'provider-native-touch', injected: true });
});

test('provider touch viewport bypasses local helper transport and is validated', async () => {
  let calls = 0;
  await withAndroidAdbProvider(
    {
      exec: async () => {
        throw new Error('adb must not run');
      },
      gestureViewport: async () => {
        calls += 1;
        return calls === 1 ? viewport : { ...viewport, width: 0 };
      },
      touch: async () => {},
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      assert.deepEqual(await readAndroidGestureViewport(ANDROID_EMULATOR), viewport);
      await assert.rejects(readAndroidGestureViewport(ANDROID_EMULATOR), {
        code: 'COMMAND_FAILED',
      });
    },
  );
  assert.equal(calls, 2);
});
