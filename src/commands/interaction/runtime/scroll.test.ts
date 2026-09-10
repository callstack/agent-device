import assert from 'node:assert/strict';
import { test } from 'vitest';
import { selector } from './selector-read-utils.ts';
import { AppError } from '@agent-device/kernel/errors';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import {
  createInteractionDevice,
  runtimeScrollSnapshot,
  selectorSnapshot,
} from './__tests__/test-utils/index.ts';

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
      options: {
        direction: 'down',
        pixels: 120,
        durationMs: 50,
        releaseBehavior: 'controlled',
      },
    },
    {
      target: { kind: 'viewport' },
      options: { direction: 'up', amount: 0.5, releaseBehavior: 'controlled' },
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
      options: { direction: 'down', releaseBehavior: 'inertial' },
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

/** A viewport-height tree whose target row sits at `targetY`, used to walk a target into view. */
function untilSnapshot(targetY: number, hiddenBelow: boolean) {
  return makeSnapshotState([
    {
      index: 1,
      depth: 0,
      type: 'ScrollView',
      label: 'Form',
      hiddenContentBelow: hiddenBelow ? true : undefined,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 1,
      type: 'TextField',
      label: 'Email',
      rect: { x: 0, y: targetY, width: 400, height: 40 },
      hittable: true,
    },
  ]);
}

test('runtime scroll --until stops the pass loop as soon as the selector is on screen', async () => {
  const scrolls: unknown[] = [];
  const frames = [untilSnapshot(2400, true), untilSnapshot(1200, true), untilSnapshot(300, true)];
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => ({
      snapshot: frames[Math.min(scrolls.length, frames.length - 1)],
    }),
    scroll: async (_context, target, options) => {
      scrolls.push({ target, options });
      return { pixels: 480 };
    },
  });

  const result = await device.interactions.scroll({
    direction: 'down',
    until: 'label=Email',
  });

  assert.equal(result.until, 'label=Email');
  assert.equal(result.passes, 2);
  assert.equal(scrolls.length, 2);
  assert.match(String(result.message), /Scrolled down 2 passes until label=Email was visible/);
});

test('runtime scroll --until performs no gesture when the target is already on screen', async () => {
  const scrolls: unknown[] = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => ({ snapshot: untilSnapshot(300, true) }),
    scroll: async () => {
      scrolls.push('scrolled');
      return {};
    },
  });

  const result = await device.interactions.scroll({ direction: 'down', until: 'label=Email' });

  assert.equal(result.passes, 0);
  assert.equal(scrolls.length, 0);
  assert.match(String(result.message), /already visible/);
});

test('runtime scroll --until fails with the end-of-content reason when the list runs out', async () => {
  // Nothing below the fold and nothing hidden: the same signal `scroll bottom` stops on.
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => ({ snapshot: untilSnapshot(300, false) }),
    scroll: async () => ({}),
  });

  await assert.rejects(
    () => device.interactions.scroll({ direction: 'down', until: 'label=Missing' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'scroll_until_edge_reached');
      return true;
    },
  );
});

test('runtime scroll --until is refused on the edge directions, which already carry a stop condition', async () => {
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => ({ snapshot: untilSnapshot(300, true) }),
    scroll: async () => {
      throw new Error('scroll should be rejected before any backend call');
    },
  });

  await assert.rejects(
    () => device.interactions.scroll({ direction: 'bottom', until: 'label=Email' }),
    /scroll bottom already scrolls to the bottom edge and cannot take --until/,
  );
});

/**
 * The defect this pins: a capture that comes back unreadable used to reach the edge analyzer as an
 * empty tree, which reads it as "no room below" and reported end-of-content. A failed read is not
 * evidence about the content.
 */
test('runtime scroll --until reports an unreadable capture as a capture failure, not end-of-content', async () => {
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => ({ nodes: [] }),
    scroll: async () => ({}),
  });

  await assert.rejects(
    () => device.interactions.scroll({ direction: 'down', until: 'label=Email' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'scroll_until_capture_unreadable');
      assert.equal(error.details?.captureRefusal, 'no-capture');
      return true;
    },
  );
});

test('runtime scroll --until refuses a sparse capture rather than trusting its selectors', async () => {
  const device = createInteractionDevice(selectorSnapshot(), {
    captureSnapshot: async () => ({
      snapshot: {
        ...untilSnapshot(2400, true),
        snapshotQuality: { state: 'sparse', backend: 'tree', reason: 'AX bridge unavailable' },
      },
    }),
    scroll: async () => ({}),
  });

  await assert.rejects(
    () => device.interactions.scroll({ direction: 'down', until: 'label=Email' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.captureRefusal, 'sparse-tree');
      return true;
    },
  );
});
