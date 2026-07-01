import { test } from 'vitest';
import assert from 'node:assert/strict';
import { assertSessionSelectorMatches } from '../session-selector.ts';
import { AppError } from '../../kernel/errors.ts';
import type { SessionState } from '../types.ts';

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    name: 'default',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel 9',
      kind: 'emulator',
      target: 'tv',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
    ...overrides,
  };
}

test('accepts matching platform and serial selectors', () => {
  const session = makeSession();
  assert.doesNotThrow(() =>
    assertSessionSelectorMatches(session, {
      platform: 'android',
      target: 'tv',
      serial: 'emulator-5554',
    }),
  );
});

test('rejects mismatched platform selector', () => {
  const session = makeSession();
  assert.throws(
    () => assertSessionSelectorMatches(session, { platform: 'ios' }),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === 'INVALID_ARGS' &&
      err.message.includes('--platform=ios'),
  );
});

test('selector mismatch explains session recovery commands', () => {
  const session = makeSession();
  assert.throws(
    () => assertSessionSelectorMatches(session, { platform: 'ios' }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'INVALID_ARGS');
      assert.match(err.message, /Session "default" is already bound to android device "Pixel 9"/i);
      assert.match(err.message, /--platform=ios/i);
      assert.match(err.details?.hint ?? '', /agent-device session list/i);
      assert.match(err.details?.hint ?? '', /--session default/i);
      assert.match(err.details?.hint ?? '', /agent-device close --session default/i);
      return true;
    },
  );
});

test('accepts --platform apple alias for ios sessions', () => {
  const session = makeSession({
    device: {
      platform: 'apple',
      id: 'tv-sim-1',
      name: 'Apple TV',
      kind: 'simulator',
      target: 'tv',
      booted: true,
    },
  });
  assert.doesNotThrow(() =>
    assertSessionSelectorMatches(session, { platform: 'apple', target: 'tv' }),
  );
});

test('rejects mismatched serial selector', () => {
  const session = makeSession();
  assert.throws(
    () => assertSessionSelectorMatches(session, { serial: 'emulator-9999' }),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === 'INVALID_ARGS' &&
      err.message.includes('--serial=emulator-9999'),
  );
});

test('rejects udid selector for android session', () => {
  const session = makeSession();
  assert.throws(
    () => assertSessionSelectorMatches(session, { udid: 'ABC-123' }),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === 'INVALID_ARGS' &&
      err.message.includes('--udid=ABC-123'),
  );
});

test('accepts matching device selector (case-insensitive)', () => {
  const session = makeSession();
  assert.doesNotThrow(() =>
    assertSessionSelectorMatches(session, {
      device: 'pixel 9',
    }),
  );
});

test('rejects mismatched target selector', () => {
  const session = makeSession();
  assert.throws(
    () => assertSessionSelectorMatches(session, { target: 'mobile' }),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === 'INVALID_ARGS' &&
      err.message.includes('--target=mobile'),
  );
});

test('rejects mismatched device selector', () => {
  const session = makeSession();
  assert.throws(
    () => assertSessionSelectorMatches(session, { device: 'thymikee-iphone' }),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === 'INVALID_ARGS' &&
      err.message.includes('--device=thymikee-iphone'),
  );
});

test('accepts matching ios simulator set selector for iOS simulator sessions', () => {
  const session = makeSession({
    device: {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17',
      kind: 'simulator',
      target: 'mobile',
      booted: true,
      simulatorSetPath: '/tmp/tenant-a/simulator-set',
    },
  });
  assert.doesNotThrow(() =>
    assertSessionSelectorMatches(session, { iosSimulatorDeviceSet: '/tmp/tenant-a/simulator-set' }),
  );
});

test('rejects android allowlist selector when session device is not allowlisted', () => {
  const session = makeSession();
  assert.throws(
    () => assertSessionSelectorMatches(session, { androidDeviceAllowlist: 'emulator-9999' }),
    (err: unknown) =>
      err instanceof AppError &&
      err.code === 'INVALID_ARGS' &&
      err.message.includes('--android-device-allowlist=emulator-9999'),
  );
});
