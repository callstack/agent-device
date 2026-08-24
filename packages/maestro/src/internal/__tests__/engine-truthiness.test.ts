import { describe, expect, test } from 'vitest';
import { isMaestroConditionTruthy } from '../engine-truthiness.ts';

// assertTrue phase 1 (#1295): pin the string-value truthiness table explicitly
// rather than relying on native JS coercion (which would treat every non-empty
// string, including "false", as truthy). See engine-truthiness.ts for the
// rationale — values arriving through a ${VAR} lookup are always strings.
describe('isMaestroConditionTruthy', () => {
  test.each([
    ['', false],
    ['false', false],
    ['0', false],
    ['null', false],
    ['undefined', false],
  ])('string %j is falsy', (value, expected) => {
    expect(isMaestroConditionTruthy(value)).toBe(expected);
  });

  test.each([
    ['False', true], // case-sensitive: only the exact lowercase sentinels are falsy
    ['FALSE', true],
    [' ', true],
    ['0.0', true],
    ['-0', true],
    ['42', true],
    ['-1', true],
    ['{}', true],
    ['[]', true],
    ['{"flag":false}', true],
    ['[1,2,3]', true],
    ['hello', true],
    ['nonEmptyString', true],
  ])('string %j is truthy', (value, expected) => {
    expect(isMaestroConditionTruthy(value)).toBe(expected);
  });

  test('booleans use native JS truthiness', () => {
    expect(isMaestroConditionTruthy(true)).toBe(true);
    expect(isMaestroConditionTruthy(false)).toBe(false);
  });

  test('numbers use native JS truthiness', () => {
    expect(isMaestroConditionTruthy(0)).toBe(false);
    expect(isMaestroConditionTruthy(Number.NaN)).toBe(false);
    expect(isMaestroConditionTruthy(1)).toBe(true);
    expect(isMaestroConditionTruthy(-1)).toBe(true);
    expect(isMaestroConditionTruthy(123)).toBe(true);
  });
});
