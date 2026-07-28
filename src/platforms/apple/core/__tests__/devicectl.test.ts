import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseIosDeviceAppsPayload, parseIosDeviceProcessesPayload } from '../devicectl.ts';

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
