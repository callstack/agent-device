import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { PRE_DISPATCH_REFUSAL_REASONS, normalizeError } from '@agent-device/kernel/errors';
import type { SessionState } from './session-state.ts';
import {
  namedSessionNotFoundError,
  requireNamedSessionHoldsDevice,
} from './explicit-session-resolution.ts';

function request(overrides: Partial<DaemonWireRequest> = {}): DaemonWireRequest {
  return {
    token: 't',
    session: 'e2e-ios-0',
    command: 'snapshot',
    positionals: [],
    ...overrides,
  };
}

function heldSession(address = 'e2e-ios-0'): SessionState {
  return {
    name: address,
    device: { platform: 'android', id: 'emulator-5554', name: 'Pixel 9', kind: 'emulator' },
    createdAt: 0,
    actions: [],
  };
}

function normalizeRefusal(error: unknown) {
  assert.ok(error instanceof Error);
  return normalizeError(error);
}

test('a named session the daemon does not hold is refused on the session, not the device', () => {
  assert.throws(
    () =>
      requireNamedSessionHoldsDevice({
        req: request({ meta: { sessionExplicit: true } }),
        sessionAddress: 'e2e-ios-0',
        session: undefined,
      }),
    (error: unknown) => {
      const refusal = normalizeRefusal(error);
      assert.equal(refusal.code, 'SESSION_NOT_FOUND');
      assert.equal(
        refusal.message,
        'No active session "e2e-ios-0". Run agent-device open <app> --session e2e-ios-0 first, ' +
          'or omit --session to run against a device selector.',
      );
      assert.equal(refusal.details?.reason, PRE_DISPATCH_REFUSAL_REASONS.namedSessionNotFound);
      assert.equal(refusal.details?.dispatched, 'no');
      assert.equal(refusal.details?.session, 'e2e-ios-0');
      assert.match(String(refusal.hint), /agent-device session list/);
      return true;
    },
  );
});

test('the session flag alone names a session as firmly as the client meta does', () => {
  // The predicate itself is pinned in @agent-device/kernel/contracts; what the guard owes is
  // that BOTH carriers reach the refusal.
  const fromMeta = request({ meta: { sessionExplicit: true } });
  const fromFlag = request({ flags: { session: 'e2e-ios-0' } });
  for (const req of [fromMeta, fromFlag]) {
    assert.throws(
      () =>
        requireNamedSessionHoldsDevice({ req, sessionAddress: 'e2e-ios-0', session: undefined }),
      { code: 'SESSION_NOT_FOUND' },
    );
  }
});

test('a request that never named a session keeps its sessionless device resolution', () => {
  requireNamedSessionHoldsDevice({
    req: request({ session: 'cwd:1a2b3c4d5e6f7a8b:ios' }),
    sessionAddress: 'cwd:1a2b3c4d5e6f7a8b:ios',
    session: undefined,
  });
  requireNamedSessionHoldsDevice({
    req: request({ session: 'default', flags: {} }),
    sessionAddress: 'default',
    session: undefined,
  });
});

test('a session the daemon holds never reaches the refusal', () => {
  requireNamedSessionHoldsDevice({
    req: request({ meta: { sessionExplicit: true } }),
    sessionAddress: 'e2e-ios-0',
    session: heldSession(),
  });
});

test('a named session beside a device selector keeps the target the caller stated', () => {
  for (const flags of [
    { udid: 'SIM-1' },
    { serial: 'emulator-5554' },
    { device: 'iPhone 17' },
    { platform: 'ios' as const },
    { target: 'tv' as const },
  ]) {
    requireNamedSessionHoldsDevice({
      req: request({ flags, meta: { sessionExplicit: true } }),
      sessionAddress: 'e2e-ios-0',
      session: undefined,
    });
  }
});

test('the recovery command echoes the address back, quoted only where the shell needs it', () => {
  // A scoped store key is already a safe shell word, so the hint hands back the exact address
  // `session list` printed; a name with a space has to arrive quoted to run as one argument.
  const scoped = normalizeRefusal(namedSessionNotFoundError('cwd:1a2b3c4d5e6f7a8b:ios'));
  assert.match(String(scoped.message), /--session cwd:1a2b3c4d5e6f7a8b:ios first/);
  assert.equal(scoped.details?.session, 'cwd:1a2b3c4d5e6f7a8b:ios');
  const spaced = normalizeRefusal(namedSessionNotFoundError('my session'));
  assert.match(String(spaced.message), /--session 'my session' first/);
});
