// Device-free tests for the engine-side invariant evaluator. The evaluator is
// the bug-class-4 detector, so its logic is verified here against synthetic
// traces rather than only on the scheduled device run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS } from '../../../src/compat/maestro/compatibility-policy.ts';
import { DIFFERENTIAL_SCENARIOS } from './scenarios.ts';
import { type Invariant, evaluateInvariant, readTrace } from './invariants.ts';

const SETTLE_INVARIANT: Invariant = {
  kind: 'stepDurationBelow',
  command: 'tapOn',
  maxMs: MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
  because: 'test',
};

const stop = (command: string, durationMs: number, step = 1) => ({
  type: 'replay_action_stop',
  step,
  command,
  ok: true,
  durationMs,
});

test('a tap that latches early holds the settle invariant', () => {
  // Healthy: Android ~350ms, iOS ~800-1100ms — well under the 2000ms budget.
  const result = evaluateInvariant([stop('tapOn', 350)], SETTLE_INVARIANT);
  assert.equal(result.status, 'held');
});

test('a tap that burns the full settle budget violates the invariant (bug class 4)', () => {
  // The regression signature: ~2093ms against a 200ms x 10 budget — the
  // stability loop never latched, yet the flow still passes, so outcome parity
  // would have missed it.
  const result = evaluateInvariant([stop('tapOn', 2093)], SETTLE_INVARIANT);
  assert.equal(result.status, 'violated');
  assert.match(result.detail, /2093ms/);
});

test('the invariant reports the slowest matching step, not the first', () => {
  const result = evaluateInvariant([stop('tapOn', 300, 1), stop('tapOn', 2117, 2)], SETTLE_INVARIANT);
  assert.equal(result.status, 'violated');
  assert.match(result.detail, /2117ms/);
});

test('a trace with no matching step reports no-data rather than passing silently', () => {
  const result = evaluateInvariant([stop('swipe', 400)], SETTLE_INVARIANT);
  assert.equal(result.status, 'no-data');
});

test('start events and steps without a duration are ignored', () => {
  const events = [
    { type: 'replay_action_start', step: 1, command: 'tapOn' },
    { type: 'replay_action_stop', step: 1, command: 'tapOn' },
  ];
  assert.equal(evaluateInvariant(events, SETTLE_INVARIANT).status, 'no-data');
});

test('readTrace parses ndjson and skips blank/corrupt lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-trace-'));
  const file = path.join(dir, 'replay-timing.ndjson');
  fs.writeFileSync(file, `${JSON.stringify(stop('tapOn', 350))}\n\nnot-json\n`);
  try {
    const events = readTrace(file);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.command, 'tapOn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readTrace on a missing file returns no events', () => {
  assert.deepEqual(readTrace('/nonexistent/replay-timing.ndjson'), []);
});

test('bug class 4 has a machine-checkable invariant, not just outcome parity', () => {
  const settle = DIFFERENTIAL_SCENARIOS.find((scenario) => scenario.bugClass === 4);
  const invariant = settle?.engineInvariants?.[0];
  assert.ok(invariant, 'settle scenario must carry an engine-side invariant');
  assert.equal(invariant?.kind, 'stepDurationBelow');
  assert.equal(
    invariant?.kind === 'stepDurationBelow' ? invariant.maxMs : undefined,
    MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
  );
});

// --- metricAtLeast: proves a code path actually ran, not just that it passed ---

const RETRY_INVARIANT: Invariant = {
  kind: 'metricAtLeast',
  command: 'tapOn',
  metric: 'tapRetries',
  min: 1,
  because: 'test',
};

const stopWithMetrics = (command: string, metrics: Record<string, number>, step = 1) => ({
  type: 'replay_action_stop',
  step,
  command,
  ok: true,
  durationMs: 100,
  resultTiming: metrics,
});

test('a tap that actually retried holds the retry invariant', () => {
  const result = evaluateInvariant([stopWithMetrics('tapOn', { tapRetries: 1 })], RETRY_INVARIANT);
  assert.equal(result.status, 'held');
});

// The exact vacuity that made this scenario worthless before: the tap succeeded
// first try (navigating control), so retry never ran — yet the flow passed.
test('a tap that never retried violates the invariant (catches a vacuous scenario)', () => {
  const result = evaluateInvariant([stopWithMetrics('tapOn', { tapRetries: 0 })], RETRY_INVARIANT);
  assert.equal(result.status, 'violated');
  assert.match(result.detail, /was 0/);
});

test('a trace whose taps record no metric reports no-data rather than passing', () => {
  const result = evaluateInvariant([stopWithMetrics('tapOn', {})], RETRY_INVARIANT);
  assert.equal(result.status, 'no-data');
});

// tap-retry-if-no-change was parked while it was a coin flip (#1300): tapRetries
// measured 0 then 1 across identical runs. It is active again now that it taps
// the fixture's inert surface, and it carries its own detector — without the
// tapRetries invariant the scenario is back to proving nothing, because outcome
// parity passes whether or not the retry ever fires.
test('the retry scenario is active and carries the invariant that makes it mean something', () => {
  const retry = DIFFERENTIAL_SCENARIOS.find((s) => s.id === 'tap-retry-if-no-change');
  assert.ok(retry, 'tap-retry-if-no-change must stay in the active differential set');
  const [invariant, ...rest] = retry?.engineInvariants ?? [];
  assert.equal(rest.length, 0);
  assert.equal(invariant?.kind, 'metricAtLeast');
  assert.equal(invariant?.command, 'tapOn');
  assert.equal(invariant?.kind === 'metricAtLeast' && invariant.metric, 'tapRetries');
  assert.equal(invariant?.kind === 'metricAtLeast' && invariant.min, 1);
});

// A flaky scenario must be fixed, never waived: knownDivergence assumes the
// failure reproduces, so declaring this one would make the schedule flip between
// green and red at random — the trap #1300 was filed to escape.
test('the retry scenario is not waived by a divergence declaration', () => {
  const retry = DIFFERENTIAL_SCENARIOS.find((s) => s.id === 'tap-retry-if-no-change');
  assert.equal(retry?.knownDivergence, undefined);
});

// The flow only forces the retry if it drives the inert surface. Tapping any
// live screen is what made this flaky, and that regression is invisible on the
// unit side — the invariant only goes red on a device.
test('the retry flow drives the inert surface, not a live screen', () => {
  const flow = fs.readFileSync(
    path.join(import.meta.dirname, 'flows/tap-retry-if-no-change.yaml'),
    'utf8',
  );
  assert.match(flow, /id: open-inert-surface/);
  assert.match(flow, /id: inert-target/);
});

// Truncation-vs-rounding is at most 1px and cannot be observed on a device, so
// no scenario may claim to guard bug class 1; a unit test pins it instead.
test('no device scenario claims to prove percent truncation (bug class 1)', () => {
  const claiming = DIFFERENTIAL_SCENARIOS.filter((s) => s.bugClass === 1);
  assert.deepEqual(
    claiming.map((s) => s.id),
    [],
    'a 1px truncation delta is not app-observable; keep bug class 1 in runtime-port-geometry.test.ts',
  );
});

// --- gestureExecutionProfile: proves the iOS endpoint-hold delivery path ---

const PROFILE_INVARIANT: Invariant = {
  kind: 'gestureExecutionProfile',
  command: 'swipe',
  profile: 'endpoint-hold',
  because: 'test',
};

const stopWithProfile = (command: string, executionProfile: string) => ({
  type: 'replay_action_stop',
  step: 1,
  command,
  ok: true,
  durationMs: 300,
  resultTiming: { executionProfile },
});

test('a swipe with endpoint-hold in resultTiming holds the gesture execution profile invariant', () => {
  const result = evaluateInvariant([stopWithProfile('swipe', 'endpoint-hold')], PROFILE_INVARIANT);
  assert.equal(result.status, 'held');
});

test('a swipe with timed-pan violates the endpoint-hold invariant', () => {
  const result = evaluateInvariant([stopWithProfile('swipe', 'timed-pan')], PROFILE_INVARIANT);
  assert.equal(result.status, 'violated');
  assert.match(result.detail, /timed-pan/);
});

test('a trace with no executionProfile reports no-data', () => {
  const result = evaluateInvariant([stop('swipe', 300)], PROFILE_INVARIANT);
  assert.equal(result.status, 'no-data');
});

test('percent-swipe asserts the endpoint-hold execution profile in its engine-side invariant', () => {
  const scenario = DIFFERENTIAL_SCENARIOS.find((s) => s.id === 'percent-swipe');
  const invariant = scenario?.engineInvariants?.[0];
  assert.ok(invariant, 'percent-swipe must carry an engine-side invariant');
  assert.equal(invariant?.kind, 'gestureExecutionProfile');
  assert.equal(
    invariant?.kind === 'gestureExecutionProfile' ? invariant.profile : undefined,
    'endpoint-hold',
  );
});
