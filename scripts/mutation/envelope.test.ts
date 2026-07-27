// The envelope is the only thing a downloaded scheduled-lane artifact can be
// interpreted from months later (#1430), so its required fields are asserted
// rather than assumed: a lane that stops emitting one of them makes freshness
// and tool-drift monitoring silently useless.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { laneEnvelope, LANE_ENVELOPE_SCHEMA_VERSION } from '../lib/lane-envelope.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function workflow(name: string): string {
  return fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8');
}

test('the envelope carries schema, commit, tool/config provenance, duration and result', () => {
  const envelope = laneEnvelope({
    lane: 'mutation-decision-kernels',
    commit: 'a'.repeat(40),
    tool: { stryker: '9.6.1' },
    configHash: 'sha256:abcdef123456',
    startedAtMs: 1_000,
    now: 61_000,
    result: 'pass',
    data: { scope: 'full-sweep' },
  });
  assert.equal(envelope.schemaVersion, LANE_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.lane, 'mutation-decision-kernels');
  assert.equal(envelope.commit, 'a'.repeat(40));
  assert.deepEqual(envelope.tool, { stryker: '9.6.1' });
  assert.equal(envelope.configHash, 'sha256:abcdef123456');
  // Mutation input is enumerated, not randomized: `null` is an explicit
  // "not applicable", not a forgotten field.
  assert.equal(envelope.seed, null);
  assert.equal(envelope.durationMs, 60_000);
  assert.equal(envelope.finishedAt, '1970-01-01T00:01:01.000Z');
  assert.equal(envelope.result, 'pass');
  assert.deepEqual(envelope.data, { scope: 'full-sweep' });
});

test('a failed ratchet is recorded as a failed lane run', () => {
  const envelope = laneEnvelope({
    lane: 'mutation-decision-kernels',
    commit: 'b'.repeat(40),
    tool: { stryker: '9.6.1' },
    configHash: 'sha256:abcdef123456',
    startedAtMs: 0,
    now: 0,
    result: 'fail',
    data: {},
  });
  assert.equal(envelope.result, 'fail');
  assert.equal(envelope.durationMs, 0);
});

test('both mutation lanes publish the envelope', () => {
  for (const name of ['mutation-weekly.yml', 'mutation-affected.yml']) {
    assert.match(
      workflow(name),
      /\.tmp\/mutation\/lane-envelope\.json/,
      `${name} does not upload the lane envelope`,
    );
  }
  assert.match(workflow('mutation-weekly.yml'), /Lane envelope/);
});
