import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isKnownCliCommandName } from '../../../command-catalog.ts';
import { AppError } from '../../../kernel/errors.ts';
import { parseArgs } from '../args.ts';
import { listCommandAliasSuggestionEntries, suggestCommandFor } from '../command-suggestions.ts';

// Guards against the curated alias map drifting to a command that no longer
// exists (renamed, removed, gated) in the live command registry.
test('every curated alias suggestion target resolves to a registered command', () => {
  for (const [guess, suggestion] of listCommandAliasSuggestionEntries()) {
    assert.ok(
      isKnownCliCommandName(suggestion.command),
      `alias suggestion for "${guess}" points at unregistered command "${suggestion.command}"`,
    );
    assert.ok(
      suggestion.example === suggestion.command ||
        suggestion.example.startsWith(`${suggestion.command} `),
      `alias suggestion example for "${guess}" ("${suggestion.example}") must start with its command ("${suggestion.command}")`,
    );
  }
});

test('relaunch suggests the canonical open --relaunch shape', () => {
  assert.throws(
    () => parseArgs(['relaunch', 'com.example.app']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown command: relaunch. Did you mean open <app> --relaunch?',
  );
});

for (const guess of ['launch', 'start', 'restart']) {
  test(`${guess} suggests the canonical open --relaunch shape`, () => {
    assert.throws(
      () => parseArgs([guess, 'com.example.app']),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message.includes('Did you mean open <app> --relaunch?'),
    );
  });
}

test('touch suggests press', () => {
  assert.throws(
    () => parseArgs(['touch', '100', '200']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown command: touch. Did you mean press?',
  );
});

test('dismiss suggests keyboard dismiss', () => {
  assert.throws(
    () => parseArgs(['dismiss']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown command: dismiss. Did you mean keyboard dismiss?',
  );
});

test('input and settext suggest fill', () => {
  for (const guess of ['input', 'settext', 'entertext']) {
    assert.throws(
      () => parseArgs([guess, '@e1', 'hello']),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message === `Unknown command: ${guess}. Did you mean fill?`,
    );
  }
});

test('screencap and capture suggest screenshot', () => {
  for (const guess of ['screencap', 'capture']) {
    assert.throws(
      () => parseArgs([guess]),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message === `Unknown command: ${guess}. Did you mean screenshot?`,
    );
  }
});

test('nonsense command names fall back to nearest-name suggestion or a plain error, never a crash', () => {
  assert.throws(
    () => parseArgs(['frobnicate']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown command: frobnicate',
  );
});

test('near-miss typos of real commands are suggested via edit distance', () => {
  assert.throws(
    () => parseArgs(['presss', '100', '200']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown command: presss. Did you mean press?',
  );
});

test('suggestCommandFor never throws for arbitrary input', () => {
  const inputs = ['', ' ', '@#$%', 'a'.repeat(200), 'RELAUNCH', 'Relaunch'];
  for (const input of inputs) {
    assert.doesNotThrow(() => suggestCommandFor(input));
  }
});

test('unknown flag that looks like an app/bundle id hints at the open positional', () => {
  assert.throws(
    () => parseArgs(['launch', '--bundle-id', 'com.example.app']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message ===
        'Unknown flag: --bundle-id. The app or bundle id is a positional argument, e.g. open <app> --relaunch.',
  );
});

test('unrelated unknown flags are unaffected', () => {
  assert.throws(
    () => parseArgs(['press', '100', '200', '--not-a-real-flag']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown flag: --not-a-real-flag',
  );
});
