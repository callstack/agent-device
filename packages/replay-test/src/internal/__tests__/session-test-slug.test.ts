import { test } from 'vitest';
import assert from 'node:assert/strict';
import { trimBoundaryHyphens } from '../session-test-slug.ts';

test('trimBoundaryHyphens preserves internal hyphens while trimming boundaries', () => {
  assert.equal(trimBoundaryHyphens('---replay-test---'), 'replay-test');
  assert.equal(trimBoundaryHyphens('replay---test'), 'replay---test');
  assert.equal(trimBoundaryHyphens('---'), '');
});

test('trimBoundaryHyphens stays linear for a non-terminal hyphen run', () => {
  const value = `x${'-'.repeat(50_000)}x`;
  const startedAt = performance.now();

  assert.equal(trimBoundaryHyphens(value), value);

  assert.ok(performance.now() - startedAt < 100, 'boundary trimming should not backtrack');
});
