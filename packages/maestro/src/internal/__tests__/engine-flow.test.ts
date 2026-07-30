import { expect, test } from 'vitest';
import { DEFAULT_MAESTRO_COMPATIBILITY_TIMING_POLICY } from '../compatibility-policy.ts';
import { resolveNumeric } from '../engine-flow.ts';

test('uses the Maestro-compatible extended wait default', () => {
  expect(DEFAULT_MAESTRO_COMPATIBILITY_TIMING_POLICY.extendedWaitUntilTimeoutMs).toBe(17_000);
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

test('resolveNumeric trims whitespace before coercion', () => {
  expect(resolveNumeric('  42  ', 'x', {})).toBe(42);
  expect(resolveNumeric('  0  ', 'x', { integer: true, nonNegative: true })).toBe(0);
});

test('resolveNumeric accepts JS numeric forms for backward compatibility', () => {
  expect(resolveNumeric('1e3', 'x', {})).toBe(1000);
  expect(resolveNumeric('+5', 'x', {})).toBe(5);
  expect(resolveNumeric('.5', 'x', {})).toBe(0.5);
});

test('resolveNumeric rejects blank, whitespace, malformed, and unsafe resolved strings', () => {
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

test('resolveNumeric rejects out-of-range and negative values per constraints', () => {
  const huge = String(Number.MAX_SAFE_INTEGER + 1);
  expect(() => resolveNumeric(huge, 'x', {})).toThrow(/must be a finite number/);
  expect(() => resolveNumeric('-1', 'x', { nonNegative: true })).toThrow(
    /must be a non-negative finite number/,
  );
  expect(() => resolveNumeric('0', 'x', { integer: true, positive: true })).toThrow(
    /must be a positive integer/,
  );
});

test('resolveNumeric resolves constraints from the shared field map when omitted', () => {
  expect(resolveNumeric('1000', 'extendedWaitUntil.timeout')).toBe(1000);
  expect(() => resolveNumeric('-1', 'extendedWaitUntil.timeout')).toThrow(
    /must be a non-negative finite number/,
  );
  expect(resolveNumeric('5', 'tapOn.repeat')).toBe(5);
  expect(() => resolveNumeric('0', 'tapOn.repeat')).toThrow(/must be a positive integer/);
});
