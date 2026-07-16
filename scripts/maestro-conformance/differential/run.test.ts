// Device-free self-test for the layer-3 differential registry. Runs in unit CI
// via node --test; the live device comparison itself runs only on the scheduled
// conformance-differential workflow.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIFFERENTIAL_SCENARIOS } from './scenarios.ts';
import { parseRunnerArgs, selectScenarios, validateScenarios } from './run.ts';

test('every differential scenario references an existing corpus flow with a unique id', () => {
  assert.doesNotThrow(() => validateScenarios());
  assert.ok(DIFFERENTIAL_SCENARIOS.length > 0, 'expected at least one differential scenario');
});

test('the settle-loop bug class (4) is covered by a differential scenario', () => {
  const settle = DIFFERENTIAL_SCENARIOS.find((scenario) => scenario.bugClass === 4);
  assert.ok(settle, 'bug class 4 (settle ordering) has no reflectable constant; it must be a differential scenario');
  assert.equal(settle?.id, 'settle-after-tap');
});

test('--trace-root is accepted so engine-side invariants can be evaluated', () => {
  const options = parseRunnerArgs(['--trace-root', '/tmp/artifacts']);
  assert.equal(options.traceRoot, '/tmp/artifacts');
});

test('--only selects a single scenario and rejects unknown ids', () => {
  assert.equal(selectScenarios('settle-after-tap').length, 1);
  assert.throws(() => selectScenarios('does-not-exist'), /No scenario named/);
});

test('runner arg parsing honors dry-run and platform', () => {
  const options = parseRunnerArgs(['--dry-run', '--platform', 'ios']);
  assert.equal(options.dryRun, true);
  assert.equal(options.platform, 'ios');
});
