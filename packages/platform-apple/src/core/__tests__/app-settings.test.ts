import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, retryWithPolicy: vi.fn(actual.retryWithPolicy) };
});
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: vi.fn(actual.ensureBootedSimulator) };
});

const execActual = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);
const retryActual = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);
const simulatorActual = await vi.importActual<typeof import('../simulator.ts')>('../simulator.ts');

import { setIosSetting } from '../app-settings.ts';
import { withMockedMacOsHelper } from './macos-helper-test-utils.ts';
import { ensureBootedSimulator } from '../simulator.ts';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import { retryWithPolicy } from '@agent-device/host-kit/retry';
import { assertRejectsAppError } from '../../__tests__/app-error.ts';
import { withFakeAppleTool, type FakeAppleToolResponse } from '../../__tests__/fake-apple-tool.ts';
import { IOS_TEST_SIMULATOR, MACOS_TEST_DEVICE } from './apple-core-stub-helpers.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockRetryWithPolicy = vi.mocked(retryWithPolicy);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmd.mockImplementation(execActual.runCmd);
  mockRetryWithPolicy.mockImplementation(retryActual.retryWithPolicy);
  mockEnsureBootedSimulator.mockImplementation(simulatorActual.ensureBootedSimulator);
});

// The fake tool provider installs through the production withAppleToolProvider
// scope, so `calls` records the flat invocations the PATH-stub scripts saw.

const BOOTED_SIM_LIST_JSON = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'sim-1', state: 'Booted' }] },
});

function isSimctlListDevices(args: string[]): boolean {
  return (
    args[0] === 'simctl' && args.includes('list') && args.includes('devices') && args.includes('-j')
  );
}

function unexpectedArgs(args: string[]): FakeAppleToolResponse {
  return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
}

const FACEID_MATCH_ARGS = 'simctl spawn sim-1 notifyutil -p com.apple.BiometricKit_Sim.pearl.match';
const FACEID_NONMATCH_ARGS =
  'simctl spawn sim-1 notifyutil -p com.apple.BiometricKit_Sim.pearl.nomatch';
const TOUCHID_MATCH_ARGS =
  'simctl spawn sim-1 notifyutil -p com.apple.BiometricKit_Sim.fingerTouch.match';
const ENROLL_ARGS =
  'simctl spawn sim-1 notifyutil -s com.apple.BiometricKit.enrollmentChanged 1 -p com.apple.BiometricKit.enrollmentChanged';
const UNENROLL_ARGS =
  'simctl spawn sim-1 notifyutil -s com.apple.BiometricKit.enrollmentChanged 0 -p com.apple.BiometricKit.enrollmentChanged';

async function collectBiometricCalls(
  setting: 'faceid' | 'touchid',
  state: string,
): Promise<string[]> {
  const calls: string[] = [];
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args[0] === 'simctl' && args[1] === 'spawn') {
        calls.push(args.join(' '));
        return '';
      }
      return unexpectedArgs(args);
    },
    async () => {
      await setIosSetting(IOS_TEST_SIMULATOR, setting, state);
    },
  );
  return calls;
}

test('setIosSetting faceid match posts the BiometricKit_Sim pearl match notification', async () => {
  assert.deepEqual(await collectBiometricCalls('faceid', 'match'), [FACEID_MATCH_ARGS]);
});

test('setIosSetting faceid nonmatch posts the BiometricKit_Sim pearl nomatch notification', async () => {
  assert.deepEqual(await collectBiometricCalls('faceid', 'nonmatch'), [FACEID_NONMATCH_ARGS]);
});

test('setIosSetting touchid match posts the BiometricKit_Sim fingerTouch match notification', async () => {
  assert.deepEqual(await collectBiometricCalls('touchid', 'match'), [TOUCHID_MATCH_ARGS]);
});

test('setIosSetting biometric enroll sets enrollmentChanged before posting it', async () => {
  assert.deepEqual(await collectBiometricCalls('faceid', 'enroll'), [ENROLL_ARGS]);
  assert.deepEqual(await collectBiometricCalls('touchid', 'unenroll'), [UNENROLL_ARGS]);
});

test('setIosSetting biometric rejects an unknown state before spawning anything', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      return unexpectedArgs(args);
    },
    async () => {
      await assertRejectsAppError(() => setIosSetting(IOS_TEST_SIMULATOR, 'faceid', 'toggle'), {
        code: 'INVALID_ARGS',
        message: /Use match\|nonmatch\|enroll\|unenroll/,
      });
    },
  );
});

test('setIosSetting touchid reports COMMAND_FAILED with the notifyutil attempt when the post fails', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      return { stderr: 'Failed to boot simulator service', exitCode: 1 };
    },
    async () => {
      await assert.rejects(
        () => setIosSetting(IOS_TEST_SIMULATOR, 'touchid', 'match'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /Failed to simulate touchid/);
          const attempts = (error.details as { attempts: Array<{ args: string }> }).attempts;
          assert.equal(attempts.length, 1);
          assert.equal(attempts[0]?.args, TOUCHID_MATCH_ARGS);
          return true;
        },
      );
    },
  );
});

test('setIosSetting appearance toggle queries current osascript appearance on macOS', async () => {
  await withFakeAppleTool(
    (args) => {
      if (args[0] !== 'osascript' || args[1] !== '-e') return unexpectedArgs(args);
      const script = args[2] ?? '';
      if (script.includes('get dark mode')) return 'true';
      if (script.includes('set dark mode to false')) return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(MACOS_TEST_DEVICE, 'appearance', 'toggle');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.some((line) => line.includes('get dark mode')),
        true,
        flat.join('; '),
      );
      assert.equal(
        flat.some((line) => line.includes('set dark mode to false')),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission grant accessibility uses macOS helper', async () => {
  await withMockedMacOsHelper(
    [
      '#!/bin/sh',
      String.raw`printf "%s\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"`,
      "cat <<'JSON'",
      '{"ok":true,"data":{"target":"accessibility","action":"grant","granted":true,"requested":true,"openedSettings":false}}',
      'JSON',
      '',
    ].join('\n'),
    async ({ tmpDir }) => {
      const argsLogPath = path.join(tmpDir, 'args.log');
      const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

      try {
        const result = await setIosSetting(MACOS_TEST_DEVICE, 'permission', 'grant', undefined, {
          permissionTarget: 'accessibility',
        });
        const logged = await fs.readFile(argsLogPath, 'utf8');
        assert.equal(logged, 'permission\ngrant\naccessibility\n');
        assert.deepEqual(result, {
          action: 'grant',
          granted: true,
          openedSettings: false,
          requested: true,
          target: 'accessibility',
        });
      } finally {
        if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
        else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
      }
    },
    { tempPrefix: 'agent-device-macos-permission-grant-test-' },
  );
});

test('setIosSetting rejects unsupported macOS permission deny action', async () => {
  await assertRejectsAppError(
    () =>
      setIosSetting(MACOS_TEST_DEVICE, 'permission', 'deny', undefined, {
        permissionTarget: 'accessibility',
      }),
    { code: 'INVALID_ARGS', message: /Unsupported macOS setting: permission/i },
  );
});

test('setIosSetting rejects unsupported macOS wifi setting with explicit subset guidance', async () => {
  await assert.rejects(
    () => setIosSetting(MACOS_TEST_DEVICE, 'wifi', 'on'),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /Unsupported macOS setting: wifi/i);
      assert.match(
        (error as AppError).message,
        /wifi\|airplane\|location\|animations\|text-size remain unsupported on macOS/i,
      );
      return true;
    },
  );
});

test('setIosSetting location set sends simulator latitude and longitude', async () => {
  mockEnsureBootedSimulator.mockResolvedValue(undefined);

  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'location', 'set', undefined, {
        latitude: 37.3349,
        longitude: -122.009,
      });
      assert.deepEqual(calls, [['simctl', 'location', 'sim-1', 'set', '37.3349,-122.009']]);
    },
  );
});

test('setIosSetting appearance toggle flips current simulator appearance', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl ui sim-1 appearance') return 'dark';
      if (args.join(' ') === 'simctl ui sim-1 appearance light') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'appearance', 'toggle');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl ui sim-1 appearance'), true, flat.join('; '));
      assert.equal(flat.includes('simctl ui sim-1 appearance light'), true, flat.join('; '));
    },
  );
});

test('setIosSetting appearance toggle rejects unsupported current appearance output', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl ui sim-1 appearance') return 'unsupported';
      return '';
    },
    async () => {
      await assertRejectsAppError(() => setIosSetting(IOS_TEST_SIMULATOR, 'appearance', 'toggle'), {
        code: 'COMMAND_FAILED',
        message: /Unable to determine current iOS appearance/,
      });
    },
  );
});

test('setIosSetting permission grant calendar uses simctl privacy calendar target', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl privacy sim-1 grant calendar com.example.app') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'calendar',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.includes('simctl privacy sim-1 grant calendar com.example.app'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission grant all passes all through as one simctl call', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl privacy sim-1 grant all com.example.app') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'all',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.deepEqual(
        flat.filter((line) => line.includes('privacy sim-1')),
        ['simctl privacy sim-1 grant all com.example.app'],
      );
    },
  );
});

test('setIosSetting clear-app-state wipes iOS simulator app data container', async () => {
  const containerPath = await mkdtempForTest('agent-device-ios-clear-app-state-container-');
  await fs.mkdir(path.join(containerPath, 'Documents'), { recursive: true });
  await fs.writeFile(path.join(containerPath, 'Documents', 'db.sqlite'), 'db');
  await fs.writeFile(path.join(containerPath, 'Library.plist'), 'prefs');

  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl terminate sim-1 com.example.app') return '';
      if (args.join(' ') === 'simctl get_app_container sim-1 com.example.app data') {
        return `${containerPath}\n`;
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      const result = await setIosSetting(
        IOS_TEST_SIMULATOR,
        'clear-app-state',
        'clear',
        'com.example.app',
      );
      assert.equal(result?.cleared, true);
      assert.equal(result?.bundleId, 'com.example.app');
      assert.deepEqual(await fs.readdir(containerPath), []);

      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl terminate sim-1 com.example.app'), true, flat.join('; '));
      assert.equal(
        flat.includes('simctl get_app_container sim-1 com.example.app data'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting reset-keychain resets the whole simulator keychain', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl keychain sim-1 reset') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      const result = await setIosSetting(IOS_TEST_SIMULATOR, 'reset-keychain', 'clear');
      assert.equal(result?.cleared, true);
      assert.equal(result?.scope, 'simulator');

      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl keychain sim-1 reset'), true, flat.join('; '));
    },
  );
});

test('setIosSetting reset-keychain rejects unsupported state', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      return unexpectedArgs(args);
    },
    async () => {
      await assertRejectsAppError(
        () => setIosSetting(IOS_TEST_SIMULATOR, 'reset-keychain', 'nope'),
        {
          code: 'INVALID_ARGS',
          message: /reset-keychain only supports clear/,
        },
      );
    },
  );
});

test('setIosSetting permission grant photos limited maps to photos-add', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl privacy sim-1 grant photos-add com.example.app') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'photos',
        permissionMode: 'limited',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.includes('simctl privacy sim-1 grant photos-add com.example.app'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission rejects mode for non-photos target', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      return unexpectedArgs(args);
    },
    async () => {
      await assertRejectsAppError(
        () =>
          setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'grant', 'com.example.app', {
            permissionTarget: 'camera',
            permissionMode: 'limited',
          }),
        { code: 'INVALID_ARGS', message: /mode is only supported for photos/i },
      );
    },
  );
});

test('setIosSetting permission reset notifications fails targeted when direct reset is blocked', async () => {
  // A blocked notifications reset must not fall back to `reset all`: a
  // notifications-only reset would clear microphone, location, and other
  // grants. The targeted reset fails instead, leaving the earlier grant in place.
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl privacy sim-1 grant microphone com.example.app') return '';
      if (args.join(' ') === 'simctl privacy sim-1 reset notifications com.example.app') {
        return { stderr: 'Failed to reset access\nOperation not permitted', exitCode: 1 };
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'microphone',
      });
      await assertRejectsAppError(
        () =>
          setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'reset', 'com.example.app', {
            permissionTarget: 'notifications',
          }),
        {
          code: 'UNSUPPORTED_OPERATION',
          message: /does not support resetting notifications permission/i,
        },
      );
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.includes('simctl privacy sim-1 reset notifications com.example.app'),
        true,
        flat.join('; '),
      );
      assert.equal(
        flat.some((line) => line.includes('reset all com.example.app')),
        false,
        flat.join('; '),
      );
      assert.equal(
        flat.includes('simctl privacy sim-1 grant microphone com.example.app'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission grant camera needs no capability probe', async () => {
  // Xcode 26 omits `camera` from `simctl privacy help` while still changing it, so a
  // help-derived gate refused a service every runtime here serves. The privacy call is
  // itself the probe, so nothing else may be issued for a grant.
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl privacy sim-1 grant camera com.example.app') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'camera',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.includes('simctl privacy sim-1 grant camera com.example.app'),
        true,
        flat.join('; '),
      );
      assert.equal(
        flat.some((line) => line.includes('privacy help')),
        false,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission deny notifications returns unsupported on runtimes that block it', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl privacy sim-1 revoke notifications com.example.app') {
        return { stderr: 'Failed to revoke access\nOperation not permitted', exitCode: 1 };
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await assertRejectsAppError(
        () =>
          setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'deny', 'com.example.app', {
            permissionTarget: 'notifications',
          }),
        {
          code: 'UNSUPPORTED_OPERATION',
          message: /does not support setting notifications permission/i,
        },
      );
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.includes('simctl privacy sim-1 revoke notifications com.example.app'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission reports a runtime-refused service as unsupported', async () => {
  // A service the runtime cannot change answers EPERM, and Xcode 26 words grant/revoke
  // failures as "Failed to set access" — not "failed to grant access" — for both a real
  // service it withheld and a name it does not know at all.
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl privacy sim-1 grant calendar com.example.app') {
        return { stderr: 'Failed to set access\nOperation not permitted', exitCode: 1 };
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await assertRejectsAppError(
        () =>
          setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'grant', 'com.example.app', {
            permissionTarget: 'calendar',
          }),
        {
          code: 'UNSUPPORTED_OPERATION',
          message: /does not support setting calendar permission/i,
        },
      );
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.some((line) => line.includes('privacy help')),
        false,
        flat.join('; '),
      );
    },
  );
});
