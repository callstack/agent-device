import assert from 'node:assert/strict';
import { test } from 'vitest';
import { iosTargetActivationDisclosure } from './ios-target-activation.ts';

test('target activation disclosure names the repair and both agent routes', () => {
  const disclosure = iosTargetActivationDisclosure({
    reason: 'stale_target',
    priorState: 'runningBackground',
    otherActiveApplicationPid: 4562,
  });
  assert.match(disclosure, /The session app was not foreground when this command arrived/);
  assert.match(disclosure, /prior state runningBackground/);
  assert.match(disclosure, /reason stale_target/);
  assert.match(disclosure, /Re-capture now that the session app answers/);
  assert.match(disclosure, /drive the other app in its own session/);
});

/**
 * `activeApplications` reports liveness with no ordering, so the sentence may name the one other
 * AX-active application and must not say it owned the screen — the claim the pid cannot support.
 */
test('target activation disclosure claims liveness for the other app, never foreground ownership', () => {
  const disclosure = iosTargetActivationDisclosure({
    reason: 'stale_target',
    priorState: 'runningBackground',
    otherActiveApplicationPid: 4562,
  });
  assert.match(
    disclosure,
    /the only app other than the session app with an active accessibility session \(pid 4562\)/,
  );
  assert.equal(/held it|foreground app|owned the screen/.test(disclosure), false, disclosure);
});

test('target activation disclosure never invents a pid the runner did not isolate', () => {
  const disclosure = iosTargetActivationDisclosure({
    reason: 'interaction_foreground_guard',
    priorState: 'runningBackgroundSuspended',
  });
  assert.match(disclosure, /no single other app with an active accessibility session/);
  assert.equal(disclosure.includes('pid'), false, disclosure);
});
