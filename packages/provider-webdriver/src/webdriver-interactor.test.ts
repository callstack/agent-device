import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildGesturePlan } from '@agent-device/contracts/interaction';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import type { WebDriverClient, W3CActionSequence } from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';

test('endpoint plans become one timed W3C pointer move', async () => {
  const performed: W3CActionSequence[][] = [];
  let released = false;
  const client = {
    performActions: async (actions: W3CActionSequence[]) => {
      performed.push(actions);
    },
    releaseActions: async () => {
      released = true;
    },
  } as unknown as WebDriverClient;
  const interactor = createWebDriverInteractor({
    client,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
  });
  const plan = buildGesturePlan(
    {
      intent: 'pan',
      origin: { x: 100, y: 200 },
      delta: { x: 100, y: 200 },
      durationMs: 500,
    },
    { x: 0, y: 0, width: 400, height: 800 },
  );

  assert.ok(interactor.performGesture);
  assert.deepEqual(await interactor.performGesture(plan), { backend: 'webdriver-w3c-actions' });
  assert.equal(released, true);
  assert.deepEqual(performed, [
    [
      {
        type: 'pointer',
        id: 'gesture-pointer-0',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: 100, y: 200 },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 500, x: 200, y: 400 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  ]);
});
