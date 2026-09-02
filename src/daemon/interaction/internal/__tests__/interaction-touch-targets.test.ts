import { test, expect } from 'vitest';
import {
  parseFillTarget,
  parseLongPressTarget,
  parseTouchTarget,
} from '../interaction-touch-targets.ts';

test('parseTouchTarget preserves ref fallback label through shared grammar', () => {
  const parsed = parseTouchTarget(['@e4', 'Email field'], 'press');

  expect(parsed).toEqual({
    ok: true,
    target: {
      kind: 'ref',
      ref: '@e4',
      fallbackLabel: 'Email field',
    },
  });
});

test('parseTouchTarget trims ref fallback label', () => {
  const parsed = parseTouchTarget(['@e4', '  Email field  '], 'press');

  expect(parsed).toEqual({
    ok: true,
    target: {
      kind: 'ref',
      ref: '@e4',
      fallbackLabel: 'Email field',
    },
  });
});

test('parseTouchTarget keeps invalid coordinates as selector text', () => {
  const parsed = parseTouchTarget(['12', 'not-y'], 'press');

  expect(parsed).toEqual({
    ok: true,
    target: {
      kind: 'selector',
      selector: '12 not-y',
    },
  });
});

test('parseFillTarget reads selector text through shared grammar', () => {
  const parsed = parseFillTarget(['label="Email"', 'qa@example.com']);

  expect(parsed).toEqual({
    ok: true,
    target: {
      kind: 'selector',
      selector: 'label="Email"',
    },
    text: 'qa@example.com',
  });
});

test('parseFillTarget preserves selector text whitespace', () => {
  const parsed = parseFillTarget(['label="Command"', 'submit\n']);

  expect(parsed).toEqual({
    ok: true,
    target: {
      kind: 'selector',
      selector: 'label="Command"',
    },
    text: 'submit\n',
  });
});

test('parseFillTarget rejects invalid coordinates instead of treating them as a point', () => {
  const parsed = parseFillTarget(['10', 'not-y', 'text']);

  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.response.ok).toBe(false);
    if (!parsed.response.ok) {
      expect(parsed.response.error.message).toBe(
        'fill requires x y text, @ref text, or selector text',
      );
    }
  }
});

// --- Versioned refs (#1076): the daemon boundary splits `@e12~s3` pins ---

test('parseTouchTarget splits a pinned ref into plain ref + generation', () => {
  const parsed = parseTouchTarget(['@e4~s12', 'Email field'], 'press');

  expect(parsed).toEqual({
    ok: true,
    target: {
      kind: 'ref',
      ref: '@e4',
      fallbackLabel: 'Email field',
    },
    refGeneration: 12,
  });
});

test('parseTouchTarget rejects a malformed generation suffix with the grammar hint', () => {
  const parsed = parseTouchTarget(['@e4~s'], 'press');

  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        message: expect.stringContaining('malformed generation suffix'),
        details: { hint: expect.stringContaining('@e12~s3') },
      },
    });
  }
});

test('parseLongPressTarget carries the pinned generation past the trailing duration', () => {
  const parsed = parseLongPressTarget(['@e4~s7', '800']);

  expect(parsed).toEqual({
    ok: true,
    target: {
      kind: 'ref',
      ref: '@e4',
      fallbackLabel: '',
    },
    refGeneration: 7,
    durationMs: 800,
  });
});

test('parseFillTarget splits a pinned ref and keeps the text intact', () => {
  const parsed = parseFillTarget(['@e4~s3', 'qa@example.com']);

  expect(parsed).toEqual({
    ok: true,
    target: {
      kind: 'ref',
      ref: '@e4',
    },
    refGeneration: 3,
    text: 'qa@example.com',
  });
});

test('parseFillTarget does not reinterpret the first word of ref text as a fallback label', () => {
  const parsed = parseFillTarget(['@e4~s3', 'good', 'morning']);

  expect(parsed).toEqual({
    ok: true,
    target: {
      kind: 'ref',
      ref: '@e4',
    },
    refGeneration: 3,
    text: 'good morning',
  });
});

test('parseFillTarget rejects a malformed pinned ref before reading text', () => {
  const parsed = parseFillTarget(['@e4~x3', 'text']);

  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.response).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGS' },
    });
  }
});

// `fill <target> ""` is the clear-field primitive (#2063). Empty text is a VALUE here; only a
// missing text argument is an error. Whitespace-only text keeps its established per-shape rule:
// payload on ref/coordinate fills, refused on selector fills.

test('parseFillTarget accepts an empty text after a ref as the clear request', () => {
  const parsed = parseFillTarget(['@e57', '']);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.text).toBe('');
});

test('parseFillTarget accepts an empty text after a selector and after coordinates', () => {
  const selectorParsed = parseFillTarget(['label="Email"', '']);
  expect(selectorParsed.ok).toBe(true);
  if (selectorParsed.ok) expect(selectorParsed.text).toBe('');

  const pointParsed = parseFillTarget(['10', '20', '']);
  expect(pointParsed.ok).toBe(true);
  if (pointParsed.ok) expect(pointParsed.text).toBe('');
});

test('parseFillTarget still refuses a missing text argument on every target shape', () => {
  for (const positionals of [['@e57'], ['label="Email"'], ['10', '20']]) {
    expect(parseFillTarget(positionals).ok, positionals.join(' ')).toBe(false);
  }
});

test('parseFillTarget keeps the established whitespace-only rules', () => {
  // Payload whitespace on a ref fill (Maestro/keyboard-enter newlines) is preserved …
  const refParsed = parseFillTarget(['@e57', '   ']);
  expect(refParsed.ok).toBe(true);
  if (refParsed.ok) expect(refParsed.text).toBe('   ');
  // … while a blank selector-fill argument stays a mistake.
  expect(parseFillTarget(['label="Email"', '   ']).ok).toBe(false);
});
