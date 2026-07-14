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
    invalidateObservation() {},
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
    invalidateObservation() {},
  });
  await port.execute({
    command: {
      kind: 'swipe',
      source: { line: 4 },
      gesture: { kind: 'screen', direction: 'down', duration: 300 },
    },
    generation: 2,
    env: {},
    invalidateObservation() {},
  });
  await port.execute({
    command: {
      kind: 'swipe',
      source: { line: 5 },
      gesture: { kind: 'screen', direction: 'left' },
    },
    generation: 3,
    env: {},
    invalidateObservation() {},
  });

  expect(resolveGestureViewport).toHaveBeenCalledTimes(3);
  expect(gesture).toHaveBeenNthCalledWith(
    1,
    {
      intent: 'pan',
      origin: { x: 100, y: 200 },
      delta: { x: 200, y: 0 },
      durationMs: 240,
      executionProfile: 'endpoint-hold',
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
      intent: 'pan',
      origin: { x: 370, y: 420 },
      delta: { x: -320, y: 0 },
      durationMs: 400,
      executionProfile: 'endpoint-hold',
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
      origin: { x: 210, y: 180 },
      delta: { x: 0, y: 560 },
      durationMs: 300,
      executionProfile: 'endpoint-hold',
    },
    expect.objectContaining({
      generation: 2,
      authoredSwipe: { kind: 'screen', direction: 'down', duration: 300 },
      gestureViewport: { x: 10, y: 20, width: 400, height: 800 },
    }),
  );
  expect(gesture).toHaveBeenNthCalledWith(
    4,
    {
      intent: 'pan',
      origin: { x: 370, y: 420 },
      delta: { x: -320, y: 0 },
      durationMs: 400,
      executionProfile: 'endpoint-hold',
    },
    expect.objectContaining({
      generation: 3,
      authoredSwipe: { kind: 'screen', direction: 'left' },
      gestureViewport: { x: 10, y: 20, width: 400, height: 800 },
    }),
  );
});

test('uses Maestro iOS screen-swipe geometry', async () => {
  const gesture = vi.fn(async () => undefined);
  const operations = makeOperations({ platform: 'ios', gesture });

  await createMaestroRuntimePort(operations).execute({
    command: {
      kind: 'swipe',
      source: { line: 2 },
      gesture: { kind: 'screen', direction: 'up' },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(gesture).toHaveBeenCalledWith(
    expect.objectContaining({ origin: { x: 201, y: 786 }, delta: { x: 0, y: -699 } }),
    expect.anything(),
  );
});

test.each([
  ['up', { x: 0, y: -140 }],
  ['down', { x: 0, y: 500 }],
  ['left', { x: -100, y: 0 }],
  ['right', { x: 220, y: 0 }],
] as const)(
  'projects a target-relative %s swipe to Maestro viewport endpoints',
  async (direction, delta) => {
    const gesture = vi.fn(async () => undefined);
    const operations = makeOperations({
      resolveTarget: vi.fn(async () => ({
        generation: 0,
        matched: true,
        visible: true,
        candidateCount: 1,
        rect: { x: 100, y: 200, width: 100, height: 80 },
        viewport: { x: 10, y: 20, width: 400, height: 800 },
      })),
      gesture,
    });

    await createMaestroRuntimePort(operations).execute({
      command: {
        kind: 'swipe',
        source: { line: 2 },
        gesture: { kind: 'target', from: { id: 'pager' }, direction },
      },
      generation: 0,
      env: {},
      invalidateObservation() {},
    });

    expect(gesture).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { x: 150, y: 240 }, delta }),
      expect.objectContaining({ gestureViewport: { x: 10, y: 20, width: 400, height: 800 } }),
    );
  },
);

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
      invalidateObservation() {},
    }),
  ).rejects.toThrow(/evidence generation 9 does not match 0/);
  expect(tapOn).not.toHaveBeenCalled();
});
