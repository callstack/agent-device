import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { IOS_TARGET_ACTIVATION_PRIOR_STATES } from '@agent-device/kernel/snapshot';
import {
  TARGET_ACTIVATION_WIRE_KEY,
  readTargetActivationFact,
  type UnmappedPriorStateDetail,
} from '../target-activation.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const swiftModelsPath = path.resolve(
  here,
  '../../../../../apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Models.swift',
);

/**
 * The decode table is declared by raw value rather than by position, which buys safety against a
 * reordered enum at the price of a new obligation: a state the contract declares but no raw value
 * names would be disclosed as `unknown` forever, silently. This is the assertion that keeps the two
 * declarations in step.
 */
test('every declared prior state is reachable from some raw value', () => {
  const named = new Set<string>();
  for (let raw = 0; raw < 16; raw++) {
    const fact = readTargetActivationFact(wire('stale_target', raw));
    if (fact) named.add(fact.priorState);
  }
  assert.deepEqual(
    IOS_TARGET_ACTIVATION_PRIOR_STATES.filter((state) => !named.has(state)),
    [],
  );
});

test('target activation fact decodes every reason the runner can stamp', () => {
  assert.deepEqual(readTargetActivationFact(wire('stale_target', 2)), {
    reason: 'stale_target',
    priorState: 'runningBackground',
  });
  assert.deepEqual(
    readTargetActivationFact(
      wire('interaction_foreground_guard', 3, { otherActiveApplicationPid: 4562 }),
    ),
    {
      reason: 'interaction_foreground_guard',
      priorState: 'runningBackgroundSuspended',
      otherActiveApplicationPid: 4562,
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
  for (const otherActiveApplicationPid of [undefined, 0, -1, 4.5, '4562', null]) {
    const decoded = readTargetActivationFact(
      wire('stale_target', 2, { otherActiveApplicationPid: otherActiveApplicationPid as unknown }),
    );
    assert.ok(decoded);
    assert.equal('otherActiveApplicationPid' in decoded, false, String(otherActiveApplicationPid));
  }
});

test('target activation fact refuses a reason the runner never stamps', () => {
  // A reason the shared rules cannot name is not this repair at all, so nothing is decoded.
  assert.equal(readTargetActivationFact(wire('auto_rebound', 2)), undefined);
  assert.equal(readTargetActivationFact(wire('stale_target', 'runningBackground')), undefined);
  assert.equal(readTargetActivationFact(wire('stale_target', undefined)), undefined);
  assert.equal(readTargetActivationFact(undefined), undefined);
  assert.equal(readTargetActivationFact(null), undefined);
  assert.equal(readTargetActivationFact([]), undefined);
  assert.equal(readTargetActivationFact('stale_target'), undefined);
});

/**
 * `XCApplicationState` ships in no public header this repo compiles against, so a raw value the
 * table never declared must degrade the STATE and keep the disclosure: the reason already proves
 * `activate()` ran, and the silent repair is the failure #2682 is about. The gap is named in the log.
 */
test('an unmapped prior-state raw value discloses the repair as unknown and says so', () => {
  const unmapped: UnmappedPriorStateDetail[] = [];
  for (const rawPriorState of [4, 99]) {
    assert.deepEqual(readTargetActivationFact(wire('bundle_changed', rawPriorState)), {
      reason: 'bundle_changed',
      priorState: 'unknown',
    });
  }
  readTargetActivationFact(wire('stale_target', 42), (detail) => unmapped.push(detail));
  assert.deepEqual(unmapped, [{ reason: 'stale_target', rawPriorState: 42 }]);
  // A mapped value owes no note.
  readTargetActivationFact(wire('stale_target', 2), (detail) => unmapped.push(detail));
  assert.equal(unmapped.length, 1);
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
