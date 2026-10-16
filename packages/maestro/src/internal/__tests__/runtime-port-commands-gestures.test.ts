import { expect, test, vi } from 'vitest';
import { createMaestroRuntimePort, makeOperations } from './runtime-port-fixtures.ts';

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
      from: { x: 100, y: 200 },
      to: { x: 300, y: 200 },
      durationMs: 240,
    },
    expect.objectContaining({ generation: 1 }),
  );
  expect(gesture).toHaveBeenNthCalledWith(
    2,
    {
      from: { x: 370, y: 420 },
      to: { x: 50, y: 420 },
      durationMs: 400,
    },
    expect.objectContaining({
      generation: 2,
      gestureViewport: { x: 10, y: 20, width: 400, height: 800 },
    }),
  );
  expect(gesture).toHaveBeenNthCalledWith(
    3,
    {
      from: { x: 210, y: 180 },
      to: { x: 210, y: 740 },
      durationMs: 300,
    },
    expect.objectContaining({
      generation: 3,
      gestureViewport: { x: 10, y: 20, width: 400, height: 800 },
    }),
  );
  expect(gesture).toHaveBeenNthCalledWith(
    4,
    {
      from: { x: 350, y: 420 },
      to: { x: 70, y: 420 },
      durationMs: 400,
    },
    expect.objectContaining({
      generation: 4,
      gestureViewport: { x: 10, y: 20, width: 400, height: 800 },
    }),
  );
});

test('keeps directional right swipes inside the system gesture edges', async () => {
  const gesture = vi.fn(async () => undefined);
  const operations = makeOperations({
    platform: 'ios',
    gesture,
    resolveGestureViewport: vi.fn(async () => ({ x: 0, y: 0, width: 400, height: 800 })),
  });

  await createMaestroRuntimePort(operations).execute({
    command: {
      kind: 'swipe',
      source: { line: 2 },
      gesture: { kind: 'screen', direction: 'right', duration: 300 },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(gesture).toHaveBeenCalledWith(
    { from: { x: 60, y: 400 }, to: { x: 340, y: 400 }, durationMs: 300 },
    expect.anything(),
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
    expect.objectContaining({ from: { x: 201, y: 786 }, to: { x: 201, y: 87 } }),
    expect.anything(),
  );
});

test('truncates percentage coordinates with Maestro integer arithmetic', async () => {
  const resolveGestureViewport = vi.fn(async () => ({ x: 10, y: 20, width: 401, height: 801 }));
  const gesture = vi.fn(async () => undefined);
  const operations = makeOperations({ resolveGestureViewport, gesture });

  await createMaestroRuntimePort(operations).execute({
    command: {
      kind: 'swipe',
      source: { line: 2 },
      gesture: {
        kind: 'coordinates',
        start: { space: 'percent', x: 50, y: 50 },
        end: { space: 'percent', x: 51, y: 51 },
      },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(gesture).toHaveBeenCalledWith(
    {
      from: { x: 210, y: 420 },
      to: { x: 214, y: 428 },
      durationMs: 400,
    },
    expect.objectContaining({ gestureViewport: { x: 10, y: 20, width: 401, height: 801 } }),
  );
});

test.each([
  ['up', { x: 150, y: 100 }],
  ['down', { x: 150, y: 740 }],
  ['left', { x: 50, y: 240 }],
  ['right', { x: 370, y: 240 }],
] as const)(
  'projects a target-relative %s swipe to Maestro viewport endpoints',
  async (direction, to) => {
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
      expect.objectContaining({ from: { x: 150, y: 240 }, to }),
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
