import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ref, selector } from '../../index.ts';
import { AppError } from '../../../kernel/errors.ts';
import {
  createInteractionDevice,
  runtimeScrollSnapshot,
  selectorSnapshot,
  snapshotWithOffscreenContent,
} from './__tests__/test-utils/index.ts';

test('runtime focus and longPress share selector/ref target resolution', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    focus: async (_context, point) => {
      calls.push({ command: 'focus', point });
      return { focused: true };
    },
    longPress: async (_context, point, options) => {
      calls.push({ command: 'longPress', point, durationMs: options?.durationMs });
    },
  });

  const focused = await device.interactions.focus(selector('label=Continue'), {
    session: 'default',
  });
  const longPressed = await device.interactions.longPress(ref('@e1'), {
    session: 'default',
    durationMs: 750,
  });

  assert.equal(focused.kind, 'selector');
  assert.deepEqual(focused.backendResult, { focused: true });
  assert.equal(longPressed.kind, 'ref');
  assert.deepEqual(calls, [
    { command: 'focus', point: { x: 60, y: 40 } },
    { command: 'longPress', point: { x: 60, y: 40 }, durationMs: 750 },
  ]);
});

test('runtime scroll resolves selector targets before calling the backend primitive', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    scroll: async (_context, target, options) => {
      calls.push({ target, options });
      return { scrolled: true };
    },
  });

  const selectorResult = await device.interactions.scroll({
    session: 'default',
    target: selector('label=Continue'),
    direction: 'down',
    pixels: 120,
    durationMs: 50,
  });
  const viewportResult = await device.interactions.scroll({
    direction: 'up',
    amount: 0.5,
  });

  assert.equal(selectorResult.kind, 'selector');
  assert.equal(selectorResult.durationMs, undefined);
  assert.equal(viewportResult.kind, 'viewport');
  assert.deepEqual(calls, [
    {
      target: { kind: 'point', point: { x: 60, y: 40 } },
      options: { direction: 'down', pixels: 120, durationMs: 50 },
    },
    {
      target: { kind: 'viewport' },
      options: { direction: 'up', amount: 0.5 },
    },
  ]);
});

test('runtime scroll reports duration only when the backend honored it', async () => {
  const device = createInteractionDevice(selectorSnapshot(), {
    scroll: async (_context, _target, options) => ({ durationMs: options?.durationMs }),
  });

  const result = await device.interactions.scroll({
    direction: 'down',
    pixels: 120,
    durationMs: 50,
  });

  assert.equal(result.durationMs, 50);
  assert.deepEqual(result.backendResult, { durationMs: 50 });
});

test('runtime scroll rejects duration above the shared cap', async () => {
  const device = createInteractionDevice(selectorSnapshot(), {
    scroll: async () => {
      throw new Error('scroll should be rejected before backend call');
    },
  });

  await assert.rejects(
    () =>
      device.interactions.scroll({
        direction: 'down',
        pixels: 120,
        durationMs: 10_001,
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /durationMs.*at most 10000/i.test(error.message),
  );
});

test('runtime scroll bottom rejects blind scrolling without snapshot support', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => {
      throw new Error('snapshot unavailable');
    },
    scroll: async (_context, target, options) => {
      calls.push({ target, options });
      return { pass: calls.length };
    },
  });

  await assert.rejects(
    () =>
      device.interactions.scroll({
        direction: 'bottom',
      }),
    /Failed to verify scroll bottom state/,
  );

  assert.equal(calls.length, 0);
});

test('runtime scroll bottom does not scroll when no hidden content is below', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(runtimeScrollSnapshot({ hiddenBelow: false }), {
    scroll: async (_context, target, options) => {
      calls.push({ target, options });
      return { pass: calls.length };
    },
  });

  const result = await device.interactions.scroll({
    direction: 'bottom',
  });

  assert.equal(result.kind, 'viewport');
  assert.equal(result.edge, 'bottom');
  assert.equal(result.passes, 0);
  assert.equal(calls.length, 0);
});

test('runtime scroll bottom scrolls only while scoped snapshot confirms hidden content', async () => {
  const calls: unknown[] = [];
  const snapshotScopes: unknown[] = [];
  const snapshots = [
    runtimeScrollSnapshot({ hiddenBelow: true, message: 'Middle message' }),
    runtimeScrollSnapshot({ hiddenBelow: true, message: 'Middle message' }),
    runtimeScrollSnapshot({ hiddenBelow: false, message: 'Latest message' }),
  ];
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async (_context, options) => {
      snapshotScopes.push(options?.scope);
      return { snapshot: snapshots[Math.min(snapshotScopes.length - 1, snapshots.length - 1)] };
    },
    scroll: async (_context, target, options) => {
      calls.push({ target, options });
      return { pass: calls.length };
    },
  });

  const result = await device.interactions.scroll({
    direction: 'bottom',
  });

  assert.equal(result.kind, 'viewport');
  assert.equal(result.edge, 'bottom');
  assert.equal(result.passes, 1);
  assert.equal(result.backendResult?.pass, 1);
  assert.deepEqual(calls, [
    {
      target: { kind: 'viewport' },
      options: { direction: 'down' },
    },
  ]);
  assert.deepEqual(snapshotScopes, [undefined, 'Messages', 'Messages']);
});

test('runtime scroll bottom tolerates unchanged signatures while hidden content advances', async () => {
  const calls: unknown[] = [];
  const snapshots = [
    runtimeScrollSnapshot({ hiddenBelow: true, message: 'Repeated row' }),
    runtimeScrollSnapshot({ hiddenBelow: true, message: 'Repeated row' }),
    runtimeScrollSnapshot({ hiddenBelow: true, message: 'Repeated row' }),
    runtimeScrollSnapshot({ hiddenBelow: false, message: 'Repeated row' }),
  ];
  let snapshotIndex = 0;
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => ({
      snapshot: snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    }),
    scroll: async (_context, target, options) => {
      calls.push({ target, options });
      return { pass: calls.length };
    },
  });

  const result = await device.interactions.scroll({
    direction: 'bottom',
  });

  assert.equal(result.passes, 2);
  assert.equal(calls.length, 2);
});

test('runtime scroll bottom keeps scoped snapshot failures scoped', async () => {
  let snapshotCount = 0;
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async (_context, options) => {
      snapshotCount += 1;
      if (options?.scope) throw new Error('scoped snapshot failed');
      return { snapshot: runtimeScrollSnapshot({ hiddenBelow: true, message: 'Middle message' }) };
    },
    scroll: async () => ({}),
  });

  await assert.rejects(
    () =>
      device.interactions.scroll({
        direction: 'bottom',
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      /scoped container/i.test(error.message) &&
      error.details?.scope === 'Messages',
  );
  assert.equal(snapshotCount, 2);
});

test('runtime swipe supports explicit and viewport-derived targets', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    swipe: async (_context, from, to, options) => {
      calls.push({ from, to, durationMs: options?.durationMs });
    },
  });

  const explicit = await device.interactions.swipe({
    from: selector('label=Continue'),
    to: { x: 200, y: 40 },
    durationMs: 300,
    session: 'default',
  });
  const directional = await device.interactions.swipe({
    direction: 'left',
    distance: 25,
    session: 'default',
  });

  assert.deepEqual(explicit.from, { x: 60, y: 40 });
  assert.deepEqual(directional.from, { x: 60, y: 40 });
  assert.deepEqual(directional.to, { x: 35, y: 40 });
  assert.deepEqual(calls, [
    { from: { x: 60, y: 40 }, to: { x: 200, y: 40 }, durationMs: 300 },
    { from: { x: 60, y: 40 }, to: { x: 35, y: 40 }, durationMs: undefined },
  ]);
});

test('runtime directional swipe uses the visible viewport instead of off-screen content bounds', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(snapshotWithOffscreenContent(), {
    swipe: async (_context, from, to) => {
      calls.push({ from, to });
    },
  });

  const result = await device.interactions.swipe({
    direction: 'left',
    distance: 25,
    session: 'default',
  });

  assert.deepEqual(result.from, { x: 50, y: 50 });
  assert.deepEqual(result.to, { x: 25, y: 50 });
  assert.deepEqual(calls, [{ from: { x: 50, y: 50 }, to: { x: 25, y: 50 } }]);
});

test('runtime gesture swipe presets use stable viewport lanes', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(snapshotWithOffscreenContent(), {
    platform: 'android',
    swipe: async (_context, from, to, options) => {
      calls.push({ from, to, durationMs: options?.durationMs });
    },
  });

  const pageSwipe = await device.interactions.swipe({
    preset: 'left',
    durationMs: 300,
    session: 'default',
  });
  const edgeSwipe = await device.interactions.swipe({
    preset: 'right-edge',
    durationMs: 350,
    session: 'default',
  });

  assert.deepEqual(pageSwipe.from, { x: 85, y: 50 });
  assert.deepEqual(pageSwipe.to, { x: 15, y: 50 });
  assert.deepEqual(edgeSwipe.from, { x: 8, y: 50 });
  assert.deepEqual(edgeSwipe.to, { x: 85, y: 50 });
  assert.deepEqual(calls, [
    { from: { x: 85, y: 50 }, to: { x: 15, y: 50 }, durationMs: 300 },
    { from: { x: 8, y: 50 }, to: { x: 85, y: 50 }, durationMs: 350 },
  ]);
});

test('runtime iOS in-page swipe presets avoid edge-navigation lanes', async () => {
  const calls: unknown[] = [];
  const device = createInteractionDevice(snapshotWithOffscreenContent(), {
    platform: 'ios',
    swipe: async (_context, from, to, options) => {
      calls.push({ from, to, durationMs: options?.durationMs });
    },
  });

  const pageSwipe = await device.interactions.swipe({
    preset: 'right',
    durationMs: 300,
    session: 'default',
  });

  assert.deepEqual(pageSwipe.from, { x: 15, y: 50 });
  assert.deepEqual(pageSwipe.to, { x: 85, y: 50 });
  assert.deepEqual(calls, [{ from: { x: 15, y: 50 }, to: { x: 85, y: 50 }, durationMs: 300 }]);
});

test('runtime viewport gestures reject inspect-only macOS surfaces', async () => {
  for (const surface of ['desktop', 'menubar'] as const) {
    const device = createInteractionDevice(selectorSnapshot(), {
      platform: 'macos',
      sessionMetadata: { surface },
      scroll: async () => {
        throw new Error(`${surface} scroll should be rejected before backend call`);
      },
      swipe: async () => {
        throw new Error(`${surface} swipe should be rejected before backend call`);
      },
      pinch: async () => {
        throw new Error(`${surface} pinch should be rejected before backend call`);
      },
    });

    await assert.rejects(
      () =>
        device.interactions.scroll({
          direction: 'down',
          target: { kind: 'viewport' },
          session: 'default',
        }),
      new RegExp(`scroll is not supported on macOS ${surface}`),
    );
    await assert.rejects(
      () =>
        device.interactions.swipe({
          direction: 'left',
          session: 'default',
        }),
      new RegExp(`swipe is not supported on macOS ${surface}`),
    );
    await assert.rejects(
      () =>
        device.interactions.swipe({
          from: { x: 10, y: 20 },
          to: { x: 30, y: 20 },
          session: 'default',
        }),
      new RegExp(`swipe is not supported on macOS ${surface}`),
    );
    await assert.rejects(
      () =>
        device.interactions.pinch({
          scale: 1.2,
          session: 'default',
        }),
      new RegExp(`pinch is not supported on macOS ${surface}`),
    );
  }
});

test('runtime pinch is backend-gated and resolves optional center targets', async () => {
  const calls: unknown[] = [];
  const unsupported = createInteractionDevice(selectorSnapshot());
  await assert.rejects(
    () => unsupported.interactions.pinch({ scale: 1.2 }),
    /pinch is not supported/,
  );

  const device = createInteractionDevice(selectorSnapshot(), {
    pinch: async (_context, options) => {
      calls.push(options);
    },
  });

  const result = await device.interactions.pinch({
    scale: 0.8,
    center: ref('@e1'),
    session: 'default',
  });

  assert.equal(result.kind, 'pinch');
  assert.deepEqual(result.center, { x: 60, y: 40 });
  assert.deepEqual(calls, [{ scale: 0.8, center: { x: 60, y: 40 } }]);
});
