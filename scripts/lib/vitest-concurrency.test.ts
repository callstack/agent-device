import os from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_VITEST_MAX_WORKERS,
  resolveVitestMaxWorkers,
  VITEST_MAX_WORKERS_OVERRIDE_ENV,
} from './vitest-concurrency.ts';

test('an unset override preserves the existing default local cap', () => {
  assert.equal(resolveVitestMaxWorkers({}), DEFAULT_VITEST_MAX_WORKERS);
});

test('CI ignores the override even when both signals are present', () => {
  assert.equal(
    resolveVitestMaxWorkers({ CI: 'true', [VITEST_MAX_WORKERS_OVERRIDE_ENV]: '8' }),
    undefined,
  );
});

test('a valid override below the core count is honored as-is', () => {
  // Below any real host's core count, so the resolver takes the override
  // branch rather than clamping it back down.
  assert.equal(resolveVitestMaxWorkers({ [VITEST_MAX_WORKERS_OVERRIDE_ENV]: '1' }), 1);
});

test('an override above the available core count is clamped down to it', () => {
  assert.equal(
    resolveVitestMaxWorkers({ [VITEST_MAX_WORKERS_OVERRIDE_ENV]: '999' }),
    os.cpus().length,
  );
});

test('a non-numeric override falls through to the default cap', () => {
  assert.equal(
    resolveVitestMaxWorkers({ [VITEST_MAX_WORKERS_OVERRIDE_ENV]: 'not-a-number' }),
    DEFAULT_VITEST_MAX_WORKERS,
  );
});

test('a zero or negative override falls through to the default cap', () => {
  assert.equal(
    resolveVitestMaxWorkers({ [VITEST_MAX_WORKERS_OVERRIDE_ENV]: '0' }),
    DEFAULT_VITEST_MAX_WORKERS,
  );
  assert.equal(
    resolveVitestMaxWorkers({ [VITEST_MAX_WORKERS_OVERRIDE_ENV]: '-4' }),
    DEFAULT_VITEST_MAX_WORKERS,
  );
});

test('a non-integer override falls through to the default cap', () => {
  assert.equal(
    resolveVitestMaxWorkers({ [VITEST_MAX_WORKERS_OVERRIDE_ENV]: '2.5' }),
    DEFAULT_VITEST_MAX_WORKERS,
  );
});
