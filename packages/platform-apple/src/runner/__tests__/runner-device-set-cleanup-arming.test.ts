import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  XCRUN_SHIM_TOOL_NAMES,
  type ArmedXcrunShimFirstLaunchHook,
  type XcrunShimToolName,
} from '../../core/xcrun-shim-first-launch.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { acquireXcodebuildSimulatorSetRedirect } from '../runner-device-set.ts';
import { RUNNER_ERROR_RULES } from '../runner-error-classification.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { RUNNER_STARTUP_FAILURE_FIXTURES } from './runner-startup-failure-fixtures.ts';
import {
  fakeFrameworkInfoPlistPath,
  withFakeXcrunHost,
  writeFakeXcrunShims,
  type FakeXcrunHost,
} from '../../core/__tests__/xcrun-shim-fixtures.ts';

// #2935: pointing `XCTestDevices` at a user's simulator set while an Xcode shim would run
// `xcodebuild -runFirstLaunch` lets that cleanup delete every device in the user's set. These cases
// drive the real probe over fake shims and a fake plist reader.

const REASON = 'xctest_device_set_cleanup_armed';

const ROW_HINT = RUNNER_ERROR_RULES.find((rule) => rule.buildFailure?.reason === REASON)
  ?.buildFailure?.hint;

type Layout = {
  root: string;
  requestedSetPath: string;
  xctestDeviceSetPath: string;
  backupPath: string;
  lockDirPath: string;
};

function makeLayout(): Layout {
  const root = mkdtempForTestSync('device-set-cleanup-arming-');
  const layout = {
    root,
    requestedSetPath: path.join(root, 'requested'),
    xctestDeviceSetPath: path.join(root, 'Library', 'Developer', 'XCTestDevices'),
    backupPath: path.join(root, 'Library', 'Developer', 'XCTestDevices.set-aside'),
    lockDirPath: path.join(root, '.agent-device', 'xctest-device-set.lock'),
  };
  fs.mkdirSync(layout.requestedSetPath, { recursive: true });
  fs.mkdirSync(layout.xctestDeviceSetPath, { recursive: true });
  fs.writeFileSync(path.join(layout.xctestDeviceSetPath, 'host-device.txt'), 'the host owns this');
  return layout;
}

function scopedSimulator(setPath: string): DeviceInfo {
  return {
    platform: 'apple',
    id: 'sim-scoped',
    name: 'iPhone Simulator',
    kind: 'simulator',
    appleOs: 'ios',
    booted: true,
    simulatorSetPath: setPath,
  };
}

async function acquire(layout: Layout, host: FakeXcrunHost, signal?: AbortSignal) {
  return await withFakeXcrunHost(host, () =>
    acquireXcodebuildSimulatorSetRedirect(scopedSimulator(layout.requestedSetPath), {
      xctestDeviceSetPath: layout.xctestDeviceSetPath,
      backupPath: layout.backupPath,
      lockDirPath: layout.lockDirPath,
      signal,
    }),
  );
}

async function assertRefused(
  layout: Layout,
  host: FakeXcrunHost,
  signal?: AbortSignal,
): Promise<AppError> {
  let refusal: AppError | undefined;
  await assert.rejects(acquire(layout, host, signal), (error: unknown) => {
    assert.ok(error instanceof AppError);
    refusal = error;
    return true;
  });
  assert.ok(refusal);
  assert.equal(refusal.code, 'COMMAND_FAILED');
  if (signal?.aborted) {
    assert.equal(isRequestCanceledError(refusal), true);
  } else {
    assert.equal(refusal.details?.reason, REASON);
    assert.equal(refusal.details?.hint, ROW_HINT);
  }
  assert.equal(fs.lstatSync(layout.xctestDeviceSetPath).isSymbolicLink(), false);
  assert.equal(
    fs.readFileSync(path.join(layout.xctestDeviceSetPath, 'host-device.txt'), 'utf8'),
    'the host owns this',
  );
  assert.equal(fs.existsSync(layout.backupPath), false, 'nothing was renamed aside');
  assert.equal(fs.existsSync(layout.lockDirPath), false, 'the lock was given back');
  return refusal;
}

async function assertRedirected(layout: Layout, host: FakeXcrunHost): Promise<void> {
  const handle = await acquire(layout, host);
  try {
    assert.notEqual(handle, null);
    assert.equal(fs.lstatSync(layout.xctestDeviceSetPath).isSymbolicLink(), true);
    assert.equal(
      fs.realpathSync.native(layout.xctestDeviceSetPath),
      fs.realpathSync.native(layout.requestedSetPath),
    );
  } finally {
    await handle?.release();
  }
}

function shimsOf(refusal: AppError): Array<Record<string, unknown>> {
  const shims = refusal.details?.xcrunShims;
  assert.ok(Array.isArray(shims));
  return shims as Array<Record<string, unknown>>;
}

function shimOf(refusal: AppError, tool: XcrunShimToolName): Record<string, unknown> | undefined {
  return shimsOf(refusal).find((shim) => shim.tool === tool);
}

const SIMCTL_EQUAL = { expectedVersion: '1155.4', installedVersion: '1155.4' };
const DEVICECTL_EQUAL = { expectedVersion: '629.3', installedVersion: '629.3' };

test('an armed simctl shim refuses the redirect', async () => {
  const layout = makeLayout();
  const host = writeFakeXcrunShims(layout.root, {
    simctl: { expectedVersion: '1051.17.7', installedVersion: '1155.4' },
    devicectl: { hook: 'none' },
  });

  const refusal = await assertRefused(layout, host);

  assert.deepEqual(shimOf(refusal, 'simctl'), {
    tool: 'simctl',
    shimPath: host.xcrunShimPaths.simctl,
    hook: 'armed',
    armedBy: 'version_mismatch',
    expectedVersion: '1051.17.7',
    frameworkInfoPlistPath: fakeFrameworkInfoPlistPath(layout.root, 'simctl'),
    installedVersion: '1155.4',
  });
});

test('an armed devicectl shim refuses the redirect even when simctl matches', async () => {
  const layout = makeLayout();
  const host = writeFakeXcrunShims(layout.root, {
    simctl: SIMCTL_EQUAL,
    devicectl: { expectedVersion: '506.6', installedVersion: '629.3' },
  });

  const refusal = await assertRefused(layout, host);

  assert.deepEqual(
    shimsOf(refusal).map((shim) => [shim.tool, shim.hook]),
    [
      ['simctl', 'disarmed'],
      ['devicectl', 'armed'],
    ],
  );
  assert.match(refusal.message, /Xcode's devicectl expects CoreDevice 506\.6; installed 629\.3/);
});

test('an unreadable framework Info.plist fails closed at the gate', async () => {
  const layout = makeLayout();
  const host = writeFakeXcrunShims(layout.root, {
    simctl: SIMCTL_EQUAL,
    devicectl: DEVICECTL_EQUAL,
  });
  host.installedVersions.delete(fakeFrameworkInfoPlistPath(layout.root, 'devicectl'));

  const refusal = await assertRefused(layout, host);

  assert.equal(shimOf(refusal, 'devicectl')?.armedBy, 'version_unreadable');
  assert.match(
    refusal.message,
    /Xcode's devicectl expects CoreDevice 629\.3; installed \(unreadable\)/,
  );
});

test('matching or hookless shims let the redirect through', async () => {
  for (const shims of [
    { simctl: SIMCTL_EQUAL, devicectl: DEVICECTL_EQUAL },
    { simctl: { hook: 'none' }, devicectl: { hook: 'none' } },
  ] as const) {
    const layout = makeLayout();
    await assertRedirected(layout, writeFakeXcrunShims(layout.root, shims));
  }
});

test('the captured Xcode 26.2 simctl shim reads as armed against CoreSimulator 1155.4', async () => {
  const captured = RUNNER_STARTUP_FAILURE_FIXTURES.find(
    (fixture) => fixture.id === 'xcode-26-2-simctl-shim-first-launch',
  );
  assert.ok(captured);
  const layout = makeLayout();
  const host = writeFakeXcrunShims(layout.root, {
    simctl: { text: captured.output },
    devicectl: DEVICECTL_EQUAL,
  });
  const coreSimulatorPlist =
    '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist';
  host.installedVersions.set(coreSimulatorPlist, '1155.4');

  const refusal = await assertRefused(layout, host);

  assert.equal(captured.reason, refusal.details?.reason);
  assert.match(
    refusal.message,
    /Xcode's simctl expects CoreSimulator 1051\.17\.7; installed 1155\.4/,
  );
  assert.ok(host.plistReads.includes(coreSimulatorPlist));
});

test('a simulator that needs no redirect never probes the shims', async () => {
  const probe = vi.fn();
  appleRunnerTestHost.update({ probeXcrunShimFirstLaunchHooks: probe });
  const layout = makeLayout();

  const defaultSet = await acquireXcodebuildSimulatorSetRedirect(
    { ...scopedSimulator(layout.requestedSetPath), simulatorSetPath: undefined },
    { lockDirPath: layout.lockDirPath, xctestDeviceSetPath: layout.xctestDeviceSetPath },
  );
  const xctestSet = await acquireXcodebuildSimulatorSetRedirect(
    scopedSimulator(layout.xctestDeviceSetPath),
    { lockDirPath: layout.lockDirPath, xctestDeviceSetPath: layout.xctestDeviceSetPath },
  );

  assert.equal(defaultSet, null);
  assert.equal(xctestSet, null);
  assert.equal(probe.mock.calls.length, 0);
});

test('a request canceled during the probe gives the lock back as a cancellation, not a refusal', async () => {
  const layout = makeLayout();
  const host = writeFakeXcrunShims(layout.root, {
    simctl: SIMCTL_EQUAL,
    devicectl: DEVICECTL_EQUAL,
  });

  await assertRefused(layout, host, AbortSignal.abort());

  assert.deepEqual(host.plistReads, []);
});

test('the message tells a shim xcrun could not locate from one the probe ran out of budget on', async () => {
  const messages: string[] = [];
  for (const armedBy of ['shim_not_located', 'probe_out_of_budget'] as const) {
    const layout = makeLayout();
    const host = writeFakeXcrunShims(layout.root, {});
    if (armedBy === 'probe_out_of_budget') {
      appleRunnerTestHost.update({
        probeXcrunShimFirstLaunchHooks: async () =>
          XCRUN_SHIM_TOOL_NAMES.map((tool): ArmedXcrunShimFirstLaunchHook => ({
            tool,
            shimPath: null,
            hook: 'armed',
            armedBy,
            expectedVersion: null,
            frameworkInfoPlistPath: null,
            installedVersion: null,
          })),
      });
    }
    const refusal = await assertRefused(layout, host);
    assert.deepEqual(
      shimsOf(refusal).map((shim) => [shim.tool, shim.armedBy]),
      XCRUN_SHIM_TOOL_NAMES.map((tool) => [tool, armedBy]),
    );
    messages.push(refusal.message);
  }

  assert.match(messages[0] ?? '', /Xcode's simctl could not be located/);
  assert.match(messages[1] ?? '', /Xcode's simctl shim was not read within the probe budget/);
});

test('a restore that could not give the host set back outranks the shim refusal', async () => {
  const layout = makeLayout();
  const host = writeFakeXcrunShims(layout.root, {
    simctl: { expectedVersion: '1051.17.7', installedVersion: '1155.4' },
    devicectl: { hook: 'none' },
  });

  // Nothing is left to restore on the way in, so only the give-back's own reconcile can be made to
  // fail: force `XCTestDevices` to keep reading as an orphaned symlink, and let only the give-back's
  // unlink attempt refuse.
  const realLstatSync = fs.lstatSync.bind(fs);
  const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((
    target: fs.PathLike,
    options?: unknown,
  ) => {
    if (String(target) === layout.xctestDeviceSetPath) {
      return { isSymbolicLink: () => true } as fs.Stats;
    }
    return (realLstatSync as (p: fs.PathLike, o?: unknown) => fs.Stats)(target, options);
  }) as typeof fs.lstatSync);
  const realUnlinkSync = fs.unlinkSync.bind(fs);
  let unlinkAttempts = 0;
  const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(((target: fs.PathLike) => {
    if (String(target) !== layout.xctestDeviceSetPath) {
      realUnlinkSync(target);
      return;
    }
    unlinkAttempts += 1;
    if (unlinkAttempts > 1) {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
  }) as typeof fs.unlinkSync);

  try {
    await assert.rejects(
      acquire(layout, host),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES',
    );
    assert.equal(unlinkAttempts, 2, 'the redirect-in reconcile ran once, the give-back once more');
    assert.equal(fs.existsSync(layout.lockDirPath), false, 'the lock still went back');
  } finally {
    lstatSpy.mockRestore();
    unlinkSpy.mockRestore();
  }
});
