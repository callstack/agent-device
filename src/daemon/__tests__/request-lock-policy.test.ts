import { makeStoredSessionRef } from '../../__tests__/test-utils/store-factory.ts';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyRequestLockPolicy } from '../request-lock-policy.ts';
import type { SessionRef, SessionState } from '../session-state.ts';

const IOS_SESSION: SessionState = {
  name: 'qa-ios',
  createdAt: Date.now(),
  actions: [],
  device: {
    platform: 'apple',
    target: 'mobile',
    id: 'SIM-001',
    name: 'iPhone 16',
    kind: 'simulator',
    booted: true,
    simulatorSetPath: '/tmp/tenant-a/set',
  },
};

const ANDROID_SESSION: SessionState = {
  name: 'qa-android',
  createdAt: Date.now(),
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

/** Both fixtures are explicitly named, so each is stored under — and addressed by — its name. */
function ref(session: SessionState): SessionRef {
  return makeStoredSessionRef(session);
}

test('allows compatible fresh-session selectors under request lock policy', () => {
  const req = applyRequestLockPolicy({
    token: 'token',
    session: 'qa-ios',
    command: 'snapshot',
    positionals: [],
    flags: {
      device: 'iPhone 16',
      udid: 'SIM-001',
    },
    meta: {
      lockPolicy: 'reject',
      lockPlatform: 'ios',
    },
  });

  assert.equal(req.flags?.platform, 'ios');
  assert.equal(req.flags?.device, 'iPhone 16');
  assert.equal(req.flags?.udid, 'SIM-001');
});

test('allows open to choose a fresh-session target under request lock policy', () => {
  const req = applyRequestLockPolicy({
    token: 'token',
    session: 'qa-ios',
    command: 'open',
    positionals: ['Settings'],
    flags: {
      platform: 'ios',
      device: 'iPhone 16',
      udid: 'SIM-001',
    },
    meta: {
      lockPolicy: 'reject',
      lockPlatform: 'ios',
    },
  });

  assert.equal(req.flags?.platform, 'ios');
  assert.equal(req.flags?.device, 'iPhone 16');
  assert.equal(req.flags?.udid, 'SIM-001');
});

test('strips only fresh-session SCOPE conflicts and restores lock platform', () => {
  // `strip` resolves pool-narrowing selectors. Identity selectors (--udid/--serial/--device) are
  // never stripped: see the identity table below.
  const req = applyRequestLockPolicy({
    token: 'token',
    session: 'qa-ios',
    command: 'snapshot',
    positionals: [],
    flags: {
      platform: 'android',
      target: 'tv',
      androidDeviceAllowlist: 'emulator-5554',
    },
    meta: {
      lockPolicy: 'strip',
      lockPlatform: 'ios',
    },
  });

  assert.equal(req.flags?.platform, 'ios');
  assert.equal(req.flags?.target, 'tv');
  assert.equal(req.flags?.androidDeviceAllowlist, undefined);
});

test('strips simulator-set scope while preserving compatible macOS platform under Apple lock', () => {
  const req = applyRequestLockPolicy({
    token: 'token',
    session: 'qa-macos',
    command: 'snapshot',
    positionals: [],
    flags: {
      platform: 'macos',
      iosSimulatorDeviceSet: '/tmp/tenant-a/set',
    },
    meta: {
      lockPolicy: 'strip',
      lockPlatform: 'apple',
    },
  });

  assert.equal(req.flags?.platform, 'macos');
  assert.equal(req.flags?.iosSimulatorDeviceSet, undefined);
});

test('rejects existing-session selector conflicts under request lock policy', () => {
  assert.throws(
    () =>
      applyRequestLockPolicy(
        {
          token: 'token',
          session: 'qa-ios',
          command: 'snapshot',
          positionals: [],
          flags: {
            serial: 'emulator-5554',
          },
          meta: {
            lockPolicy: 'reject',
          },
        },
        ref(IOS_SESSION),
      ),
    /Session "qa-ios" is already bound to apple device "iPhone 16" \(SIM-001\), but snapshot selected --serial=emulator-5554/i,
  );
});

test('allows inventory commands to use explicit Apple selectors under another lock platform', () => {
  const req = applyRequestLockPolicy({
    token: 'token',
    session: 'qa-android',
    command: 'apps',
    positionals: [],
    flags: {
      udid: 'SIM-001',
    },
    meta: {
      lockPolicy: 'reject',
      lockPlatform: 'android',
    },
  });

  assert.equal(req.flags?.platform, undefined);
  assert.equal(req.flags?.udid, 'SIM-001');
});

test('defaults inventory commands without explicit selectors to the lock platform', () => {
  const req = applyRequestLockPolicy({
    token: 'token',
    session: 'qa-ios',
    command: 'apps',
    positionals: [],
    flags: {},
    meta: {
      lockPolicy: 'reject',
      lockPlatform: 'ios',
    },
  });

  assert.equal(req.flags?.platform, 'ios');
});

test('allows matching redundant selectors for existing sessions', () => {
  const req = applyRequestLockPolicy(
    {
      token: 'token',
      session: 'qa-ios',
      command: 'snapshot',
      positionals: [],
      flags: {
        platform: 'ios',
        target: 'mobile',
        udid: 'SIM-001',
        device: 'iPhone 16',
        iosSimulatorDeviceSet: '/tmp/tenant-a/set',
      },
      meta: {
        lockPolicy: 'reject',
      },
    },
    ref(IOS_SESSION),
  );

  assert.equal(req.flags?.udid, 'SIM-001');
  assert.equal(req.flags?.device, 'iPhone 16');
});

test('rejects mismatching udid selectors for existing sessions', () => {
  assert.throws(
    () =>
      applyRequestLockPolicy(
        {
          token: 'token',
          session: 'qa-ios',
          command: 'snapshot',
          positionals: [],
          flags: {
            udid: 'SIM-999',
          },
          meta: {
            lockPolicy: 'reject',
          },
        },
        ref(IOS_SESSION),
      ),
    /--udid=SIM-999/i,
  );
});

test('allows matching serial selectors for existing android sessions', () => {
  const req = applyRequestLockPolicy(
    {
      token: 'token',
      session: 'qa-android',
      command: 'snapshot',
      positionals: [],
      flags: {
        serial: 'emulator-5554',
        device: 'Pixel 9',
      },
      meta: {
        lockPolicy: 'reject',
      },
    },
    ref(ANDROID_SESSION),
  );

  assert.equal(req.flags?.serial, 'emulator-5554');
  assert.equal(req.flags?.device, 'Pixel 9');
});

test('rejects mismatching device selectors for existing android sessions', () => {
  assert.throws(
    () =>
      applyRequestLockPolicy(
        {
          token: 'token',
          session: 'qa-android',
          command: 'snapshot',
          positionals: [],
          flags: {
            device: 'Pixel 8',
          },
          meta: {
            lockPolicy: 'reject',
          },
        },
        ref(ANDROID_SESSION),
      ),
    /--device=Pixel 8/i,
  );
});

test('rejects mismatching serial selectors for existing android sessions', () => {
  assert.throws(
    () =>
      applyRequestLockPolicy(
        {
          token: 'token',
          session: 'qa-android',
          command: 'snapshot',
          positionals: [],
          flags: {
            serial: 'emulator-9999',
          },
          meta: {
            lockPolicy: 'reject',
          },
        },
        ref(ANDROID_SESSION),
      ),
    /--serial=emulator-9999/i,
  );
});

// Fresh-session target ↔ lock-platform matrix (`targetSelectorsConflict`). A fresh session under a
// platform lock binds its first device from that platform, so a target that cannot exist on it must
// fail loudly instead of binding the wrong device class (or none). Each family keeps its native
// target: mobile-family locks bind `mobile`, vega binds `tv`, desktop-family locks bind `desktop`.
test('a mobile-family lock accepts its native mobile target on a fresh session', () => {
  for (const lockPlatform of ['android', 'harmonyos', 'ios'] as const) {
    const req = applyRequestLockPolicy({
      token: 'token',
      session: 'qa-fresh',
      command: 'snapshot',
      positionals: [],
      flags: { target: 'mobile' },
      meta: { lockPolicy: 'reject', lockPlatform },
    });
    assert.equal(req.flags?.target, 'mobile');
    assert.equal(req.flags?.platform, lockPlatform);
  }
});

test('rejects a desktop target under a mobile-family lock platform on a fresh session', () => {
  for (const lockPlatform of ['android', 'harmonyos', 'ios'] as const) {
    assert.throws(
      () =>
        applyRequestLockPolicy({
          token: 'token',
          session: 'qa-fresh',
          command: 'snapshot',
          positionals: [],
          flags: { target: 'desktop' },
          meta: { lockPolicy: 'reject', lockPlatform },
        }),
      /but this request selected --target=desktop/i,
      `${lockPlatform} locks cannot host a desktop target`,
    );
  }
});

test('a vega lock accepts only a tv target on a fresh session', () => {
  const req = applyRequestLockPolicy({
    token: 'token',
    session: 'qa-fresh',
    command: 'snapshot',
    positionals: [],
    flags: { target: 'tv' },
    meta: { lockPolicy: 'reject', lockPlatform: 'vega' },
  });
  assert.equal(req.flags?.target, 'tv');
  assert.equal(req.flags?.platform, 'vega');

  for (const target of ['mobile', 'desktop'] as const) {
    assert.throws(
      () =>
        applyRequestLockPolicy({
          token: 'token',
          session: 'qa-fresh',
          command: 'snapshot',
          positionals: [],
          flags: { target },
          meta: { lockPolicy: 'reject', lockPlatform: 'vega' },
        }),
      new RegExp(`--target=${target}`, 'i'),
      'a vega lock cannot bind a non-tv target',
    );
  }
});

test('desktop-family locks (macos/linux/web) accept only a desktop target on a fresh session', () => {
  for (const lockPlatform of ['macos', 'linux', 'web'] as const) {
    const req = applyRequestLockPolicy({
      token: 'token',
      session: 'qa-fresh',
      command: 'snapshot',
      positionals: [],
      flags: { target: 'desktop' },
      meta: { lockPolicy: 'reject', lockPlatform },
    });
    assert.equal(req.flags?.target, 'desktop');

    for (const target of ['mobile', 'tv'] as const) {
      assert.throws(
        () =>
          applyRequestLockPolicy({
            token: 'token',
            session: 'qa-fresh',
            command: 'snapshot',
            positionals: [],
            flags: { target },
            meta: { lockPolicy: 'reject', lockPlatform },
          }),
        new RegExp(`--target=${target}`, 'i'),
        `${lockPlatform} locks cannot host a ${target} target`,
      );
    }
  }
});

test('an Apple lock accepts every target because Apple spans mobile, tv, and desktop', () => {
  for (const target of ['mobile', 'tv', 'desktop'] as const) {
    const req = applyRequestLockPolicy({
      token: 'token',
      session: 'qa-fresh',
      command: 'snapshot',
      positionals: [],
      flags: { target },
      meta: { lockPolicy: 'reject', lockPlatform: 'apple' },
    });
    assert.equal(req.flags?.target, target);
  }
});

test('strips only conflicting scope selectors for existing sessions, keeping matching identity', () => {
  const req = applyRequestLockPolicy(
    {
      token: 'token',
      session: 'qa-ios',
      command: 'snapshot',
      positionals: [],
      flags: {
        platform: 'ios',
        target: 'tv',
        device: 'iPhone 16',
        androidDeviceAllowlist: 'emulator-5554',
      },
      meta: {
        lockPolicy: 'strip',
      },
    },
    ref(IOS_SESSION),
  );

  assert.equal(req.flags?.platform, 'ios');
  assert.equal(req.flags?.target, undefined);
  // --device names the bound device, so it never conflicted and survives.
  assert.equal(req.flags?.device, 'iPhone 16');
  assert.equal(req.flags?.androidDeviceAllowlist, undefined);
});
