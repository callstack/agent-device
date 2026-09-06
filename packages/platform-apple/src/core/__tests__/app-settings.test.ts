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
import type { DeviceInfo } from '@agent-device/kernel/device';
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

test('setIosSetting faceid match uses simctl biometric match', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl biometric sim-1 match face') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'faceid', 'match');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl biometric sim-1 match face'), true, flat.join('; '));
    },
  );
});

test('setIosSetting faceid retries alternate biometric argument order', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl biometric sim-1 match face') return { exitCode: 2 };
      if (args.join(' ') === 'simctl biometric match sim-1 face') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'faceid', 'match');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl biometric sim-1 match face'), true, flat.join('; '));
      assert.equal(flat.includes('simctl biometric match sim-1 face'), true, flat.join('; '));
    },
  );
});

test('setIosSetting touchid match uses simctl biometric match finger', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl biometric sim-1 match finger') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'touchid', 'match');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl biometric sim-1 match finger'), true, flat.join('; '));
    },
  );
});

test('setIosSetting touchid retries touch modality when finger fails', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl biometric sim-1 match finger') return { exitCode: 2 };
      if (args.join(' ') === 'simctl biometric match sim-1 finger') return { exitCode: 2 };
      if (args.join(' ') === 'simctl biometric sim-1 match touch') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'touchid', 'match');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl biometric sim-1 match finger'), true, flat.join('; '));
      assert.equal(flat.includes('simctl biometric match sim-1 finger'), true, flat.join('; '));
      assert.equal(flat.includes('simctl biometric sim-1 match touch'), true, flat.join('; '));
    },
  );
});

test('setIosSetting touchid reports unsupported when simctl biometric is unavailable', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      return { stderr: 'unknown subcommand biometric', exitCode: 1 };
    },
    async () => {
      await assertRejectsAppError(() => setIosSetting(IOS_TEST_SIMULATOR, 'touchid', 'match'), {
        code: 'UNSUPPORTED_OPERATION',
        message: /Touch ID simulation is not supported/,
      });
    },
  );
});

test('setIosSetting touchid keeps COMMAND_FAILED for operational failures', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      return { stderr: 'Failed to boot simulator service', exitCode: 1 };
    },
    async () => {
      await assertRejectsAppError(() => setIosSetting(IOS_TEST_SIMULATOR, 'touchid', 'match'), {
        code: 'COMMAND_FAILED',
        message: /Failed to simulate touchid/,
      });
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
        /wifi\|airplane\|location\|animations remain unsupported on macOS/i,
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
      // simctl privacy help falls through to the fake's canned service listing.
      if (args[0] === 'simctl' && args[1] === 'privacy' && args[2] === 'help') return undefined;
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
      if (args[0] === 'simctl' && args[1] === 'privacy' && args[2] === 'help') return undefined;
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

test('setIosSetting permission reset notifications falls back to reset all when direct reset is blocked', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args[0] === 'simctl' && args[1] === 'privacy' && args[2] === 'help') return undefined;
      if (args.join(' ') === 'simctl privacy sim-1 reset notifications com.example.app') {
        return { stderr: 'Failed to reset access\nOperation not permitted', exitCode: 1 };
      }
      if (args.join(' ') === 'simctl privacy sim-1 reset all com.example.app') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.includes('simctl privacy sim-1 reset notifications com.example.app'),
        true,
        flat.join('; '),
      );
      assert.equal(
        flat.includes('simctl privacy sim-1 reset all com.example.app'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission reset notifications falls back to reset all when unlisted in privacy help', async () => {
  // Runtimes like iOS 26.3 omit notifications from `simctl privacy help`, yet
  // direct reset fails only with "operation not permitted" while `reset all`
  // succeeds — so reset bypasses the probe gate into the existing fallback.
  const device: DeviceInfo = {
    ...IOS_TEST_SIMULATOR,
    simulatorSetPath: '/fake/privacy-help-no-notifications',
  };
  const HELP_WITHOUT_NOTIFICATIONS = `Usage: simctl privacy <device> <action> <service> [<bundle identifier>]

        service
             The service:
                 microphone - Allow access to audio input.`;
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.includes('help')) return HELP_WITHOUT_NOTIFICATIONS;
      const flat = args.join(' ');
      if (flat.includes('reset notifications com.example.app')) {
        return { stderr: 'Failed to reset access\nOperation not permitted', exitCode: 1 };
      }
      if (flat.includes('reset all com.example.app')) return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.some((line) => line.includes('reset all com.example.app')),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission deny notifications returns unsupported on runtimes that block it', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args[0] === 'simctl' && args[1] === 'privacy' && args[2] === 'help') return undefined;
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

test('setIosSetting permission rejects service missing from simctl privacy help', async () => {
  // A distinct simulator set path busts the module-level privacy-services
  // cache, whose key is `PATH + set path` — the PATH half no longer varies
  // now that no PATH stubbing happens, so the set path must.
  const device: DeviceInfo = { ...IOS_TEST_SIMULATOR, simulatorSetPath: '/fake/privacy-help-set' };
  const CUSTOM_PRIVACY_HELP = `Usage: simctl privacy <device> <action> <service> [<bundle identifier>]

        service
             The service:
                 camera - Allow access to camera.
                 microphone - Allow access to audio input.`;

  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args[0] === 'simctl' && args.includes('privacy') && args.includes('help')) {
        return CUSTOM_PRIVACY_HELP;
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await assertRejectsAppError(
        () =>
          setIosSetting(device, 'permission', 'grant', 'com.example.app', {
            permissionTarget: 'calendar',
          }),
        { code: 'UNSUPPORTED_OPERATION', message: /does not support service "calendar"/i },
      );
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.some((line) => line.includes('privacy help')),
        true,
        flat.join('; '),
      );
      assert.equal(
        flat.some((line) => line.includes('grant calendar')),
        false,
        flat.join('; '),
      );
    },
  );
});
