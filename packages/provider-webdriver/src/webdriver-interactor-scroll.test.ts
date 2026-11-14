import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Rect } from '@agent-device/kernel/snapshot';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import type {
  W3CActionSequence,
  WebDriverClient,
  WebDriverWindowRect,
} from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';

const WINDOW: WebDriverWindowRect = { x: 12, y: 30, width: 402, height: 874 };
/** Inset under a navigation bar and above a footer, in the window's own coordinates. */
const INSET_LIST: Rect = { x: 18, y: 178, width: 366, height: 500 };
const FITTING_LIST: Rect = { x: 18, y: 62, width: 366, height: 729 };

function place(rect: Rect, frame: WebDriverWindowRect): Rect {
  return { ...rect, x: rect.x + frame.x, y: rect.y + frame.y };
}

function strictlyInside(point: { x: number; y: number }, rect: Rect): boolean {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}

function scrollWorld(frame: WebDriverWindowRect) {
  const performed: W3CActionSequence[][] = [];
  const client = {
    hideKeyboard: async () => undefined,
    source: async () => {
      throw new Error('page source unavailable');
    },
    windowRect: async () => frame,
    performActions: async (actions: W3CActionSequence[]) => {
      performed.push(actions);
    },
    releaseActions: async () => undefined,
  } as unknown as WebDriverClient;
  return {
    performed,
    interactor: createWebDriverInteractor({
      client,
      backend: 'android',
      capabilities: createCloudWebDriverCapabilities({ provider: 'test', platform: 'android' }),
    }),
  };
}

function swipeEndpoints(actions: W3CActionSequence[] | undefined): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  const moves = actions?.[0]?.actions.filter((action) => action.type === 'pointerMove') ?? [];
  const start = moves[0];
  const end = moves[1];
  if (start?.type !== 'pointerMove' || end?.type !== 'pointerMove') {
    assert.fail('swipe is missing its pointer moves');
  }
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

test('WebDriver scroll keeps an inset list swipe inside the container and reports the shortened span', async () => {
  const { interactor, performed } = scrollWorld(WINDOW);
  const list = place(INSET_LIST, WINDOW);
  const unclamped = await interactor.scroll('down', { amount: 0.75 });
  const outside = swipeEndpoints(performed[0]);
  const result = await interactor.scroll('down', { amount: 0.75, containerRect: list });
  const swipe = swipeEndpoints(performed[1]);

  assert.equal(
    strictlyInside({ x: outside.x1, y: outside.y1 }, list) &&
      strictlyInside({ x: outside.x2, y: outside.y2 }, list),
    false,
    'the fixture must leave the list',
  );
  assert.ok(strictlyInside({ x: swipe.x1, y: swipe.y1 }, list), JSON.stringify(swipe));
  assert.ok(strictlyInside({ x: swipe.x2, y: swipe.y2 }, list), JSON.stringify(swipe));
  assert.deepEqual(swipe, { x1: result?.x1, y1: result?.y1, x2: result?.x2, y2: result?.y2 });
  assert.equal(result?.pixels, Math.abs(Number(result?.y2) - Number(result?.y1)));
  assert.equal(result?.distance, result?.pixels);
  assert.ok(Number(result?.pixels) < Number(unclamped?.pixels));
  assert.equal(result?.requestedPixels, unclamped?.pixels);
});

test('WebDriver scroll leaves a swipe that already fits its container unchanged', async () => {
  const { interactor } = scrollWorld(WINDOW);
  const unclamped = await interactor.scroll('down', { amount: 0.75 });
  const result = await interactor.scroll('down', {
    amount: 0.75,
    containerRect: place(FITTING_LIST, WINDOW),
  });

  assert.deepEqual(result, unclamped);
  assert.equal(result !== undefined && 'requestedPixels' in result, false);
});

test('WebDriver scroll without a container keeps the window swipe', async () => {
  const { interactor, performed } = scrollWorld(WINDOW);
  const result = await interactor.scroll('up', { amount: 0.75 });
  const swipe = swipeEndpoints(performed[0]);

  assert.deepEqual(swipe, { x1: result?.x1, y1: result?.y1, x2: result?.x2, y2: result?.y2 });
  assert.equal(result !== undefined && 'requestedPixels' in result, false);
  assert.equal(result?.distance, result?.pixels);
});
