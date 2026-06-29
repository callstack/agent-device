import { test } from 'vitest';
import assert from 'node:assert/strict';
import { dispatchCommand } from '../dispatch.ts';
import { handleLongPressCommand, handleScrollCommand } from '../dispatch-interactions.ts';
import { AppError } from '../../kernel/errors.ts';
import type { Interactor } from '../interactor-types.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';

test('dispatch scroll rejects mixing amount and --pixels', async () => {
  await assert.rejects(
    () => dispatchCommand(IOS_SIMULATOR, 'scroll', ['down', '0.4'], undefined, { pixels: 240 }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /either a relative amount or --pixels/i.test(error.message),
  );
});

test('dispatch scroll forwards pixels and duration without reporting ignored duration', async () => {
  const calls: Array<{ direction: string; options: unknown }> = [];
  const interactor = {
    scroll: async (direction: any, options: unknown) => {
      calls.push({ direction, options });
      return { ok: true };
    },
  } as unknown as Interactor;

  const result = await handleScrollCommand(interactor, ['down'], {
    pixels: 200,
    durationMs: 50,
  });

  assert.deepEqual(calls, [
    {
      direction: 'down',
      options: { amount: undefined, pixels: 200, durationMs: 50 },
    },
  ]);
  assert.equal(result.pixels, 200);
  assert.equal(result.durationMs, undefined);
});

test('dispatch scroll reports duration when the interactor honored it', async () => {
  const interactor = {
    scroll: async () => ({ pixels: 200, durationMs: 50 }),
  } as unknown as Interactor;

  const result = await handleScrollCommand(interactor, ['down'], {
    pixels: 200,
    durationMs: 50,
  });

  assert.equal(result.pixels, 200);
  assert.equal(result.durationMs, 50);
});

test('dispatch scroll rejects duration above the shared cap', async () => {
  const interactor = {
    scroll: async () => {
      throw new Error('scroll should be rejected before backend call');
    },
  } as unknown as Interactor;

  await assert.rejects(
    () => handleScrollCommand(interactor, ['down'], { pixels: 200, durationMs: 10_001 }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /durationMs.*at most 10000/i.test(error.message),
  );
});

test('dispatch scroll bottom rejects blind scrolling without snapshot support', async () => {
  const calls: Array<{ direction: string; options: unknown }> = [];
  const interactor = {
    scroll: async (direction: any, options: unknown) => {
      calls.push({ direction, options });
      return { lastPass: calls.length };
    },
  } as unknown as Interactor;

  await assert.rejects(
    () => handleScrollCommand(interactor, ['bottom'], undefined),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      /requires snapshot support/i.test(error.message),
  );

  assert.equal(calls.length, 0);
});

test('dispatch longpress explains direct platform coordinate requirement', async () => {
  const interactor = {} as unknown as Interactor;

  await assert.rejects(
    () => handleLongPressCommand(interactor, ['@e40', '900']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /longpress requires x y/i.test(error.message) &&
      /open daemon session/i.test(String(error.details?.hint)) &&
      /snapshot -i/i.test(String(error.details?.hint)),
  );
});

test('dispatch scroll bottom does not scroll when no hidden content is below', async () => {
  const calls: Array<{ direction: string; options: unknown }> = [];
  const interactor = {
    scroll: async (direction: any, options: unknown) => {
      calls.push({ direction, options });
      return { lastPass: calls.length };
    },
    snapshot: async () => makeScrollSnapshot({ hiddenBelow: false, message: 'Latest message' }),
  } as unknown as Interactor;

  const result = await handleScrollCommand(interactor, ['bottom'], undefined);

  assert.equal(calls.length, 0);
  assert.equal(result.direction, 'down');
  assert.equal(result.edge, 'bottom');
  assert.equal(result.passes, 0);
  assert.match(String(result.message), /Already at bottom/);
});

test('dispatch scroll bottom scrolls only while scoped snapshot confirms hidden content', async () => {
  const calls: Array<{ direction: string; options: unknown }> = [];
  const snapshotScopes: unknown[] = [];
  const snapshots = [
    makeScrollSnapshot({ hiddenBelow: true, message: 'Middle message' }),
    makeScrollSnapshot({ hiddenBelow: true, message: 'Middle message' }),
    makeScrollSnapshot({ hiddenBelow: false, message: 'Latest message' }),
  ];
  const interactor = {
    scroll: async (direction: any, options: unknown) => {
      calls.push({ direction, options });
      return { lastPass: calls.length };
    },
    snapshot: async (options: any) => {
      snapshotScopes.push(options.scope);
      return snapshots[Math.min(snapshotScopes.length - 1, snapshots.length - 1)];
    },
  } as unknown as Interactor;

  const result = await handleScrollCommand(interactor, ['bottom'], undefined);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    direction: 'down',
    options: { amount: undefined, pixels: undefined, durationMs: undefined },
  });
  assert.equal(result.passes, 1);
  assert.equal(result.lastPass, 1);
  assert.deepEqual(snapshotScopes, [undefined, 'Messages', 'Messages']);
});

test('dispatch scroll bottom tolerates unchanged signatures while hidden content advances', async () => {
  const calls: Array<{ direction: string; options: unknown }> = [];
  const snapshots = [
    makeScrollSnapshot({ hiddenBelow: true, message: 'Repeated row' }),
    makeScrollSnapshot({ hiddenBelow: true, message: 'Repeated row' }),
    makeScrollSnapshot({ hiddenBelow: true, message: 'Repeated row' }),
    makeScrollSnapshot({ hiddenBelow: false, message: 'Repeated row' }),
  ];
  let snapshotIndex = 0;
  const interactor = {
    scroll: async (direction: any, options: unknown) => {
      calls.push({ direction, options });
      return { lastPass: calls.length };
    },
    snapshot: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
  } as unknown as Interactor;

  const result = await handleScrollCommand(interactor, ['bottom'], undefined);

  assert.equal(calls.length, 2);
  assert.equal(result.passes, 2);
});

test('dispatch scroll bottom keeps scoped snapshot failures scoped', async () => {
  let snapshotCount = 0;
  const interactor = {
    scroll: async () => ({}),
    snapshot: async (options: any) => {
      snapshotCount += 1;
      if (options.scope) throw new Error('scoped snapshot failed');
      return makeScrollSnapshot({ hiddenBelow: true, message: 'Middle message' });
    },
  } as unknown as Interactor;

  await assert.rejects(
    () => handleScrollCommand(interactor, ['bottom'], undefined),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      /scoped container/i.test(error.message) &&
      error.details?.scope === 'Messages',
  );
  assert.equal(snapshotCount, 2);
});

function makeScrollSnapshot(options: { hiddenBelow: boolean; message: string }) {
  return {
    backend: 'xctest' as const,
    nodes: [
      {
        index: 1,
        type: 'ScrollView',
        label: 'Messages',
        hiddenContentBelow: options.hiddenBelow ? true : undefined,
        rect: { x: 0, y: 100, width: 400, height: 600 },
      },
      {
        index: 2,
        parentIndex: 1,
        type: 'Button',
        label: options.message,
        rect: { x: 0, y: 640, width: 400, height: 56 },
      },
    ],
    truncated: false,
  };
}
