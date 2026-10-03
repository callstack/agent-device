import { expect, test } from 'vitest';
import {
  isReadOnlyFindAction,
  parseFindArgs,
  parseFindSelectorExpression,
  UNSUPPORTED_FIND_ACTION_HINT,
} from './find.ts';

test('parseFindArgs defaults to click with any locator', () => {
  const parsed = parseFindArgs(['Login']);
  expect(parsed.locator).toBe('any');
  expect(parsed.query).toBe('Login');
  expect(parsed.action).toBe('click');
});

test('parseFindArgs rejects invalid get sub-action', () => {
  expect(() => parseFindArgs(['text', 'Settings', 'get', 'foo'])).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining('find get only supports text or attrs'),
    }),
  );
});

test('parseFindArgs wait without timeout leaves timeoutMs undefined', () => {
  const parsed = parseFindArgs(['text', 'Loading', 'wait']);
  expect(parsed.action).toBe('wait');
  expect(parsed.timeoutMs).toBeUndefined();
});

test('parseFindArgs wait with non-numeric timeout leaves timeoutMs undefined', () => {
  const parsed = parseFindArgs(['text', 'Loading', 'wait', 'abc']);
  expect(parsed.action).toBe('wait');
  expect(parsed.timeoutMs).toBeUndefined();
});

test('parseFindArgs throws on unsupported action', () => {
  expect(() => parseFindArgs(['text', 'OK', 'swipe'])).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining('Unsupported find action: swipe'),
    }),
  );
});

// #1597: a bare "Unsupported find action" left the agent no path forward
// besides guessing — the hint must name every action find actually supports
// and show the two-command recovery shape (resolve the ref via find, then
// dispatch the gesture, e.g. press, as its own command).
test('parseFindArgs attaches the supported-actions hint with the two-step recovery shape on an unsupported action', () => {
  try {
    parseFindArgs(['text', 'Follow', 'longpress']);
    expect.unreachable('parseFindArgs should have thrown for an unsupported action');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'INVALID_ARGS',
      message: 'Unsupported find action: longpress',
      details: { hint: UNSUPPORTED_FIND_ACTION_HINT },
    });
  }
  expect(UNSUPPORTED_FIND_ACTION_HINT).toContain('click (default; press/tap are aliases)');
  expect(UNSUPPORTED_FIND_ACTION_HINT).toContain('list');
  expect(UNSUPPORTED_FIND_ACTION_HINT).toContain('focus');
  expect(UNSUPPORTED_FIND_ACTION_HINT).toContain('fill');
  expect(UNSUPPORTED_FIND_ACTION_HINT).toContain('type');
  expect(UNSUPPORTED_FIND_ACTION_HINT).toContain('exists');
  expect(UNSUPPORTED_FIND_ACTION_HINT).toContain('wait');
  expect(UNSUPPORTED_FIND_ACTION_HINT).toContain('get text');
  expect(UNSUPPORTED_FIND_ACTION_HINT).toContain('get attrs');
  // #1625: inspection guidance must point at the read-only list action, never
  // at bare `find` (which clicks a unique match).
  expect(UNSUPPORTED_FIND_ACTION_HINT).toMatch(/find "<text>" list to inspect/);
  expect(UNSUPPORTED_FIND_ACTION_HINT).not.toMatch(/find "<text>" to list matches/);
});

test('parseFindArgs accepts press and tap as click aliases (#1625)', () => {
  expect(parseFindArgs(['text', 'Follow', 'press']).action).toBe('click');
  expect(parseFindArgs(['Follow', 'tap']).action).toBe('click');
  expect(parseFindArgs(['Follow', 'PRESS']).action).toBe('click');
});

test('parseFindArgs parses the read-only list action (#1625)', () => {
  const parsed = parseFindArgs(['text', 'Settings', 'list']);
  expect(parsed.action).toBe('list');
  expect(isReadOnlyFindAction(parsed.action)).toBe(true);
});

test('parseFindArgs with bare locator yields empty query', () => {
  const parsed = parseFindArgs(['text']);
  expect(parsed.locator).toBe('text');
  expect(parsed.query).toBe('');
  expect(parsed.action).toBe('click');
});

test('parseFindSelectorExpression only treats bare selector-shaped queries as selectors', () => {
  const parsed = parseFindSelectorExpression('any', 'label="Continue"');
  expect(parsed).toBe('label="Continue"');

  expect(parseFindSelectorExpression('text', 'label="Continue"')).toBeNull();
  expect(parseFindSelectorExpression('any', 'a=b')).toBeNull();
});

// `find <q> fill ""` is the clear request (#2063): an EMPTY value token must survive the parse,
// while NO value token reads as undefined so the handler's missing-text refusal still fires —
// the parse used to collapse both to ''.
test('parseFindArgs distinguishes an empty fill value from a missing one', () => {
  const cleared = parseFindArgs(['text', 'Save', 'fill', '']);
  expect(cleared).toMatchObject({ action: 'fill', value: '' });

  const missing = parseFindArgs(['text', 'Save', 'fill']);
  expect(missing.action).toBe('fill');
  expect(missing.value).toBeUndefined();
});

// #1271 stage 2: `--record` is statically scoped to snapshot/get/is via each
// command schema's `allowedFlags`, but `find`'s observe-vs-mutate split is a
// POSITIONAL, so it is validated dynamically against this shared predicate.
test('isReadOnlyFindAction separates the find sub-actions --record may accompany', () => {
  for (const action of ['exists', 'wait', 'get_text', 'get_attrs'] as const) {
    expect(isReadOnlyFindAction(action)).toBe(true);
  }
  for (const action of ['click', 'fill', 'focus', 'type'] as const) {
    expect(isReadOnlyFindAction(action)).toBe(false);
  }
});
