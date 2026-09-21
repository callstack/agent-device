import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRunnerListenerReadySignal } from '../runner-listener-ready.ts';

// The runner writes one merged log file, so chunk boundaries still matter and stream boundaries no
// longer exist.

test('runner listener readiness survives log read boundaries', async () => {
  const signal = createRunnerListenerReadySignal();

  signal.observe('noise AGENT_DEVICE_RUNNER_LISTENER_');
  assert.equal(signal.wake.aborted, false);

  signal.observe('READY more noise');
  assert.equal(signal.wake.aborted, true);
});

test('runner listener readiness ignores unrelated output', async () => {
  const signal = createRunnerListenerReadySignal();

  signal.observe('AGENT_DEVICE_RUNNER_WAITING');
  assert.equal(signal.wake.aborted, false);
});

test('runner listener readiness only carries the marker across one read', async () => {
  // The retained suffix is the shortest tail that can complete the marker, so a first half that no
  // longer abuts the next read is forgotten rather than matched against output from elsewhere.
  const signal = createRunnerListenerReadySignal();

  signal.observe('AGENT_DEVICE_RUNNER_LISTENER_');
  signal.observe(`${'x'.repeat(100)}`);
  signal.observe('READY');

  assert.equal(signal.wake.aborted, false);
});

test('runner exit wakes startup probing when no listener marker arrives', () => {
  const signal = createRunnerListenerReadySignal();

  signal.finish();

  assert.equal(signal.wake.aborted, true);
});
