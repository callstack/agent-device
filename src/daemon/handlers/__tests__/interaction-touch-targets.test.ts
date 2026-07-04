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
      fallbackLabel: '',
    },
    refGeneration: 3,
    text: 'qa@example.com',
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
