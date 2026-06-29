import assert from 'node:assert/strict';
import { test, expect } from 'vitest';
import { AppError } from '../../../kernel/errors.ts';
import { formatMaestroPoint, parseAbsolutePoint, parseMaestroPoint } from '../points.ts';

test('formatMaestroPoint serializes coordinate pairs', () => {
  expect(formatMaestroPoint(100, 200)).toBe('100,200');
  expect(formatMaestroPoint('50%', '75%')).toBe('50%,75%');
});

test('parseMaestroPoint parses absolute pixel coordinates', () => {
  expect(parseMaestroPoint('100,200')).toEqual({ kind: 'absolute', x: 100, y: 200 });
  expect(parseMaestroPoint(' 320 , 640 ')).toEqual({ kind: 'absolute', x: 320, y: 640 });
});

test('parseMaestroPoint parses percentage coordinates including decimals', () => {
  expect(parseMaestroPoint('50%,75%')).toEqual({ kind: 'percent', x: 50, y: 75 });
  expect(parseMaestroPoint('12.5%, 99.9%')).toEqual({ kind: 'percent', x: 12.5, y: 99.9 });
});

test('parseMaestroPoint rejects mixed or malformed coordinate expressions', () => {
  for (const value of ['50%,75', '50,75%', '100;200', '-10,20', '100.5,200', '']) {
    assert.throws(
      () => parseMaestroPoint(value),
      (error) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message.includes(
          'Only Maestro swipe coordinates like "100,200" or "50%,75%" are supported.',
        ),
      `expected rejection for ${JSON.stringify(value)}`,
    );
  }
});

test('parseAbsolutePoint accepts only absolute pixel coordinates', () => {
  expect(parseAbsolutePoint('100,200')).toEqual({ x: 100, y: 200 });
  assert.throws(
    () => parseAbsolutePoint('50%,50%'),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('Only absolute Maestro point selectors like "100,200" are supported.'),
  );
});
