import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import type { SessionState } from '../session-state.ts';
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

/** The message texts the fallback once sniffed; the disclosure alone must decide now. */
const LEGACY_FALLBACK_MESSAGES = [
  'fetch failed',
  'Runner command deadline exceeded: timed out',
  'Runner did not accept connection',
  'Invalid runner response',
];

function refusal(code: AppError['code'], message: string): AppError {
  return new AppError(code, message, { dispatched: 'no' });
}

test('runner selector refusals delegate for interaction dispatches (ADR 0011)', () => {
  for (const code of ['ELEMENT_NOT_FOUND', 'ELEMENT_OFFSCREEN', 'AMBIGUOUS_MATCH'] as const) {
    assert.equal(
      isDirectIosSelectorFallbackError(refusal(code, code), { delegateSemanticFailures: true }),
      true,
      code,
    );
  }
});

test('maestro replay dispatches preserve the runner selector refusal shapes (no fallback)', () => {
  for (const code of ['ELEMENT_NOT_FOUND', 'ELEMENT_OFFSCREEN', 'AMBIGUOUS_MATCH'] as const) {
    assert.equal(
      isDirectIosSelectorFallbackError(refusal(code, code), { delegateSemanticFailures: false }),
      false,
      code,
    );
  }
});

test('a pre-send COMMAND_FAILED falls back; the message text never decides', () => {
  const options = { delegateSemanticFailures: false };
  assert.equal(
    isDirectIosSelectorFallbackError(
      refusal('COMMAND_FAILED', 'element covered by overlay'),
      options,
    ),
    true,
  );
  for (const message of LEGACY_FALLBACK_MESSAGES) {
    assert.equal(
      isDirectIosSelectorFallbackError(new AppError('COMMAND_FAILED', message), options),
      false,
      message,
    );
    assert.equal(
      isDirectIosSelectorFallbackError(refusal('COMMAND_FAILED', message), options),
      true,
    );
  }
});

test('a failure that may have tapped never falls back', () => {
  for (const code of ['COMMAND_FAILED', 'ELEMENT_NOT_FOUND'] as const) {
    assert.equal(
      isDirectIosSelectorFallbackError(new AppError(code, 'failed', { dispatched: 'unknown' }), {
        delegateSemanticFailures: true,
      }),
      false,
      code,
    );
  }
});

test('a canceled request never falls back', () => {
  const canceled = createRequestCanceledError({ dispatched: 'no' });
  assert.equal(
    isDirectIosSelectorFallbackError(canceled, { delegateSemanticFailures: true }),
    false,
  );
});

// #1542: isLocalIosRunnerSession is the ONE shared eligibility predicate for
// both the Maestro selector-tap route and the offscreen refusal
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
