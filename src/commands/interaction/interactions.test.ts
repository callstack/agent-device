import { expect, test } from 'vitest';
import { interactionCliReaders, interactionDaemonWriters } from './interactions.ts';
import { selectorCliReaders } from './selectors.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { CliFlags } from '@agent-device/contracts/command';

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

// The empty text has to survive the CLI grammar AND the daemon projection for `fill @e57 ""` to
// reach the runner as a clear (#2063); a missing text argument must still read as missing, so the
// reader distinguishes "no text positional" from "an empty one".

test('fill reads an empty text positional as an empty text, not a missing one', () => {
  const input = interactionCliReaders.fill(['@e57', ''], BASE_FLAGS);

  expect(input.text).toBe('');
});

test('fill reads a missing text positional as undefined so required validation fires', () => {
  expect(interactionCliReaders.fill(['@e57'], BASE_FLAGS).text).toBeUndefined();
  expect(interactionCliReaders.fill(['label="Email"'], BASE_FLAGS).text).toBeUndefined();
  expect(interactionCliReaders.fill(['10', '20'], BASE_FLAGS).text).toBeUndefined();
});

test('fill projects an empty text as its own positional', () => {
  const request = interactionDaemonWriters.fill({ ref: '@e57', text: '' });

  expect(request.positionals).toEqual(['@e57', '']);
});

test('fill --text-stdin reads only the target and leaves the text to stdin', () => {
  const flags = { ...BASE_FLAGS, textStdin: true };

  for (const positionals of [['@e57'], ['id="password"'], ['10', '20']]) {
    const input = interactionCliReaders.fill(positionals, flags);
    expect(input.text, positionals.join(' ')).toBeUndefined();
    expect(input.textStdin, positionals.join(' ')).toBe(true);
  }
});

test('fill --text-stdin refuses an unreadable target without echoing it', () => {
  for (const positionals of [['stray-secret'], ['e3stray'], ['stray secret words']]) {
    let caught: unknown;
    try {
      interactionCliReaders.fill(positionals, { ...BASE_FLAGS, textStdin: true });
    } catch (error) {
      caught = error;
    }
    expect(caught, positionals.join(' ')).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.details?.reason).toBe('fill_text_stdin_target_invalid');
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toMatch(/stray/);
  }
});

test('fill --text-stdin refuses a text argument without echoing it', () => {
  for (const positionals of [
    ['@e57', 'argv-secret'],
    ['@e57', ''],
    ['id="password"', 'argv-secret'],
    ['10', '20', 'argv-secret'],
  ]) {
    let caught: unknown;
    try {
      interactionCliReaders.fill(positionals, { ...BASE_FLAGS, textStdin: true });
    } catch (error) {
      caught = error;
    }
    expect(caught, positionals.join(' ')).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.code).toBe('INVALID_ARGS');
    expect(error.details?.reason).toBe('fill_text_source_conflict');
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toMatch(
      /argv-secret/,
    );
  }
});

// `find <q> fill ""` is the same clear request through the find grammar (#2063): the empty
// value reaches the typed options, while a missing value is refused at the reader so the typed
// `value: string` contract stays intact.
test('find fill reads an empty value as the clear request and refuses a missing one', () => {
  const cleared = selectorCliReaders.find(['text', 'Save', 'fill', ''], BASE_FLAGS);
  expect(cleared).toMatchObject({ action: 'fill', value: '' });

  expect(() => selectorCliReaders.find(['text', 'Save', 'fill'], BASE_FLAGS)).toThrow(
    /find fill requires text \(use "" to clear the field\)/,
  );
});
