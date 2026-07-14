import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { markPostGestureStabilization } from '../post-gesture-stabilization.ts';
import type { SessionState } from '../types.ts';

afterEach(() => {
  vi.useRealTimers();
});

test('markPostGestureStabilization marks iOS swipe sessions', () => {
  const session = makeSession();

  markPostGestureStabilization(session, 'swipe');

  assert.equal(session.postGestureStabilization?.action, 'swipe');
});

test('markPostGestureStabilization marks Android swipe sessions', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'swipe');

  assert.equal(session.postGestureStabilization?.action, 'swipe');
});

test('markPostGestureStabilization marks gesture swipe sessions', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'gesture', ['swipe', 'left']);

  assert.equal(session.postGestureStabilization?.action, 'gesture');
});

test('markPostGestureStabilization honors an explicit opt-out', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'swipe', [], { postGestureStabilization: false });

  assert.equal(session.postGestureStabilization, undefined);
});

test('markPostGestureStabilization ignores non-swipe gesture sessions', () => {
  const session = makeSession('android');

  markPostGestureStabilization(session, 'gesture', ['pinch', 'in']);

  assert.equal(session.postGestureStabilization, undefined);
});

function makeSession(platform: 'ios' | 'android' = 'ios'): SessionState {
  return {
    name: platform,
    device: platform === 'android' ? ANDROID_EMULATOR : IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
  };
}
