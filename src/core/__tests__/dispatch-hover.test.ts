import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import type { Interactor } from '@agent-device/contracts/interaction';
import { handleHoverCommand } from '../dispatch-interactions.ts';

// #1783: the direct-dispatch hover handler (the core seam the daemon's web
// backend calls, and what `agent-device hover x y` reaches without a session).

test('dispatch hover moves the pointer through the interactor and reports the point', async () => {
  const calls: Array<[number, number]> = [];
  const interactor = {
    hover: async (x: number, y: number) => {
      calls.push([x, y]);
    },
  } as unknown as Interactor;

  const result = await handleHoverCommand(interactor, ['155', '172']);

  assert.deepEqual(calls, [[155, 172]]);
  assert.equal(result.x, 155);
  assert.equal(result.y, 172);
  assert.match(String(result.message), /Hovered \(155, 172\)/);
});

test('dispatch hover refuses platforms whose interactor has no pointer', async () => {
  const interactor = {} as unknown as Interactor;

  await assert.rejects(
    () => handleHoverCommand(interactor, ['10', '10']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      /hover is not supported on this platform/i.test(error.message) &&
      /web targets only/i.test(String(error.details?.hint)),
  );
});

test('dispatch hover explains the direct platform coordinate requirement', async () => {
  const interactor = { hover: async () => {} } as unknown as Interactor;

  await assert.rejects(
    () => handleHoverCommand(interactor, ['@e40']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /hover requires x y/i.test(error.message) &&
      /open daemon session/i.test(String(error.details?.hint)),
  );
});
