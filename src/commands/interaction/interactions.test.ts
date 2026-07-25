import { expect, test } from 'vitest';
import { interactionCliReaders, interactionDaemonWriters } from './interactions.ts';
import { AppError } from '../../kernel/errors.ts';
import type { CliFlags } from '../../contracts/cli-flags.ts';

const BASE_FLAGS: CliFlags = { json: false, help: false, version: false };

test('swipe writes only typed daemon input', () => {
  const request = interactionDaemonWriters.swipe({
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    count: 2,
    pauseMs: 10,
    pattern: 'ping-pong',
  });

  expect(request.positionals).toEqual([]);
  expect(request.input).toEqual({
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    count: 2,
    pauseMs: 10,
    pattern: 'ping-pong',
  });
});

test('scroll reader rejects a @ref in the direction slot with a grammar hint (#1366)', () => {
  try {
    interactionCliReaders.scroll(['@e29'], BASE_FLAGS);
    expect.unreachable('scroll should reject a ref where a direction is expected');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('INVALID_ARGS');
    // The hint teaches the direction-first grammar and that scroll takes no target,
    // so the agent stops cycling `scroll @ref down` / `scroll down @ref`.
    expect(appError.details?.hint).toMatch(/direction first/i);
    expect(appError.details?.hint).toMatch(/no @ref or selector/i);
  }
});

test('fill projects recordAs through the typed daemon flags', () => {
  const request = interactionDaemonWriters.fill({
    selector: 'id="password"',
    text: 'live-secret',
    recordAs: 'PASSWORD',
  });

  expect(request.positionals).toEqual(['id="password"', 'live-secret']);
  expect(request.options.recordAs).toBe('PASSWORD');
});
