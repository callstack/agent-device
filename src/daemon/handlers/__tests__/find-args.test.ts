import { expect, test } from 'vitest';
import {
  isReadOnlyFindAction,
  parseFindArgs,
  parseFindSelectorExpression,
} from '../../../selectors/find.ts';

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

test('parseFindArgs with bare locator yields empty query', () => {
  const parsed = parseFindArgs(['text']);
  expect(parsed.locator).toBe('text');
  expect(parsed.query).toBe('');
  expect(parsed.action).toBe('click');
});

test('parseFindSelectorExpression only treats bare selector-shaped queries as selectors', () => {
  const parsed = parseFindSelectorExpression('any', 'label="Continue"');
  expect(parsed?.raw).toBe('label="Continue"');

  expect(parseFindSelectorExpression('text', 'label="Continue"')).toBeNull();
  expect(parseFindSelectorExpression('any', 'a=b')).toBeNull();
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
