import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { applyRequestLockPolicy } from '../request-lock-policy.ts';
import type { DaemonRequest, SessionState } from '../types.ts';

/**
 * One table for the device-identity half of the session lock. A device identity selector
 * (`--udid`/`--serial`/`--device`) that disagrees with the lock can never be honored alongside it,
 * so it fails under BOTH policies — `strip` used to delete it and run the command against the other
 * device, which is silently-wrong automation rather than a loud failure.
 *
 * The dimensions are crossed deliberately: fresh vs existing session, matching / conflicting /
 * absent identity, `reject` vs legacy `strip`, a binding-or-mutating command vs an inventory
 * command, and Android `serial` / Android `udid` / Apple `udid` selectors.
 */
const APPLE_SESSION: SessionState = {
  name: 'qa-ios',
  createdAt: 0,
  actions: [],
  device: {
    platform: 'apple',
    target: 'mobile',
    id: 'SIM-001',
    name: 'iPhone 16',
    kind: 'simulator',
    booted: true,
  },
};

const ANDROID_SESSION: SessionState = {
  name: 'qa-android',
  createdAt: 0,
  actions: [],
  device: {
    platform: 'android',
    target: 'mobile',
    id: 'emulator-5554',
    name: 'Pixel 9',
    kind: 'emulator',
    booted: true,
  },
};

type Outcome =
  | { kind: 'allowed'; keepsSelectors: Record<string, string | undefined> }
  | { kind: 'stripped'; keepsSelectors: Record<string, string | undefined> }
  | { kind: 'refused'; namesSelector: string };

type Row = {
  name: string;
  session?: SessionState;
  lockPlatform?: DaemonRequest['meta'] extends infer M
    ? M extends { lockPlatform?: infer P }
      ? P
      : never
    : never;
  command: string;
  flags: Record<string, string>;
  policy: 'reject' | 'strip';
  expect: Outcome;
};

const ROWS: Row[] = [
  // --- existing session, conflicting identity: refused under BOTH policies ---
  {
    name: 'apple udid naming another device, reject',
    session: APPLE_SESSION,
    command: 'home',
    flags: { udid: 'SIM-999' },
    policy: 'reject',
    expect: { kind: 'refused', namesSelector: '--udid=SIM-999' },
  },
  {
    name: 'apple udid naming another device, strip',
    session: APPLE_SESSION,
    command: 'home',
    flags: { udid: 'SIM-999' },
    policy: 'strip',
    expect: { kind: 'refused', namesSelector: '--udid=SIM-999' },
  },
  {
    name: 'android serial naming another device, strip',
    session: ANDROID_SESSION,
    command: 'home',
    flags: { serial: 'emulator-9999' },
    policy: 'strip',
    expect: { kind: 'refused', namesSelector: '--serial=emulator-9999' },
  },
  {
    name: 'android device name naming another device, strip',
    session: ANDROID_SESSION,
    command: 'home',
    flags: { device: 'Pixel 8' },
    policy: 'strip',
    expect: { kind: 'refused', namesSelector: '--device=Pixel 8' },
  },
  {
    name: 'apple udid on an android session, strip',
    session: ANDROID_SESSION,
    command: 'home',
    flags: { udid: 'SIM-001' },
    policy: 'strip',
    expect: { kind: 'refused', namesSelector: '--udid=SIM-001' },
  },
  // --- existing session, matching or absent identity: untouched ---
  {
    name: 'matching apple udid, reject',
    session: APPLE_SESSION,
    command: 'home',
    flags: { udid: 'SIM-001' },
    policy: 'reject',
    expect: { kind: 'allowed', keepsSelectors: { udid: 'SIM-001' } },
  },
  {
    name: 'matching android serial, strip',
    session: ANDROID_SESSION,
    command: 'home',
    flags: { serial: 'emulator-5554' },
    policy: 'strip',
    expect: { kind: 'allowed', keepsSelectors: { serial: 'emulator-5554' } },
  },
  {
    name: 'absent identity, strip drops only the conflicting scope selector',
    session: ANDROID_SESSION,
    command: 'home',
    flags: { target: 'tv' },
    policy: 'strip',
    expect: { kind: 'stripped', keepsSelectors: { target: undefined } },
  },
  // --- fresh session (lock platform, no bound device) ---
  {
    name: 'android lock, apple udid, reject',
    lockPlatform: 'android',
    command: 'home',
    flags: { udid: 'emulator-5580' },
    policy: 'reject',
    expect: { kind: 'refused', namesSelector: '--udid=emulator-5580' },
  },
  {
    name: 'android lock, apple udid, strip',
    lockPlatform: 'android',
    command: 'home',
    flags: { udid: 'emulator-5580' },
    policy: 'strip',
    expect: { kind: 'refused', namesSelector: '--udid=emulator-5580' },
  },
  {
    name: 'android lock, android serial is addressable and survives',
    lockPlatform: 'android',
    command: 'home',
    flags: { serial: 'emulator-5580' },
    policy: 'strip',
    expect: { kind: 'allowed', keepsSelectors: { serial: 'emulator-5580' } },
  },
  // --- inventory commands may name any device under any lock ---
  {
    name: 'inventory command keeps a foreign apple udid under an android lock',
    lockPlatform: 'android',
    command: 'apps',
    flags: { udid: 'SIM-001' },
    policy: 'reject',
    expect: { kind: 'allowed', keepsSelectors: { udid: 'SIM-001' } },
  },
  {
    name: 'inventory command keeps a foreign identity against a bound session',
    session: ANDROID_SESSION,
    command: 'apps',
    flags: { udid: 'SIM-001' },
    policy: 'strip',
    expect: { kind: 'allowed', keepsSelectors: { udid: 'SIM-001' } },
  },
];

for (const row of ROWS) {
  test(`session lock: ${row.name}`, () => {
    const request = {
      token: 'token',
      session: row.session?.name ?? 'fresh',
      command: row.command,
      positionals: [],
      flags: { ...row.flags },
      meta: {
        lockPolicy: row.policy,
        ...(row.lockPlatform ? { lockPlatform: row.lockPlatform } : {}),
      },
    } as DaemonRequest;

    if (row.expect.kind === 'refused') {
      const error = assertThrowsAppError(() => applyRequestLockPolicy(request, row.session));
      assert.equal(error.code, 'INVALID_ARGS');
      assert.ok(
        error.message.includes(row.expect.namesSelector),
        `message must name the refused selector: ${error.message}`,
      );
      const details = error.details as Record<string, unknown>;
      assert.deepEqual(details.requestedDevice, row.flags, 'requested identity is structured');
      if (row.session) {
        assert.deepEqual(details.boundDevice, {
          platform: row.session.device.platform,
          name: row.session.device.name,
          id: row.session.device.id,
        });
      }
      const hint = String(details.hint ?? '');
      assert.ok(!hint.includes('--session-lock'), `hint must not offer strip: ${hint}`);
      assert.ok(
        /close/i.test(hint) || /drop --session/i.test(hint),
        `hint offers closing: ${hint}`,
      );
      assert.ok(/remove|rerun/i.test(hint), `hint offers dropping the selector: ${hint}`);
      return;
    }

    const applied = applyRequestLockPolicy(request, row.session);
    for (const [key, value] of Object.entries(row.expect.keepsSelectors)) {
      assert.equal(
        (applied.flags as Record<string, unknown>)[key],
        value,
        `${key} after ${row.policy}`,
      );
    }
  });
}

function assertThrowsAppError(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the lock policy to refuse the request' });
}
