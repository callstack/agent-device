import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import { isCommandTimeoutError } from '@agent-device/host-kit/command';

vi.mock('../tool-provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tool-provider.ts')>();
  return {
    ...actual,
    runXcrun: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
  };
});
vi.mock('@agent-device/host-kit/host-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/host-file')>();
  return {
    ...actual,
    hostTemporaryDirectory: () => '/tmp',
    readHostTextFile: vi.fn(async () => ''),
    unlinkHostFile: vi.fn(async () => {}),
  };
});

import { readHostTextFile, unlinkHostFile } from '@agent-device/host-kit/host-file';
import {
  parseIosDeviceAppsPayload,
  parseIosDeviceProcessesPayload,
  resolveIosDevicectlHint,
  runIosDevicectlJsonRequest,
} from '../devicectl.ts';
import { runXcrun } from '../tool-provider.ts';

const mockRunXcrun = vi.mocked(runXcrun);
const mockReadHostTextFile = vi.mocked(readHostTextFile);
const mockUnlinkHostFile = vi.mocked(unlinkHostFile);

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

test('runIosDevicectlJsonRequest reports a non-zero exit as a typed failure instead of throwing', async () => {
  mockRunXcrun.mockResolvedValue({ exitCode: 2, stdout: '', stderr: 'no such option --displays' });
  mockReadHostTextFile.mockResolvedValue('');
  mockUnlinkHostFile.mockClear();

  const outcome = await runIosDevicectlJsonRequest({
    jsonPrefix: 'agent-device-test',
    args: ['devicectl', 'device', 'info', 'displays', '--device', 'UDID-1'],
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'command-failed');
  assert.equal(outcome.result?.stderr, 'no such option --displays');
  assert.equal(mockUnlinkHostFile.mock.calls.length, 1);
});

test('runIosDevicectlJsonRequest separates a malformed payload from a failed command', async () => {
  mockRunXcrun.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockReadHostTextFile.mockResolvedValue('{"result": ');

  const outcome = await runIosDevicectlJsonRequest({
    jsonPrefix: 'agent-device-test',
    args: ['devicectl', 'device', 'info', 'displays', '--device', 'UDID-1'],
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'unreadable-json');
  assert.match(String(outcome.cause), /JSON|Unexpected/);
});

test('runIosDevicectlJsonRequest lets an exec timeout stay a timeout', async () => {
  mockRunXcrun.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'xcrun timed out after 5000ms', {
      cmd: 'xcrun',
      args: ['devicectl'],
      timeoutMs: 5_000,
    }),
  );

  await assert.rejects(
    runIosDevicectlJsonRequest({
      jsonPrefix: 'agent-device-test',
      args: ['devicectl', 'device', 'info', 'displays', '--device', 'UDID-1'],
      timeoutMs: 5_000,
    }),
    (error: unknown) => isCommandTimeoutError(error),
  );
  mockRunXcrun.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

test('runIosDevicectlJsonRequest still tolerates a recognized failure payload', async () => {
  mockRunXcrun.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
  mockReadHostTextFile.mockResolvedValue('{"error":{"code":7}}');

  const outcome = await runIosDevicectlJsonRequest({
    jsonPrefix: 'agent-device-test',
    args: ['devicectl', 'device', 'process', 'terminate', '--device', 'UDID-1'],
    tolerateFailurePayload: (payload) =>
      (payload as { error?: { code?: number } }).error?.code === 7,
  });

  assert.equal(outcome.ok, true);
});
