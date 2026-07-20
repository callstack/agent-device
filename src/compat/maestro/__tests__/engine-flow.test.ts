import { expect, test } from 'vitest';
import { resolveMaestroTimingPolicy } from '../compatibility-policy.ts';
import { resolveNumeric } from '../engine-flow.ts';

test('uses the Maestro-compatible extended wait default', () => {
  expect(resolveMaestroTimingPolicy().extendedWaitUntilTimeoutMs).toBe(17_000);
});

test('resolveNumeric coerces valid resolved strings and numbers', () => {
  expect(resolveNumeric('42', 'x', {})).toBe(42);
  expect(resolveNumeric('3.5', 'x', {})).toBe(3.5);
  expect(resolveNumeric(3.5, 'x', {})).toBe(3.5);
  expect(resolveNumeric('0', 'x', { integer: true, nonNegative: true })).toBe(0);
  expect(resolveNumeric('5', 'x', { integer: true, positive: true })).toBe(5);
  expect(resolveNumeric(5, 'x', { integer: true, positive: true })).toBe(5);
  expect(resolveNumeric(undefined, 'x', {})).toBeUndefined();
});

test('resolveNumeric rejects blank, whitespace, and malformed resolved strings', () => {
  expect(() => resolveNumeric('', 'x', {})).toThrow(/must be a finite number/);
  expect(() => resolveNumeric('   ', 'x', {})).toThrow(/must be a finite number/);
  expect(() => resolveNumeric('', 'x', { integer: true, nonNegative: true })).toThrow(
    /must be a non-negative integer/,
  );
  expect(() => resolveNumeric('  ', 'x', { integer: true, nonNegative: true })).toThrow(
    /must be a non-negative integer/,
  );
  expect(() => resolveNumeric('abc', 'x', {})).toThrow(/must be a finite number/);
  expect(() => resolveNumeric('1.2.3', 'x', {})).toThrow(/must be a finite number/);
  expect(() => resolveNumeric('1.5', 'x', { integer: true })).toThrow(/must be an integer/);
});
