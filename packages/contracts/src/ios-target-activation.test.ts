import assert from 'node:assert/strict';
import { test } from 'vitest';
import { iosTargetActivationDisclosure } from './ios-target-activation.ts';

test('target activation disclosure names the repair and both agent routes', () => {
  const disclosure = iosTargetActivationDisclosure({
    reason: 'stale_target',
    priorState: 'runningBackground',
    foregroundPid: 4562,
  });
  assert.match(disclosure, /another app \(pid 4562\) held it/);
  assert.match(disclosure, /prior state runningBackground/);
  assert.match(disclosure, /reason stale_target/);
  assert.match(disclosure, /Re-capture now that the session app answers/);
  assert.match(disclosure, /drive the other app in its own session/);
});

test('target activation disclosure never invents a pid the runner did not isolate', () => {
  const disclosure = iosTargetActivationDisclosure({
    reason: 'interaction_foreground_guard',
    priorState: 'runningBackgroundSuspended',
  });
  assert.match(disclosure, /another app held it/);
  assert.equal(disclosure.includes('pid'), false);
});
