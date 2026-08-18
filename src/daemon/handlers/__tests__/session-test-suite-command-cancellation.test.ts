import { expect, test } from 'vitest';
import {
  clearRequestCanceled,
  getRequestSignal,
  isRequestCanceled,
  markRequestCanceled,
  registerRequestAbort,
} from '../../../request/cancel.ts';
import { bindReplayTestAttemptCancellation } from '../session-test-suite-command.ts';

// The daemon half of the replay-test cancellation seam (#1478 P3b). The scheduler only says
// "cancel" and "release"; everything here — registry entries, the parent-abort relay, and
// cleanup — is the adapter's, and used to live inside the attempt runtime. The scheduler's own
// obligation (cancel once on timeout, always release) is pinned in the package's runtime tests.

test('cancel marks the attempt canceled and release clears the registry entry', () => {
  const cancellation = bindReplayTestAttemptCancellation({ attemptId: 'attempt-1' });
  expect(isRequestCanceled('attempt-1')).toBe(false);

  cancellation.cancel();
  expect(isRequestCanceled('attempt-1')).toBe(true);

  cancellation.release();
  expect(isRequestCanceled('attempt-1')).toBe(false);
});

test('a parent abort cancels the in-flight attempt so a canceled suite stops', () => {
  registerRequestAbort('suite-1');
  const cancellation = bindReplayTestAttemptCancellation({
    attemptId: 'attempt-2',
    parentAttemptId: 'suite-1',
  });

  markRequestCanceled('suite-1');
  expect(isRequestCanceled('attempt-2')).toBe(true);

  cancellation.release();
  clearRequestCanceled('suite-1');
});

test('a parent already aborted cancels the attempt at bind time', () => {
  registerRequestAbort('suite-2');
  markRequestCanceled('suite-2');

  const cancellation = bindReplayTestAttemptCancellation({
    attemptId: 'attempt-3',
    parentAttemptId: 'suite-2',
  });
  expect(isRequestCanceled('attempt-3')).toBe(true);

  cancellation.release();
  clearRequestCanceled('suite-2');
});

test('release detaches the relay so a later parent abort cannot cancel a settled attempt', () => {
  registerRequestAbort('suite-3');
  const cancellation = bindReplayTestAttemptCancellation({
    attemptId: 'attempt-4',
    parentAttemptId: 'suite-3',
  });

  cancellation.release();
  markRequestCanceled('suite-3');
  expect(isRequestCanceled('attempt-4')).toBe(false);

  clearRequestCanceled('suite-3');
});

test('an attempt that is its own parent binds no relay', () => {
  // Binding registers the attempt itself, so there is no separate parent to relay from.
  const cancellation = bindReplayTestAttemptCancellation({
    attemptId: 'attempt-5',
    parentAttemptId: 'attempt-5',
  });

  expect(getRequestSignal('attempt-5')?.aborted).toBe(false);
  cancellation.release();
  expect(isRequestCanceled('attempt-5')).toBe(false);
});
