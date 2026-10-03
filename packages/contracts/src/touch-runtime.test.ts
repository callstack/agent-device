import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { Interactor, PressPointOptions } from './interactor-types.ts';
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
  unsupported: unavailable,
  tap: available,
  tapRef: available,
  longPress: available,
  fill: available,
  fillRef: available,
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

test("an operation the owner never names reports the owner's own denial verbatim", () => {
  const denial = {
    available: false,
    reason: 'unsupported-device-kind',
    hint: 'focus is supported on Android emulators and physical devices.',
  } as const;

  expect(
    touchRuntimeOperationFacts({
      unsupported: denial,
      tap: available,
      longPress: available,
      fill: available,
    }),
  ).toEqual({
    tapPoint: available,
    tapRef: denial,
    longPressPoint: available,
    hoverPoint: denial,
    hoverRef: denial,
    fillPoint: available,
    fillRef: denial,
    tapElementSelector: denial,
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

// A point press is one operation whose options carry several shapes, and two of them ask for more
// than the shared series can compose. A timed hold is a capability an owner states with its
// `longPressPoint` cell; a fused double-click is a mechanic its interactor either has or leaves
// undefined. Either way the shape is refused with a typed reason instead of resolving a member that
// only knows how to throw.
const holdRefused = (hint?: string) =>
  touchRuntimeOperationFacts({
    unsupported: unavailable,
    tap: available,
    longPress:
      hint === undefined
        ? unavailable
        : { available: false, reason: 'unsupported-platform-leaf', hint },
    fill: available,
  });

const pressOptions = {
  button: 'primary',
  count: 1,
  intervalMs: 0,
  holdMs: 0,
  jitterPx: 0,
  doubleTap: false,
} as const;

function bindSharedSeries(
  seriesFacts: ReturnType<typeof touchRuntimeOperationFacts>,
  mechanics: Partial<
    Record<'tap' | 'doubleTap' | 'longPress' | 'pressPoint', ReturnType<typeof vi.fn>>
  >,
) {
  return bindLocalTouchInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: async () => mechanics as unknown as Interactor,
    facts: seriesFacts,
    pause: async () => {},
  });
}

const refusedBy =
  (reason: string) =>
  (error: unknown): boolean =>
    error instanceof AppError &&
    error.code === 'UNSUPPORTED_OPERATION' &&
    error.details?.['reason'] === reason;

const press = (
  operations: ReturnType<typeof bindSharedSeries>,
  options: Partial<PressPointOptions> = {},
) =>
  operations.tapPoint!({
    point: { x: 20, y: 30 },
    options: { ...pressOptions, ...options },
  });

test('a hold the owner refuses is refused by its fact, over an interactor that can hold', async () => {
  const longPress = vi.fn(async () => undefined);
  const operations = bindSharedSeries(holdRefused('Use a native gesture instead.'), {
    tap: vi.fn(async () => undefined),
    longPress,
  });

  await expect(press(operations, { holdMs: 600 })).rejects.toSatisfy(
    refusedBy('unsupported-platform-leaf'),
  );
  await expect(press(operations, { holdMs: 600 })).rejects.toMatchObject({
    details: { reason: 'unsupported-platform-leaf', hint: 'Use a native gesture instead.' },
  });

  expect(longPress).not.toHaveBeenCalled();
});

test('an owner with no double-click mechanic refuses --double before pressing anything', async () => {
  const tap = vi.fn(async () => undefined);
  const operations = bindSharedSeries(holdRefused(), { tap });

  await expect(press(operations, { doubleTap: true })).rejects.toSatisfy(
    refusedBy('owner-capability-missing'),
  );

  expect(tap).not.toHaveBeenCalled();
});

test('the same hold refusal wording carries whatever reason the owner states', async () => {
  const refusals = await Promise.all(
    [
      touchRuntimeOperationFacts({
        unsupported: unavailable,
        tap: available,
        longPress: unavailable,
        fill: available,
      }),
      touchRuntimeOperationFacts({
        unsupported: unavailable,
        tap: available,
        longPress: { available: false, reason: 'unsupported-device-kind' },
        fill: available,
      }),
    ].map(
      async (seriesFacts) =>
        await bindSharedSeries(seriesFacts, { longPress: vi.fn() }).tapPoint!({
          point: { x: 1, y: 1 },
          options: { ...pressOptions, holdMs: 600 },
        })
          .then(() => undefined)
          .catch((error: unknown) => error),
    ),
  );

  const [leaf, deviceKind] = refusals as [AppError, AppError];
  // Identical wording and code, so nothing reading the message can tell the two owners apart…
  expect(deviceKind.message).toEqual(leaf.message);
  expect(deviceKind.code).toEqual(leaf.code);
  // …and the typed reason is the only thing that can.
  expect(leaf).toSatisfy(refusedBy('unsupported-platform-leaf'));
  expect(deviceKind).toSatisfy(refusedBy('unsupported-device-kind'));
});

// The three tests below pin behavior this change must not disturb, so they are green before it too.
test('an owner that states each shape reaches its own mechanic', async () => {
  const mechanics = {
    tap: vi.fn(async () => undefined),
    doubleTap: vi.fn(async () => ({ double: true })),
    longPress: vi.fn(async () => ({ held: true })),
  };
  const operations = bindSharedSeries(facts, mechanics);

  await expect(press(operations, { doubleTap: true })).resolves.toEqual({ double: true });
  await expect(press(operations, { holdMs: 600 })).resolves.toEqual({ held: true });

  expect(mechanics.doubleTap).toHaveBeenCalledWith(20, 30);
  expect(mechanics.longPress).toHaveBeenCalledWith(20, 30, 600);
});

test('an owner with a fused point press keeps its own --double route without a double-click member', async () => {
  const pressPoint = vi.fn(async () => ({ fused: true }));
  const operations = bindSharedSeries(facts, { pressPoint });

  await expect(
    operations.tapPoint!({
      point: { x: 20, y: 30 },
      options: { ...pressOptions, doubleTap: true },
    }),
  ).resolves.toEqual({ fused: true });

  expect(pressPoint).toHaveBeenCalledWith(
    { x: 20, y: 30 },
    expect.objectContaining({ doubleTap: true }),
  );
});

test('a repeated single tap keeps running where the owner refuses a hold and has no double-click', async () => {
  const tap = vi.fn(async () => undefined);
  const operations = bindSharedSeries(holdRefused(), { tap });

  await expect(press(operations, { count: 2, jitterPx: 1 })).resolves.toBeUndefined();

  expect(tap.mock.calls).toEqual([
    [20, 30],
    [21, 30],
  ]);
});

// The mechanic is read off the interactor, so an owner written as a class has to keep its own
// receiver: both provider interactors are classes that reach their session through `this`.
test('the fused double-click keeps the interactor as its receiver', async () => {
  class PointerOwner {
    readonly pressed: Array<[number, number]> = [];
    async doubleTap(x: number, y: number): Promise<void> {
      this.pressed.push([x, y]);
    }
  }
  const owner = new PointerOwner();
  const operations = bindLocalTouchInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: async () => owner as unknown as Interactor,
    facts,
    pause: async () => {},
  });

  await press(operations, { doubleTap: true });

  expect(owner.pressed).toEqual([[20, 30]]);
});
