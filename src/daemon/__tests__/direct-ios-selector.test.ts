import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import type { SessionState } from '../types.ts';
import {
  deriveDirectIosNodeSelector,
  isDirectIosSelectorFallbackError,
  isLocalIosRunnerSession,
} from '../direct-ios-selector.ts';

function makeSession(
  platform: 'ios' | 'android' = 'ios',
  overrides: Partial<SessionState> = {},
): SessionState {
  return {
    name: platform,
    device: platform === 'android' ? ANDROID_EMULATOR : IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
    ...overrides,
  };
}

test('runner ELEMENT_OFFSCREEN delegates normally but stays typed for Maestro replay', () => {
  const error = new AppError('ELEMENT_OFFSCREEN', 'element resolved off-screen at (-161, 265)');
  assert.equal(isDirectIosSelectorFallbackError(error), true);
  assert.equal(isDirectIosSelectorFallbackError(error, { allowElementNotFound: false }), true);
  assert.equal(isDirectIosSelectorFallbackError(error, { delegateSemanticFailures: true }), true);
  assert.equal(isDirectIosSelectorFallbackError(error, { delegateSemanticFailures: false }), false);
});

test('runner ELEMENT_NOT_FOUND falls back for query callers that allow it', () => {
  const error = new AppError('ELEMENT_NOT_FOUND', 'element not found');
  assert.equal(isDirectIosSelectorFallbackError(error), false);
  assert.equal(isDirectIosSelectorFallbackError(error, { allowElementNotFound: true }), true);
});

test('semantic failures delegate to the runtime path for interaction dispatches (ADR 0011)', () => {
  const notFound = new AppError('ELEMENT_NOT_FOUND', 'element not found');
  const ambiguous = new AppError('AMBIGUOUS_MATCH', 'multiple');
  assert.equal(
    isDirectIosSelectorFallbackError(notFound, { delegateSemanticFailures: true }),
    true,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(ambiguous, { delegateSemanticFailures: true }),
    true,
  );
});

test('maestro replay dispatches preserve the runner semantic error shapes (no fallback)', () => {
  const notFound = new AppError('ELEMENT_NOT_FOUND', 'element not found');
  const ambiguous = new AppError('AMBIGUOUS_MATCH', 'multiple');
  assert.equal(
    isDirectIosSelectorFallbackError(notFound, { delegateSemanticFailures: false }),
    false,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(ambiguous, { delegateSemanticFailures: false }),
    false,
  );
});

test('AMBIGUOUS_MATCH does not fall back on the query path (allowElementNotFound callers)', () => {
  const ambiguous = new AppError('AMBIGUOUS_MATCH', 'multiple');
  assert.equal(isDirectIosSelectorFallbackError(ambiguous), false);
  assert.equal(isDirectIosSelectorFallbackError(ambiguous, { allowElementNotFound: true }), false);
});

test('transport-level COMMAND_FAILED errors fall back, semantic ones do not', () => {
  assert.equal(
    isDirectIosSelectorFallbackError(new AppError('COMMAND_FAILED', 'fetch failed')),
    true,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(
      new AppError('COMMAND_FAILED', 'Runner command deadline exceeded: timed out'),
    ),
    true,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(new AppError('COMMAND_FAILED', 'element covered by overlay')),
    false,
  );
});

// #1542: isLocalIosRunnerSession is the ONE shared eligibility predicate for
// both the direct-selector tap fast path and the offscreen refusal
// double-check probe. Its two callers differ in exactly one parameter.

test('isLocalIosRunnerSession: iOS local sessions are eligible, Android and undefined are not', () => {
  assert.equal(
    isLocalIosRunnerSession(makeSession('ios'), { skipPendingPostGestureStabilization: true }),
    true,
  );
  assert.equal(
    isLocalIosRunnerSession(makeSession('android'), {
      skipPendingPostGestureStabilization: true,
    }),
    false,
  );
  assert.equal(
    isLocalIosRunnerSession(undefined, { skipPendingPostGestureStabilization: true }),
    false,
  );
});

test('isLocalIosRunnerSession: skipPendingPostGestureStabilization:true excludes a pending session (the tap fast path)', () => {
  const pending = makeSession('ios', {
    postGestureStabilization: { action: 'scroll', positionals: [], markedAt: Date.now() },
  });
  assert.equal(
    isLocalIosRunnerSession(pending, { skipPendingPostGestureStabilization: true }),
    false,
  );
});

test('isLocalIosRunnerSession: skipPendingPostGestureStabilization:false keeps a pending session eligible (the offscreen double-check)', () => {
  const pending = makeSession('ios', {
    postGestureStabilization: { action: 'scroll', positionals: [], markedAt: Date.now() },
  });
  assert.equal(
    isLocalIosRunnerSession(pending, { skipPendingPostGestureStabilization: false }),
    true,
  );
});

test('deriveDirectIosNodeSelector: prefers id, falls back to label, null when neither is usable', () => {
  assert.deepEqual(
    deriveDirectIosNodeSelector({ identifier: 'shipping-pickup', label: 'Pickup' }),
    {
      key: 'id',
      value: 'shipping-pickup',
    },
  );
  assert.deepEqual(deriveDirectIosNodeSelector({ label: 'Checkout form' }), {
    key: 'label',
    value: 'Checkout form',
  });
  assert.equal(deriveDirectIosNodeSelector({ identifier: '   ', label: '  ' }), null);
  assert.equal(deriveDirectIosNodeSelector({}), null);
});
