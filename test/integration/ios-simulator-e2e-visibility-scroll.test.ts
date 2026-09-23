import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliJsonResult } from './cli-json.ts';
import { searchForVisibleElement } from './ios-simulator-e2e/live-assertions.ts';

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

/**
 * The CI failure shape: the element is on screen only at offset 1, and the first read after each
 * scroll lands on a surface still moving, so it misses with `unsettledGesture`.
 */
function listWithUnsettledFirstReads(visibleAt?: number) {
  let offset = 0;
  let moving = false;
  const probes: number[] = [];
  const scrolls: number[] = [];
  const probe = async (attempt: number) => {
    probes.push(attempt);
    const unsettled = moving;
    moving = false;
    if (!unsettled && offset === visibleAt) return result(0);
    return result(1, unsettled ? { unsettledGesture: { action: 'scroll', positionals: [] } } : {});
  };
  const scroll = async (attempt: number) => {
    scrolls.push(attempt);
    offset += 1;
    moving = true;
  };
  return { probes, scrolls, probe, scroll };
}

test('an unsettled miss after the scroll that reached the element is re-read at the same offset', async () => {
  const list = listWithUnsettledFirstReads(1);

  await searchForVisibleElement('id="target"', list.probe, list.scroll);

  assert.deepEqual([list.probes, list.scrolls], [[1, 2, 2], [1]]);
});

test('a real absence still fails after the forward scrolls, naming every step', async () => {
  const list = listWithUnsettledFirstReads();

  await assert.rejects(
    searchForVisibleElement('id="target"', list.probe, list.scroll),
    /scroll after attempt 3: [\s\S]*probe 4:/,
  );
  assert.deepEqual(list.scrolls, [1, 2, 3]);
});
