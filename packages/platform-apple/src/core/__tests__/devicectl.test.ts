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

test('resolveIosDevicectlHint points at Developer Mode when the disk image cannot mount', () => {
  // Observed on a freshly paired iPhone: unlocked, trusted, `available (paired)`
  // in Xcode, and still unusable because Developer Mode was off. The default
  // hint sent the user to re-check trust, which was already fine.
  const hint = resolveIosDevicectlHint(
    '',
    'Failed to launch iOS app: The developer disk image could not be mounted on this device. (com.apple.dt.CoreDeviceError error 12040 (0x2F08))',
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
