import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliJsonResult } from './cli-json.ts';
import { searchForVisibleElement } from './live-device-e2e/visibility-scroll.ts';

function result(status: number, details?: Record<string, unknown>): CliJsonResult {
  return {
    json: details === undefined ? undefined : { error: { details } },
    status,
    stderr: '',
    stdout: '',
  };
}

test('an existing offscreen element scrolls until the visibility probe passes', async () => {
  const probes = [result(1), result(0)];
  const probeAttempts: number[] = [];
  const scrollAttempts: number[] = [];

  await searchForVisibleElement(
    'id="automation-longpress"',
    async (attempt) => {
      probeAttempts.push(attempt);
      return probes.shift() ?? result(1);
    },
    async (attempt) => {
      scrollAttempts.push(attempt);
    },
  );

  assert.deepEqual(probeAttempts, [1, 2]);
  assert.deepEqual(scrollAttempts, [1]);
});

test('an exhausted budget spends a final probe as a real step so evidence is captured', async () => {
  const evidenceProbes: number[] = [];

  await assert.rejects(
    searchForVisibleElement(
      'id="automation-press"',
      async () => result(1),
      async () => {},
      async () => {
        evidenceProbes.push(1);
        return result(1);
      },
    ),
    /did not become visible after scrolling/,
  );

  assert.deepEqual(evidenceProbes, [1]);
});

test('a stalled capture retries without scrolling or consuming an attempt', async () => {
  const probes = [result(1, { captureStalled: true }), result(0)];
  const probeAttempts: number[] = [];
  const scrollAttempts: number[] = [];

  await searchForVisibleElement(
    'id="automation-longpress"',
    async (attempt) => {
      probeAttempts.push(attempt);
      return probes.shift() ?? result(1);
    },
    async (attempt) => {
      scrollAttempts.push(attempt);
    },
  );

  assert.deepEqual(probeAttempts, [1, 1]);
  assert.deepEqual(scrollAttempts, []);
});
