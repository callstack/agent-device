import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { TARGET_ACTIVATION_WIRE_KEY, readTargetActivationFact } from '../target-activation.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const swiftModelsPath = path.resolve(
  here,
  '../../../../../apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift',
);

test('target activation fact decodes every reason the runner can stamp', () => {
  assert.deepEqual(readTargetActivationFact(wire('stale_target', 2)), {
    reason: 'stale_target',
    priorState: 'runningBackground',
  });
  assert.deepEqual(
    readTargetActivationFact(wire('interaction_foreground_guard', 3, { foregroundPid: 4562 })),
    {
      reason: 'interaction_foreground_guard',
      priorState: 'runningBackgroundSuspended',
      foregroundPid: 4562,
    },
  );
  assert.deepEqual(readTargetActivationFact(wire('bundle_changed', 1)), {
    reason: 'bundle_changed',
    priorState: 'notRunning',
  });
  assert.deepEqual(readTargetActivationFact(wire('missing_after_wait', 0)), {
    reason: 'missing_after_wait',
    priorState: 'unknown',
  });
});

test('target activation fact omits a foreground pid the runner could not isolate', () => {
  for (const foregroundPid of [undefined, 0, -1, 4.5, '4562', null]) {
    const decoded = readTargetActivationFact(
      wire('stale_target', 2, { foregroundPid: foregroundPid as unknown }),
    );
    assert.ok(decoded);
    assert.equal('foregroundPid' in decoded, false, String(foregroundPid));
  }
});

test('target activation fact refuses a reason or state the runner never stamps', () => {
  // Closest negatives: a repair the shared rules cannot name, and the state the runner skips
  // activation for — a payload carrying it did not come from the activation path.
  assert.equal(readTargetActivationFact(wire('auto_rebound', 2)), undefined);
  assert.equal(readTargetActivationFact(wire('stale_target', 4)), undefined);
  assert.equal(readTargetActivationFact(wire('stale_target', 99)), undefined);
  assert.equal(readTargetActivationFact(wire('stale_target', 'runningBackground')), undefined);
  assert.equal(readTargetActivationFact(wire('stale_target', undefined)), undefined);
  assert.equal(readTargetActivationFact(undefined), undefined);
  assert.equal(readTargetActivationFact(null), undefined);
  assert.equal(readTargetActivationFact([]), undefined);
  assert.equal(readTargetActivationFact('stale_target'), undefined);
});

test('wire key matches the runner payload property that carries it', () => {
  const swift = fs.readFileSync(swiftModelsPath, 'utf8');
  assert.match(
    swift,
    new RegExp(`var ${TARGET_ACTIVATION_WIRE_KEY}: TargetActivationFactPayload\\?`),
  );
});

function wire(
  reason: string,
  priorState: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { reason, priorState, ...extra };
}
