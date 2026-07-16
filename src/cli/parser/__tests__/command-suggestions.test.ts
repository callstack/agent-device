import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isKnownCliCommandName } from '../../../command-catalog.ts';
import { keyboardCliReader } from '../../../commands/system/index.ts';
import { AppError } from '../../../kernel/errors.ts';
import { parseArgs } from '../args.ts';
import type { CliFlags } from '../../../commands/cli-grammar/flag-types.ts';
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

// Guards the full example shapes, not just the leading command token: every
// example must parse as a valid invocation (placeholders substituted), so a
// renamed flag (e.g. open --relaunch) or a dropped subcommand fails here.
test('every curated alias suggestion example parses as a valid invocation', () => {
  for (const [guess, suggestion] of listCommandAliasSuggestionEntries()) {
    const tokens = suggestion.example
      .split(' ')
      .map((token) => (token.startsWith('<') ? 'com.example.app' : token));
    assert.doesNotThrow(
      () => parseArgs(tokens, { strictFlags: true }),
      `alias suggestion example for "${guess}" ("${suggestion.example}") no longer parses`,
    );
  }
});

test('the keyboard dismiss example uses a real keyboard action', () => {
  const baseFlags: CliFlags = { json: false, help: false, version: false };
  assert.doesNotThrow(() => keyboardCliReader(['dismiss'], baseFlags));
});

// `launch`/`relaunch` and `tap` are true aliases normalized before the
// unknown-command check, so they must never appear in the suggestion map —
// a stale entry there would be dead code masking the alias.
test('true aliases are not listed in the curated suggestion map', () => {
  const guesses = new Set(listCommandAliasSuggestionEntries().map(([guess]) => guess));
  for (const alias of ['launch', 'relaunch', 'tap']) {
    assert.ok(!guesses.has(alias), `"${alias}" is a true alias and must not be a suggestion`);
  }
});

for (const guess of ['start', 'restart']) {
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

test('get-text, gettext, and get_text suggest get text', () => {
  for (const guess of ['get-text', 'gettext', 'get_text']) {
    assert.throws(
      () => parseArgs([guess]),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message === `Unknown command: ${guess}. Did you mean get text?`,
    );
  }
});

test('open-url suggests open <url>', () => {
  assert.throws(
    () => parseArgs(['open-url', 'https://example.com']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown command: open-url. Did you mean open <url>?',
  );
});

test('close-session suggests close', () => {
  assert.throws(
    () => parseArgs(['close-session']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown command: close-session. Did you mean close?',
  );
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

test('curated suggestions are case-insensitive', () => {
  assert.equal(suggestCommandFor('RESTART'), 'open <app> --relaunch');
  assert.equal(suggestCommandFor('Restart'), 'open <app> --relaunch');
  assert.equal(suggestCommandFor('Touch'), 'press');
  assert.equal(suggestCommandFor('DISMISS'), 'keyboard dismiss');
});

test('known command names in the wrong case suggest their lowercase form', () => {
  assert.equal(suggestCommandFor('OPEN'), 'open');
  assert.equal(suggestCommandFor('Press'), 'press');
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

test('a prefix match wins outright instead of bundling weaker edit-distance ties', () => {
  // Without the prefix rule, `clos` would suggest "one of: close, logs".
  assert.throws(
    () => parseArgs(['clos']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown command: clos. Did you mean close?',
  );
});

test('1-2 character tokens never get a nearest-name suggestion', () => {
  // `ls` is one edit from `is`, but suggesting `is` would be a false positive.
  assert.throws(
    () => parseArgs(['ls']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown command: ls',
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
