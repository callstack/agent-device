import { test, expect } from 'vitest';
import {
  parseFillTarget,
  parseLongPressTarget,
  parseTouchTarget,
} from '../interaction-touch-targets.ts';

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

// --- Multi-ref press sequence (`press @e13,@e14,...`) ---

test('parseTouchTarget decodes a comma-separated ref sequence for press', () => {
  const parsed = parseTouchTarget(['@e13,@e14,@e15,@e16'], 'press');

  expect(parsed).toEqual({
    ok: true,
    target: { kind: 'ref', ref: '@e13' },
    refs: ['e13', 'e14', 'e15', 'e16'],
    refGenerations: [undefined, undefined, undefined, undefined],
  });
});

test('parseTouchTarget decodes pinned members and keeps their generations', () => {
  const parsed = parseTouchTarget(['@e1~s4,@e2'], 'press');

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.target).toEqual({ kind: 'ref', ref: '@e1' });
  expect(parsed.refs).toEqual(['e1', 'e2']);
  expect(parsed.refGenerations).toEqual([4, undefined]);
});

test('parseTouchTarget accepts the sequence form for click and rejects it for other commands', () => {
  expect(parseTouchTarget(['@e1,@e2'], 'click').ok).toBe(true);
  expect(parseTouchTarget(['@e1,@e2'], 'longpress').ok).toBe(false);
  expect(parseTouchTarget(['@e1,@e2'], 'hover').ok).toBe(false);
});

test('parseTouchTarget rejects a sequence with an empty member', () => {
  for (const positional of ['@e1,,@e2', '@e1,', '@e1,,']) {
    const parsed = parseTouchTarget([positional], 'press');
    expect(parsed.ok, positional).toBe(false);
  }
  // A single @ref without a comma stays the plain single-ref path.
  expect(parseTouchTarget(['@e1'], 'press').ok).toBe(true);
});

test('parseTouchTarget keeps a comma token without a leading @ on the selector path', () => {
  // A malformed list that never opens with @ is today's selector text, not a sequence.
  expect(parseTouchTarget([',@e1'], 'press')).toEqual({
    ok: true,
    target: { kind: 'selector', selector: ',@e1' },
  });
});

test('parseTouchTarget rejects duplicate members and non-ref members', () => {
  expect(parseTouchTarget(['@e1,@e1'], 'press').ok).toBe(false);
  expect(parseTouchTarget(['@e1,label'], 'press').ok).toBe(false);
});

test('parseTouchTarget rejects a sequence above the 16-ref bound', () => {
  const positional = Array.from({ length: 17 }, (_, index) => `@e${index + 1}`).join(',');
  expect(parseTouchTarget([positional], 'press').ok).toBe(false);
  const atBound = Array.from({ length: 16 }, (_, index) => `@e${index + 1}`).join(',');
  expect(parseTouchTarget([atBound], 'press').ok).toBe(true);
});

test('parseTouchTarget keeps the fallback label path for a plain ref with trailing text', () => {
  const parsed = parseTouchTarget(['@e4', 'Email field'], 'press');
  expect(parsed).toEqual({
    ok: true,
    target: { kind: 'ref', ref: '@e4', fallbackLabel: 'Email field' },
  });
});

test('parseTouchTarget refuses a space-separated second ref on press and click', () => {
  // `press @e13 @e14` is the comma plan typed with spaces; on the single-ref
  // path the second positional would become a fallback label and only the
  // first key would ever be pressed.
  for (const command of ['press', 'click'] as const) {
    const parsed = parseTouchTarget(['@e13', '@e14'], command);
    expect(parsed.ok, command).toBe(false);
    if (parsed.ok || parsed.response.ok) continue;
    expect(parsed.response.error.code).toBe('INVALID_ARGS');
    expect(parsed.response.error.message).toContain('Separate the keys');
    expect(parsed.response.error.hint).toBeTruthy();
  }
  // A pinned second ref is the same mistake.
  expect(parseTouchTarget(['@e13', '@e14~s4'], 'press').ok).toBe(false);
  // Commands outside the tap family keep today's trailing-text behavior: the
  // second positional stays a fallback label there.
  expect(parseTouchTarget(['@e1', '@e2'], 'longpress').ok).toBe(true);
});

test('parseTouchRefSequence refuses a trailing positional after the plan', () => {
  // A plan is one positional; a trailing token must not be dropped silently
  // while the single-ref path reads the same shape as a fallback label.
  const parsed = parseTouchTarget(['@e13,@e14', 'stray'], 'press');
  expect(parsed.ok).toBe(false);
  if (parsed.ok || parsed.response.ok) return;
  expect(parsed.response.error.code).toBe('INVALID_ARGS');
  expect(parsed.response.error.message).toContain('takes no trailing label');
});
