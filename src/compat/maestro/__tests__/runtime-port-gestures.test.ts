import { expect, test, vi } from 'vitest';
import { createMaestroRuntimePort } from '../runtime-port.ts';
import { makeOperations } from './runtime-port-fixtures.ts';

test('uses the structured gesture contract without observing absolute swipes', async () => {
  const resolveGestureViewport = vi.fn(async () => ({ x: 10, y: 20, width: 400, height: 800 }));
  const gesture = vi.fn(async () => undefined);
  const operations = makeOperations({ resolveGestureViewport, gesture });
  const port = createMaestroRuntimePort(operations);

  await port.execute({
    command: {
      kind: 'swipe',
      source: { line: 2 },
      gesture: {
        kind: 'coordinates',
        start: { space: 'absolute', x: 100, y: 200 },
        end: { space: 'absolute', x: 300, y: 200 },
        duration: 240,
      },
    },
    generation: 0,
    env: {},
  });
  await port.execute({
    command: {
      kind: 'swipe',
      source: { line: 3 },
      gesture: {
        kind: 'coordinates',
        start: { space: 'percent', x: 90, y: 50 },
        end: { space: 'percent', x: 10, y: 50 },
      },
    },
    generation: 1,
    env: {},
  });
  await port.execute({
    command: {
      kind: 'swipe',
      source: { line: 4 },
      gesture: { kind: 'screen', direction: 'down', duration: 300 },
    },
    generation: 2,
    env: {},
  });
  await port.execute({
    command: {
      kind: 'swipe',
      source: { line: 5 },
      gesture: { kind: 'screen', direction: 'left' },
    },
    generation: 3,
    env: {},
  });

  expect(resolveGestureViewport).toHaveBeenCalledTimes(2);
  expect(gesture).toHaveBeenNthCalledWith(
    1,
    {
      intent: 'pan',
      origin: { x: 100, y: 200 },
      delta: { x: 200, y: 0 },
      durationMs: 240,
    },
    expect.objectContaining({
      generation: 0,
      authoredSwipe: {
        kind: 'coordinates',
        start: { space: 'absolute', x: 100, y: 200 },
        end: { space: 'absolute', x: 300, y: 200 },
        duration: 240,
      },
    }),
  );
  expect(gesture).toHaveBeenNthCalledWith(
    2,
    {
      intent: 'fling',
      from: { x: 370, y: 420 },
      to: { x: 50, y: 420 },
    },
    expect.objectContaining({
      generation: 1,
      authoredSwipe: expect.objectContaining({ kind: 'coordinates' }),
      gestureViewport: { x: 10, y: 20, width: 400, height: 800 },
    }),
  );
  expect(gesture).toHaveBeenNthCalledWith(
    3,
    {
      intent: 'pan',
      origin: { x: 210, y: 140 },
      delta: { x: 0, y: 560 },
      durationMs: 300,
    },
    expect.objectContaining({
      generation: 2,
      authoredSwipe: { kind: 'screen', direction: 'down', duration: 300 },
      gestureViewport: { x: 10, y: 20, width: 400, height: 800 },
    }),
  );
  expect(gesture).toHaveBeenNthCalledWith(
    4,
    { intent: 'fling', preset: 'left' },
    expect.objectContaining({
      generation: 3,
      authoredSwipe: { kind: 'screen', direction: 'left' },
    }),
  );
});

test('rejects stale typed selector evidence before input execution', async () => {
  const tapOn = vi.fn(async () => undefined);
  const operations = makeOperations({
    resolveTarget: vi.fn(async () => ({
      generation: 9,
      matched: true,
      visible: true,
      candidateCount: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    })),
    tapOn,
  });
  const port = createMaestroRuntimePort(operations);

  await expect(
    port.execute({
      command: {
        kind: 'tapOn',
        source: { line: 2 },
        target: { space: 'target', selector: { text: 'Continue' } },
      },
      generation: 0,
      env: {},
    }),
  ).rejects.toThrow(/evidence generation 9 does not match 0/);
  expect(tapOn).not.toHaveBeenCalled();
});
