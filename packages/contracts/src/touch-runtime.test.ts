import { expect, test, vi } from 'vitest';
import type { Interactor } from './interactor-types.ts';
import {
  bindLocalTouchInteractor,
  HOVER_UNAVAILABLE_HINT,
  touchRuntimeOperationFacts,
} from './touch-runtime.ts';

const device = {
  platform: 'web',
  id: 'browser',
  name: 'Browser',
  kind: 'device',
  booted: true,
} as const;
const available = { available: true } as const;
const unavailable = { available: false, reason: 'unsupported-platform-leaf' } as const;
const facts = touchRuntimeOperationFacts({
  tap: available,
  tapRef: available,
  longPress: available,
  hover: unavailable,
  hoverRef: unavailable,
  fill: available,
  fillRef: available,
  tapElementSelector: unavailable,
});

test('builds exact touch facts and carries the hover refusal hint', () => {
  expect(facts).toEqual({
    tapPoint: available,
    tapRef: available,
    longPressPoint: available,
    hoverPoint: { ...unavailable, hint: HOVER_UNAVAILABLE_HINT },
    hoverRef: { ...unavailable, hint: HOVER_UNAVAILABLE_HINT },
    fillPoint: available,
    fillRef: available,
    tapElementSelector: unavailable,
  });
});

test('the owner binds a ref operation only when its exact fact admits it', async () => {
  const tapRef = vi.fn(async () => ({ route: 'ref' }));
  const resolveInteractor = vi.fn(async () => ({ tapRef }) as unknown as Interactor);
  const operations = bindLocalTouchInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor,
    facts,
    pause: async () => {},
  });

  await expect(
    operations.tapRef!({
      ref: '@e4',
      execution: { requestId: 'touch-ref' },
    }),
  ).resolves.toEqual({ route: 'ref' });

  expect(tapRef).toHaveBeenCalledWith('@e4');
  expect(resolveInteractor).toHaveBeenCalledWith(
    device,
    expect.objectContaining({ requestId: 'touch-ref' }),
  );
});

test('a point tap forwards complete series options through one interactor operation', async () => {
  const pressPoint = vi.fn(async () => ({ timingMode: 'runner-sequence' }));
  const operations = bindLocalTouchInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: async () => ({ pressPoint }) as unknown as Interactor,
    facts,
    pause: async () => {},
  });
  const options = {
    button: 'primary',
    count: 3,
    intervalMs: 125,
    holdMs: 0,
    jitterPx: 2,
    doubleTap: false,
  } as const;

  await expect(operations.tapPoint!({ point: { x: 20, y: 30 }, options })).resolves.toEqual({
    timingMode: 'runner-sequence',
  });
  expect(pressPoint).toHaveBeenCalledWith({ x: 20, y: 30 }, options);
});

test('the shared primary series preserves jitter, interval, and every press', async () => {
  const tap = vi.fn(async () => ({ pressed: true }));
  const pause = vi.fn(async () => {});
  const operations = bindLocalTouchInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: async () =>
      ({ tap, doubleTap: vi.fn(), longPress: vi.fn() }) as unknown as Interactor,
    facts,
    pause,
  });

  await operations.tapPoint!({
    point: { x: 20, y: 30 },
    options: {
      button: 'primary',
      count: 3,
      intervalMs: 40,
      holdMs: 0,
      jitterPx: 2,
      doubleTap: false,
    },
  });

  expect(tap.mock.calls).toEqual([
    [20, 30],
    [22, 30],
    [20, 32],
  ]);
  expect(pause.mock.calls).toEqual([[40], [40]]);
});
