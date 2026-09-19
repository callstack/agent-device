import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseIosDeviceAppsPayload,
  parseIosDeviceProcessesPayload,
  resolveIosDevicectlHint,
} from '../devicectl.ts';

test('parseIosDeviceAppsPayload maps devicectl app entries', () => {
  const apps = parseIosDeviceAppsPayload({
    result: {
      apps: [
        {
          bundleIdentifier: 'com.apple.Maps',
          name: 'Maps',
          url: 'file:///Applications/Maps.app/',
        },
        {
          bundleIdentifier: 'com.example.NoName',
        },
      ],
    },
  });

  assert.equal(apps.length, 2);
  assert.deepEqual(apps[0], {
    bundleId: 'com.apple.Maps',
    name: 'Maps',
    url: 'file:///Applications/Maps.app/',
  });
  assert.equal(apps[1]!.bundleId, 'com.example.NoName');
  assert.equal(apps[1]!.name, 'com.example.NoName');
  assert.equal(apps[1]!.url, undefined);
});

test('parseIosDeviceAppsPayload ignores malformed entries', () => {
  const apps = parseIosDeviceAppsPayload({
    result: {
      apps: [null, {}, { name: 'Missing bundle id' }, { bundleIdentifier: '' }],
    },
  });
  assert.deepEqual(apps, []);
});

test('parseIosDeviceProcessesPayload maps running process entries', () => {
  const processes = parseIosDeviceProcessesPayload({
    result: {
      runningProcesses: [
        {
          executable: 'file:///private/var/containers/Bundle/Application/ABC123/Demo.app/Demo',
          processIdentifier: 421,
        },
        {
          executable: 'file:///usr/libexec/backboardd',
          processIdentifier: 72,
        },
      ],
    },
  });

  assert.deepEqual(processes, [
    {
      executable: 'file:///private/var/containers/Bundle/Application/ABC123/Demo.app/Demo',
      pid: 421,
    },
    {
      executable: 'file:///usr/libexec/backboardd',
      pid: 72,
    },
  ]);
});

test('resolveIosDevicectlHint names the developer disk image when that is all it reports', () => {
  // Observed on a freshly paired iPhone: unlocked, trusted, `available (paired)`
  // in Xcode, and still unusable. This line used to be answered with Developer
  // Mode advice, which is right often enough to survive as a guess and wrong
  // whenever Xcode simply has not finished installing device support on a phone
  // whose toggle is already on (#2683). The device reports both states apart, so
  // the hint answers the one the output named.
  const hint = resolveIosDevicectlHint(
    '',
    'Failed to launch iOS app: The developer disk image could not be mounted on this device. (com.apple.dt.CoreDeviceError error 12040 (0x2F08))',
  );

  assert.match(String(hint), /device support/i);
  assert.doesNotMatch(String(hint), /Developer Mode/);
});

test('resolveIosDevicectlHint names Developer Mode when the output says both', () => {
  // The pairing this hint was written for: a phone with the toggle off cannot
  // mount the image either, so the toggle is the thing to fix and the direction
  // that genuinely holds (#2683).
  const hint = resolveIosDevicectlHint(
    '',
    'The operation failed because Developer Mode is disabled. The developer disk image could not be mounted on this device.',
  );

  assert.match(String(hint), /Developer Mode/);
  assert.match(String(hint), /Privacy & Security/);
});

test('resolveIosDevicectlHint reports the Developer Mode status devicectl states outright', () => {
  const hint = resolveIosDevicectlHint(
    '',
    'The operation failed because Developer Mode is disabled.',
  );

  assert.match(String(hint), /Developer Mode/);
});

test('resolveIosDevicectlHint explains how to pair an unpaired device', () => {
  const hint = resolveIosDevicectlHint(
    '',
    'The device must be paired before it can be connected. (com.apple.dt.CoreDeviceError error 2 (0x02))',
  );

  assert.match(String(hint), /Trust prompt/);
  assert.match(String(hint), /passcode/);
});

test('resolveIosDevicectlHint still returns null for an unrecognised failure', () => {
  assert.equal(resolveIosDevicectlHint('', 'some unrelated devicectl explosion'), null);
});
