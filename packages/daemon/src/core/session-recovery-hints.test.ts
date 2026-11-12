import { makeStoredSessionRef } from '../__tests__/support/store-factory.ts';
import { test, expect } from 'vitest';
import {
  buildForeignWorkspaceSessionConflict,
  buildSessionRecoveryHint,
} from './session-recovery-hints.ts';
import type { SessionRef, SessionState } from './session-state.ts';
import { IOS_SIMULATOR } from '@agent-device/test-kit';

// The recovery hint's whole job is to hand back a command that works. For an implicitly
// cwd-scoped session — named `default`, stored as `cwd:<hash>:default` — building it from the
// name produced `agent-device close --session default`, which marks the session explicit and so
// addresses a different, non-existent session: the caller got SESSION_NOT_FOUND from the exact
// command the previous error told them to run, and the device stayed held (#2031).

const SCOPED_ADDRESS = 'cwd:8bea844ab16aa9b3:default';

function scopedRef(overrides: Partial<SessionState> = {}): SessionRef {
  return makeStoredSessionRef(
    {
      name: 'default',
      sessionScope: { kind: 'cwd', id: '8bea844ab16aa9b3' },
      device: IOS_SIMULATOR,
      createdAt: Date.now(),
      actions: [],
      ...overrides,
    },
    SCOPED_ADDRESS,
  );
}

test('device-in-use recovery names the address --session accepts, not the public name', () => {
  const hint = buildSessionRecoveryHint(scopedRef(), 'device-in-use');

  expect(hint).toContain(`agent-device close --session ${SCOPED_ADDRESS}`);
  expect(hint).toContain(`reuse --session ${SCOPED_ADDRESS}`);
  expect(hint).not.toMatch(/--session default\b/);
});

// A device-in-use hint is read by agents sharing a host: it must offer the moves that leave the
// holding session alone before any that would take it over.
test('device-in-use recovery lists non-takeover options before reusing or closing the holder', () => {
  const hint = buildSessionRecoveryHint(scopedRef(), 'device-in-use', { offersDeviceWait: true });

  const firstTakeover = Math.min(
    hint.indexOf(`--session ${SCOPED_ADDRESS}`),
    hint.indexOf('close --session'),
  );
  expect(firstTakeover).toBeGreaterThan(-1);
  expect(hint.indexOf('agent-device devices')).toBeGreaterThan(-1);
  expect(hint.indexOf('agent-device devices')).toBeLessThan(firstTakeover);
  expect(hint.indexOf('--wait <ms>')).toBeGreaterThan(-1);
  expect(hint.indexOf('--wait <ms>')).toBeLessThan(firstTakeover);
  expect(hint.slice(0, firstTakeover)).toMatch(/only if that session is yours/i);
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
    makeStoredSessionRef({ ...scopedRef().session, name: 'checkout', sessionScope: undefined }),
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
    makeStoredSessionRef({ ...scopedRef().session, name: 'checkout', sessionScope: undefined }),
    'selector-conflict',
  );

  expect(hint).not.toContain('--platform');
});

// Diagnostic redaction cuts any string over 400 characters, which would drop the trailing
// commands of a hint built for a long scoped address.
test('every recovery variant fits the redaction cap with a scoped address', () => {
  const recording = scopedRef({
    screenRecording: {} as NonNullable<SessionState['screenRecording']>,
  });
  const hints = [
    buildSessionRecoveryHint(scopedRef(), 'device-in-use', { offersDeviceWait: true }),
    buildSessionRecoveryHint(scopedRef(), 'device-in-use', { waitedMs: 30_000 }),
    buildSessionRecoveryHint(scopedRef(), 'selector-conflict', { offersPlatformSession: true }),
    buildSessionRecoveryHint(recording, 'device-in-use'),
    buildSessionRecoveryHint(recording, 'selector-conflict'),
    String(
      buildForeignWorkspaceSessionConflict(scopedRef(), IOS_SIMULATOR, { offersDeviceWait: true })
        .error.details?.hint,
    ),
  ];

  for (const hint of hints) expect(hint.length).toBeLessThanOrEqual(400);
});
