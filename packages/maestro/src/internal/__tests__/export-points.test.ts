import { expect, test } from 'vitest';
import { formatMaestroPoint } from '../export-points.ts';

test('formatMaestroPoint serializes coordinate pairs', () => {
  expect(formatMaestroPoint(100, 200)).toBe('100,200');
  expect(formatMaestroPoint('50%', '75%')).toBe('50%,75%');
});
