import { expect, test } from 'vitest';
import { parseFindArgs, parseFindSelectorExpression } from '../../../utils/finders.ts';

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
