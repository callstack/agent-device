import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRunnerListenerReadySignal } from '../runner/runner-listener-ready.ts';

test('runner listener readiness survives process-output chunk boundaries', async () => {
  const signal = createRunnerListenerReadySignal();

  signal.observe('stderr', 'noise AGENT_DEVICE_RUNNER_LISTENER_');
  assert.equal(signal.wake.aborted, false);

  signal.observe('stderr', 'READY more noise');
  assert.equal(signal.wake.aborted, true);
});

test('runner listener readiness ignores unrelated output', async () => {
  const signal = createRunnerListenerReadySignal();

  signal.observe('stdout', 'AGENT_DEVICE_RUNNER_WAITING');
  assert.equal(signal.wake.aborted, false);
});

test('runner listener readiness does not combine unrelated process streams', async () => {
  const signal = createRunnerListenerReadySignal();

  signal.observe('stdout', 'AGENT_DEVICE_RUNNER_LISTENER_');
  signal.observe('stderr', 'READY');
  assert.equal(signal.wake.aborted, false);
});

test('runner exit wakes startup probing when no listener marker arrives', () => {
  const signal = createRunnerListenerReadySignal();

  signal.finish();

  assert.equal(signal.wake.aborted, true);
});
