import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ref, selector } from './selector-read.ts';
import { AppError } from '../../../kernel/errors.ts';
import {
  createInteractionDevice,
  runtimeScrollSnapshot,
  selectorSnapshot,
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

test('runtime longPress with settle drops the non-hittable hint when the diff proves a change', async () => {
  let captureCount = 0;
  const nonHittableSnapshot = selectorSnapshot();
  const nonHittableNode = nonHittableSnapshot.nodes[0];
  assert.ok(nonHittableNode);
  nonHittableSnapshot.nodes[0] = {
    ...nonHittableNode,
    hittable: false,
  };
  const changedSnapshot = selectorSnapshot();
  const changedNode = changedSnapshot.nodes[0];
  assert.ok(changedNode);
  changedSnapshot.nodes[0] = {
    ...changedNode,
    label: 'Context menu',
    value: undefined,
    hittable: true,
  };
  const device = createInteractionDevice(nonHittableSnapshot, {
    captureSnapshot: async () => {
      captureCount += 1;
      return { snapshot: captureCount === 1 ? nonHittableSnapshot : changedSnapshot };
    },
    longPress: async () => ({ ok: true }),
  });

  const result = await device.interactions.longPress(selector('label=Continue'), {
    session: 'default',
    settle: { quietMs: 25, timeoutMs: 2_000 },
  });

  assert.equal(result.kind, 'selector');
  if (result.kind !== 'selector') return;
  assert.equal(result.targetHittable, false);
  assert.deepEqual(result.settle?.diff?.summary, { additions: 1, removals: 1, unchanged: 0 });
  assert.equal('hint' in result, false);
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

test('runtime viewport scroll rejects inspect-only macOS surfaces', async () => {
  for (const surface of ['desktop', 'menubar'] as const) {
    const device = createInteractionDevice(selectorSnapshot(), {
      platform: 'macos',
      sessionMetadata: { surface },
      scroll: async () => {
        throw new Error(`${surface} scroll should be rejected before backend call`);
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
  }
});

test('runtime multi-touch planning prefers backend viewport geometry without a snapshot capture', async () => {
  let capturedPlan: unknown;
  const device = createInteractionDevice(selectorSnapshot(), {
    platform: 'android',
    captureSnapshot: async () => {
      throw new Error('gesture viewport must not capture Android accessibility state');
    },
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 300, height: 600 }),
    performGesture: async (_context, plan) => {
      capturedPlan = plan;
    },
  });

  await device.interactions.gesture({
    gesture: {
      intent: 'pan',
      origin: { x: 150, y: 300 },
      delta: { x: 20, y: 0 },
      pointerCount: 2,
    },
  });

  assert.deepEqual(
    capturedPlan && typeof capturedPlan === 'object' && 'viewport' in capturedPlan
      ? capturedPlan.viewport
      : undefined,
    { x: 0, y: 0, width: 300, height: 600 },
  );
});
