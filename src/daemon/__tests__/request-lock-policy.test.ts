import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyRequestLockPolicy } from '../request-lock-policy.ts';
import type { SessionState } from '../types.ts';

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

test('strips only fresh-session selector conflicts and restores lock platform', () => {
  const req = applyRequestLockPolicy({
    token: 'token',
    session: 'qa-ios',
    command: 'snapshot',
    positionals: [],
    flags: {
      platform: 'android',
      target: 'tv',
      serial: 'emulator-5554',
    },
    meta: {
      lockPolicy: 'strip',
      lockPlatform: 'ios',
    },
  });

  assert.equal(req.flags?.platform, 'ios');
  assert.equal(req.flags?.target, 'tv');
  assert.equal(req.flags?.serial, undefined);
});

test('strips iOS selectors while preserving compatible macOS platform under Apple lock', () => {
  const req = applyRequestLockPolicy({
    token: 'token',
    session: 'qa-macos',
    command: 'snapshot',
    positionals: [],
    flags: {
      platform: 'macos',
      udid: 'SIM-001',
      iosSimulatorDeviceSet: '/tmp/tenant-a/set',
    },
    meta: {
      lockPolicy: 'strip',
      lockPlatform: 'apple',
    },
  });

  assert.equal(req.flags?.platform, 'macos');
  assert.equal(req.flags?.udid, undefined);
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
        IOS_SESSION,
      ),
    /--serial=emulator-5554/i,
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
    IOS_SESSION,
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
        IOS_SESSION,
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
    ANDROID_SESSION,
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
        ANDROID_SESSION,
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
        ANDROID_SESSION,
      ),
    /--serial=emulator-9999/i,
  );
});

test('strips only conflicting selectors for existing sessions', () => {
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
        serial: 'emulator-5554',
      },
      meta: {
        lockPolicy: 'strip',
      },
    },
    IOS_SESSION,
  );

  assert.equal(req.flags?.platform, 'ios');
  assert.equal(req.flags?.target, undefined);
  assert.equal(req.flags?.device, 'iPhone 16');
  assert.equal(req.flags?.serial, undefined);
});
