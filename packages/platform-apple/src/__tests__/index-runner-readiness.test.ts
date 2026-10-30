import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import {
  bindTestCommandHost,
  createLiveTestHostEnvironment,
  IOS_DEVICE,
  mkdtempForTestSync,
  stubbedAppleDeveloperDir,
} from '@agent-device/test-kit';
import { prewarmIosRunnerSession } from '../core/runner-client.ts';
import { appleRunnerHost } from '../core/runner-host.ts';
import { IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT } from '../core/devicectl.ts';
import { setAppleRunnerHostEnvironment } from '../core/runner-owner-state.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../core/tool-provider.ts';

// The runner's startup readiness, composed: the real core binder binds the real host, the Apple tool
// provider answers `devicectl device info details` and `DevToolsSecurity`, Apple's physical-device
// control converts the payload into the device's readiness report, and the runner's startup publishes
// the verdict on the failure. Only process spawning below the host is scripted. The package suites
// pin the runner half against supplied reports; this file pins that the halves meet.

bindTestCommandHost();

beforeEach(() => {
  const root = mkdtempForTestSync('apple-runner-readiness-');
  vi.stubEnv('DEVELOPER_DIR', stubbedAppleDeveloperDir());
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH', path.join(root, 'derived'));
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', path.join(root, 'leases'));
  setAppleRunnerHostEnvironment(createLiveTestHostEnvironment());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** `devicectl device info details` for a phone that is awake, connected, and reporting both states. */
function deviceDetailsPayload(
  developerModeStatus: 'enabled' | 'disabled',
  ddiServicesAvailable: boolean,
): string {
  return JSON.stringify({
    info: { outcome: 'success' },
    result: {
      deviceProperties: { developerModeStatus, ddiServicesAvailable, bootState: 'booted' },
      connectionProperties: { tunnelState: 'connected' },
    },
  });
}

/** Where `devicectl ... --json-output <path>` is told to put its payload. */
function jsonOutputPathOf(args: readonly string[]): string | undefined {
  const index = args.indexOf('--json-output');
  return index >= 0 ? args[index + 1] : undefined;
}

type Scripted = Readonly<{
  devicectlPayload: string;
  devToolsSecurity?: string;
  /** A prepared `.xctestrun` the runner reuses without building, as a warm cache does. */
  warmXctestrun?: string;
}>;

/**
 * Starts a runner session for `device` the way a prewarm does, with the Apple tools scripted as
 * `scripted` says and the host's `xcodebuild` failing as `buildFailure` says, and returns the failure.
 */
async function startupFailure(
  device: typeof IOS_DEVICE,
  scripted: Scripted,
  buildFailure = "error: cannot find 'AgentDeviceRunnerCommand' in scope\n",
): Promise<AppError> {
  const provider = createLocalAppleToolProvider({
    runCommand: async (cmd: string, args: string[]) => {
      if (cmd === 'DevToolsSecurity' && args[0] === '-status') {
        return {
          exitCode: 0,
          stdout: scripted.devToolsSecurity ?? 'Developer mode is currently enabled.\n',
          stderr: '',
        };
      }
      if (cmd === 'plutil') {
        return {
          exitCode: 0,
          stdout: args[1] === 'json' ? '{}' : '<plist><dict/></plist>',
          stderr: '',
        };
      }
      const outputPath = jsonOutputPathOf(args);
      if (outputPath) fs.writeFileSync(outputPath, scripted.devicectlPayload);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  let caught: unknown;
  const launch = vi.spyOn(appleRunnerHost, 'runCmdBackground').mockImplementation(() => {
    throw new AppError('COMMAND_FAILED', 'scripted launch failure');
  });
  await withCommandExecutorOverride(
    async (command, args) => {
      if (command === 'xcodebuild' && args[0] === 'test-without-building') {
        throw new AppError(
          'COMMAND_FAILED',
          'xcodebuild test-without-building exited unexpectedly',
        );
      }
      if (command === 'xcodebuild') {
        throw new AppError('COMMAND_FAILED', 'xcodebuild build-for-testing failed', {
          exitCode: 65,
          stdout: buildFailure,
          stderr: '',
        });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    () =>
      withAppleToolProvider(provider, async () => {
        await assert.rejects(
          () =>
            prewarmIosRunnerSession(device, {
              propagateError: true,
              healthCheck: false,
              iosXctestrunFile: scripted.warmXctestrun,
            })!,
          (error: unknown) => {
            caught = error;
            return true;
          },
        );
      }),
  );
  assert.ok(caught instanceof AppError, 'startup must fail with an AppError');
  if (scripted.warmXctestrun) {
    assert.equal(launch.mock.calls.length, 1);
    assert.equal(launch.mock.calls[0]?.[0], 'xcodebuild');
    assert.equal(launch.mock.calls[0]?.[1][0], 'test-without-building');
  }
  return caught;
}

/**
 * The two startup probes answer different questions about different machines, and the order they run
 * in is a claim (#2683): the phone's answer is the one the caller can fix without admin rights on the
 * Mac, so the device is asked first and gets to speak.
 */
test('a device and a Mac that are both wrong publish the device reason', async () => {
  const device = { ...IOS_DEVICE, id: 'runner-readiness-probe-order-device' };

  const error = await startupFailure(device, {
    devicectlPayload: deviceDetailsPayload('disabled', false),
    devToolsSecurity: 'Developer mode is currently disabled.\n',
  });

  assert.equal(error.details?.reason, 'device_developer_mode_disabled');
});

test('a build that named no cause on a device with its image down gets the device answer', async () => {
  const device = { ...IOS_DEVICE, id: 'runner-readiness-image-down-build' };

  const error = await startupFailure(device, {
    devicectlPayload: deviceDetailsPayload('enabled', false),
  });

  assert.equal(error.details?.reason, 'device_developer_disk_image_unavailable');
  assert.equal(error.details?.developerDiskImage, 'unavailable');
  assert.ok(String(error.details?.hint).includes(IOS_DEVICE_DEVELOPER_DISK_IMAGE_HINT));
});

test('a device whose image is available claims nothing for a failure it did not cause', async () => {
  const device = { ...IOS_DEVICE, id: 'runner-readiness-image-available' };

  const error = await startupFailure(device, {
    devicectlPayload: deviceDetailsPayload('enabled', true),
  });

  assert.equal(error.details?.reason, 'build_failed_unclassified');
  assert.equal(error.details?.developerDiskImage, 'available');
});

test('a warm cache that fails at launch still carries what the device said', async () => {
  // The case the build-catch-only version missed: nothing had to compile, so the device's answer was
  // never attached anywhere, and an install that cannot start the runner said only "build failed".
  const device = { ...IOS_DEVICE, id: 'runner-readiness-image-down-launch' };
  const warmXctestrun = path.join(mkdtempForTestSync('apple-runner-warm-'), 'Runner.xctestrun');
  fs.writeFileSync(
    warmXctestrun,
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict></dict></plist>\n',
  );

  const error = await startupFailure(device, {
    devicectlPayload: deviceDetailsPayload('enabled', false),
    warmXctestrun,
  });

  assert.equal(error.details?.reason, 'device_developer_disk_image_unavailable');
  assert.equal(error.details?.developerDiskImage, 'unavailable');
});
