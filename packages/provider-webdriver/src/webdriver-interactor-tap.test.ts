import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildGesturePlan } from '@agent-device/contracts/gesture-plan';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import type { WebDriverClient, W3CActionSequence } from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';

test('a multi-finger tap sends one touch source per contact only where a provider opted in', async () => {
  const performed: W3CActionSequence[][] = [];
  const client = {
    performActions: async (actions: W3CActionSequence[]) => {
      performed.push(actions);
    },
    releaseActions: async () => {},
  } as unknown as WebDriverClient;
  const plan = buildGesturePlan(
    {
      intent: 'tap',
      points: [
        { x: 100, y: 200 },
        { x: 200, y: 300 },
        { x: 300, y: 400 },
      ],
      holdMs: 40,
    },
    { x: 0, y: 0, width: 400, height: 800 },
  );
  const tapSource = (index: number, x: number, y: number) => ({
    type: 'pointer',
    id: `gesture-pointer-${index}`,
    parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 40, x, y },
      { type: 'pointerUp', button: 0 },
    ],
  });

  const interactor = createWebDriverInteractor({
    client,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({
      provider: 'test',
      platform: 'android',
      overrides: { tapGesture: 'supported' },
    }),
  });
  assert.deepEqual(await interactor.performGesture!(plan), { backend: 'webdriver-w3c-actions' });
  assert.deepEqual(performed, [
    [tapSource(0, 100, 200), tapSource(1, 200, 300), tapSource(2, 300, 400)],
  ]);

  // Two-contact transform support alone does not admit a tap.
  const singleTouchOnly = createWebDriverInteractor({
    client,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({
      provider: 'test',
      platform: 'android',
      overrides: { transformGesture: 'supported' },
    }),
  });
  const before = performed.length;
  await assert.rejects(singleTouchOnly.performGesture!(plan), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'UNSUPPORTED_OPERATION');
    assert.equal(error.details?.operation, 'tapGesture');
    return true;
  });
  assert.equal(performed.length, before);
});
