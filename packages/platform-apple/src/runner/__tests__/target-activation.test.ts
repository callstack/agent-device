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
const swiftStatePinPath = path.resolve(
  here,
  '../../../../../apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/UnitTests/RunnerTests+ApplicationStateRawValueTests.swift',
);

/**
 * One live `assertDecoderPins(…)` call in the native XCTest. Anchored to the start of a line so a
 * commented-out or documented call cannot stand in for a pin, and capturing the Swift case as well as
 * the decoder name so a pin that pairs the two wrongly is caught here, not only on a lane.
 */
const NATIVE_STATE_PIN = /^[ \t]*assertDecoderPins\(\.(\w+), name: "(\w+)", raw: (\d+)\)/gm;

/** The XCTest-discoverable method those pins live in; a `func` without the `test` prefix never runs. */
const NATIVE_TEST_METHOD = /^[ \t]*func test\w*\(\)/m;

/**
 * SDK states the decode table omits on purpose: the runner skips `activate()` there, so it stamps no
 * fact and the contract declares no prior state for them.
 */
const SDK_STATES_THE_DECODER_OMITS = new Set(['runningForeground']);

/** One raw value as the native XCTest pins it. */
type NativeStatePin = Readonly<{ sdkCase: string; name: string; raw: number }>;

/**
 * The pins the native XCTest writes, taken from its test method onward: a pin above the method that
 * runs it is dead code, and a pin that no longer looks like this line is one this tie can no longer
 * read — which the caller's coverage assertion reports rather than passing quietly.
 */
function readNativeStatePins(swift: string, file: string): NativeStatePin[] {
  const methodStart = swift.search(NATIVE_TEST_METHOD);
  assert.notEqual(
    methodStart,
    -1,
    `${file} must keep a func test… method: XCTest discovers no other`,
  );
  return [...swift.slice(methodStart).matchAll(NATIVE_STATE_PIN)].map(
    ([, sdkCase, name, raw]): NativeStatePin => ({
      sdkCase: sdkCase as string,
      name: name as string,
      raw: Number(raw),
    }),
  );
}

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

/**
 * `XCUIApplication.h` declares the enum this table names: unknown 0, notRunning 1,
 * runningBackgroundSuspended 2, runningBackground 3, runningForeground 4. #2726 is the record of what
 * a handwritten copy of that declaration costs — raw 2 and 3 were reversed, so every suspended
 * repair was reported as an ordinary background one. The native XCTest pins the same integers against
 * the SDK enum; the tie below is what makes the two copies one claim.
 */
test('each prior state is named by the raw value the SDK declares', () => {
  assert.deepEqual(readTargetActivationFact(wire('stale_target', 0)), {
    reason: 'stale_target',
    priorState: 'unknown',
  });
  assert.deepEqual(readTargetActivationFact(wire('bundle_changed', 1)), {
    reason: 'bundle_changed',
    priorState: 'notRunning',
  });
  assert.deepEqual(readTargetActivationFact(wire('stale_target', 2)), {
    reason: 'stale_target',
    priorState: 'runningBackgroundSuspended',
  });
  assert.deepEqual(readTargetActivationFact(wire('interaction_foreground_guard', 3)), {
    reason: 'interaction_foreground_guard',
    priorState: 'runningBackground',
  });
});

/**
 * The runner reads `.runningForeground` and skips `activate()`, so raw 4 reaches this decoder only
 * from a runner that mis-stamped. The state degrades to `unknown` and the gap is named: inventing a
 * prior state the runner never observed is the fabrication the decoder refuses by design.
 */
test('the foreground raw value the runner never stamps names no prior state', () => {
  const unmapped: UnmappedPriorStateDetail[] = [];
  assert.deepEqual(
    readTargetActivationFact(wire('stale_target', 4), (detail) => unmapped.push(detail)),
    {
      reason: 'stale_target',
      priorState: 'unknown',
    },
  );
  assert.deepEqual(unmapped, [{ reason: 'stale_target', rawPriorState: 4 }]);
});

test('target activation fact decodes every reason the runner can stamp', () => {
  assert.deepEqual(readTargetActivationFact(wire('stale_target', 3)), {
    reason: 'stale_target',
    priorState: 'runningBackground',
  });
  assert.deepEqual(
    readTargetActivationFact(
      wire('interaction_foreground_guard', 2, { otherActiveApplicationPid: 4562 }),
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
      wire('stale_target', 3, { otherActiveApplicationPid: otherActiveApplicationPid as unknown }),
    );
    assert.ok(decoded);
    assert.equal('otherActiveApplicationPid' in decoded, false, String(otherActiveApplicationPid));
  }
});

test('target activation fact refuses a reason the runner never stamps', () => {
  // A reason the shared rules cannot name is not this repair at all, so nothing is decoded.
  assert.equal(readTargetActivationFact(wire('auto_rebound', 3)), undefined);
  assert.equal(readTargetActivationFact(wire('stale_target', 'runningBackground')), undefined);
  assert.equal(readTargetActivationFact(wire('stale_target', undefined)), undefined);
  assert.equal(readTargetActivationFact(undefined), undefined);
  assert.equal(readTargetActivationFact(null), undefined);
  assert.equal(readTargetActivationFact([]), undefined);
  assert.equal(readTargetActivationFact('stale_target'), undefined);
});

/**
 * A raw value no declaration names must degrade the STATE and keep the disclosure: the reason already
 * proves `activate()` ran, and the silent repair is the failure #2682 is about. The gap is named in
 * the log.
 */
test('an unmapped prior-state raw value discloses the repair as unknown and says so', () => {
  const unmapped: UnmappedPriorStateDetail[] = [];
  for (const rawPriorState of [5, 99]) {
    assert.deepEqual(readTargetActivationFact(wire('bundle_changed', rawPriorState)), {
      reason: 'bundle_changed',
      priorState: 'unknown',
    });
  }
  readTargetActivationFact(wire('stale_target', 42), (detail) => unmapped.push(detail));
  assert.deepEqual(unmapped, [{ reason: 'stale_target', rawPriorState: 42 }]);
  // A mapped value owes no note.
  readTargetActivationFact(wire('stale_target', 3), (detail) => unmapped.push(detail));
  assert.equal(unmapped.length, 1);
});

/**
 * The kernel's declared list promises `XCApplicationState` raw order. Only the decoder assigns raw
 * values, so the decoder is what proves that promise — and an unmapped raw is the callback's job, not
 * a state the list can be ordered by.
 */
test('the declared prior-state list follows the SDK raw order', () => {
  const unmapped: UnmappedPriorStateDetail[] = [];
  const ordered: string[] = [];
  for (let raw = 0; raw < 16; raw++) {
    const unmappedBefore = unmapped.length;
    const fact = readTargetActivationFact(wire('stale_target', raw), (detail) =>
      unmapped.push(detail),
    );
    if (fact && unmapped.length === unmappedBefore) ordered.push(fact.priorState);
  }
  assert.deepEqual(ordered, [...IOS_TARGET_ACTIVATION_PRIOR_STATES]);
});

/**
 * Two handwritten copies of an Apple enum is how #2726 happened. The native XCTest compares each raw
 * value against `XCUIApplication.State` itself, on the lanes whose SDK declares the case; this reads
 * those pins back from source, so the decode table and the pins agree on every host and every lane
 * without a device. Neither half alone is enough: this test cannot see the SDK, and the macOS build
 * compiles the suspended case out.
 */
test('the decode table matches the raw values the native XCTest pins from the SDK enum', () => {
  const pins = readNativeStatePins(
    fs.readFileSync(swiftStatePinPath, 'utf8'),
    path.basename(swiftStatePinPath),
  );
  const mismatches: string[] = [];
  for (const { sdkCase, name, raw } of pins) {
    if (sdkCase !== name) mismatches.push(`.${sdkCase} is pinned under the name ${name}`);
    const decoded = readTargetActivationFact(wire('stale_target', raw))?.priorState;
    const expected = SDK_STATES_THE_DECODER_OMITS.has(name) ? 'unknown' : name;
    if (decoded !== expected)
      mismatches.push(`raw ${raw}: decoder says ${decoded}, SDK pins ${name}`);
  }
  assert.deepEqual(mismatches, []);
  // A pin this scan can no longer read — renamed call, wrapped line, deleted case — would leave the
  // table unchecked against the SDK again, so every declared state has to show up here.
  assert.deepEqual(
    IOS_TARGET_ACTIVATION_PRIOR_STATES.filter((state) => !pins.some((pin) => pin.name === state)),
    [],
    `every declared prior state must stay pinned by a live assertDecoderPins line in ${path.basename(
      swiftStatePinPath,
    )}`,
  );
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
