import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  IOS_TARGET_ACTIVATION_PRIOR_STATES,
  IOS_TARGET_ACTIVATION_REASONS,
  isIosTargetActivationReason,
  type IosTargetActivationPriorState,
} from './snapshot.ts';

/**
 * The decoder's only gate on the stamped reason, and the live lane's check that a response named a
 * reason the runner can actually stamp. Both read this predicate instead of casting, so it is what
 * keeps an undeclared reason out of a disclosure.
 */
test('reason predicate accepts exactly the declared reasons', () => {
  for (const reason of IOS_TARGET_ACTIVATION_REASONS) {
    assert.equal(isIosTargetActivationReason(reason), true, reason);
  }
  assert.equal(isIosTargetActivationReason('already_foreground'), false);
  assert.equal(isIosTargetActivationReason(undefined), false);
});

/**
 * The declared prior states are the states the runner can find the app in WHEN IT ACTIVATES.
 * `runningForeground` is absent on purpose: a call that skipped activation has no repair to
 * disclose, so a disclosure naming it would claim an outcome the repair produced.
 */
test('declared prior states exclude the state that needs no repair', () => {
  // @ts-expect-error a call that found the app in the foreground performed no repair to disclose
  const needsNoRepair: IosTargetActivationPriorState = 'runningForeground';
  void needsNoRepair;
  assert.deepEqual([...IOS_TARGET_ACTIVATION_PRIOR_STATES].sort(), [
    'notRunning',
    'runningBackground',
    'runningBackgroundSuspended',
    'unknown',
  ]);
});
