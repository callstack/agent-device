import { test, expect } from 'vitest';
import { buildSessionRecoveryHint } from './session-recovery-hints.ts';
import type { SessionRef, SessionState } from './session-state.ts';
import { IOS_SIMULATOR } from '../__tests__/test-utils/device-fixtures.ts';

// The recovery hint's whole job is to hand back a command that works. For an implicitly
// cwd-scoped session — named `default`, stored as `cwd:<hash>:default` — building it from the
// name produced `agent-device close --session default`, which marks the session explicit and so
// addresses a different, non-existent session: the caller got SESSION_NOT_FOUND from the exact
// command the previous error told them to run, and the device stayed held (#2031).

const SCOPED_ADDRESS = 'cwd:8bea844ab16aa9b3:default';

function scopedRef(overrides: Partial<SessionState> = {}): SessionRef {
  return {
    address: SCOPED_ADDRESS,
    session: {
      name: 'default',
      sessionScope: { kind: 'cwd', id: '8bea844ab16aa9b3' },
      device: IOS_SIMULATOR,
      createdAt: Date.now(),
      actions: [],
      ...overrides,
    },
  };
}

test('device-in-use recovery names the address --session accepts, not the public name', () => {
  const hint = buildSessionRecoveryHint(scopedRef(), 'device-in-use');

  expect(hint).toContain(`agent-device close --session ${SCOPED_ADDRESS}`);
  expect(hint).toContain(`rerun the command with --session ${SCOPED_ADDRESS}`);
  expect(hint).not.toMatch(/--session default\b/);
});

test('selector-conflict recovery uses the same address', () => {
  const hint = buildSessionRecoveryHint(scopedRef(), 'selector-conflict');

  expect(hint).toContain(`agent-device close --session ${SCOPED_ADDRESS}`);
  expect(hint).not.toMatch(/--session default\b/);
});

test('a recording session recovery uses the address for both close and record stop', () => {
  // Only the presence of an active recording selects this branch; the handle/envelope it carries
  // is irrelevant to the recovery text, so a marker object keeps the fixture readable.
  const ref = scopedRef({
    screenRecording: {} as NonNullable<SessionState['screenRecording']>,
  });

  const hint = buildSessionRecoveryHint(ref, 'device-in-use');

  expect(hint).toContain(`agent-device record stop --session ${SCOPED_ADDRESS}`);
  expect(hint).toContain(`agent-device close --session ${SCOPED_ADDRESS}`);
});

test('an explicitly named session addresses itself unchanged', () => {
  const hint = buildSessionRecoveryHint(
    {
      address: 'checkout',
      session: { ...scopedRef().session, name: 'checkout', sessionScope: undefined },
    },
    'device-in-use',
  );

  expect(hint).toContain('agent-device close --session checkout');
});

// #2580: an implicit workspace session is addressed by platform, so the other platform needs a
// --platform, not an invented name. A hand-named session has no platform address to fall back on.
test('a platform conflict on an implicit workspace session offers that platform session', () => {
  const hint = buildSessionRecoveryHint(scopedRef(), 'selector-conflict', {
    offersPlatformSession: true,
  });

  expect(hint).toContain('--platform to open its own session for this workspace');
});

test('a device or target conflict does not offer a platform session it cannot answer with', () => {
  expect(buildSessionRecoveryHint(scopedRef(), 'selector-conflict')).not.toContain('--platform');
});

test('selector-conflict recovery offers no platform session to a hand-named session', () => {
  const hint = buildSessionRecoveryHint(
    {
      address: 'checkout',
      session: { ...scopedRef().session, name: 'checkout', sessionScope: undefined },
    },
    'selector-conflict',
  );

  expect(hint).not.toContain('--platform');
});
