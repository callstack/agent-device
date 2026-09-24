import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { XCRUN_TOOL_NAMES, type XcrunToolName } from '../../core/tool-provider.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { acquireXcodebuildSimulatorSetRedirect } from '../runner-device-set.ts';
import { RUNNER_ERROR_RULES } from '../runner-error-classification.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { RUNNER_STARTUP_FAILURE_FIXTURES } from './runner-startup-failure-fixtures.ts';
import {
  fakeFrameworkInfoPlistPath,
  hookedShimText,
  withFakeXcrunHost,
  writeFakeXcrunShims,
  type FakeXcrunHost,
  type FakeXcrunShim,
} from './xcrun-shim-fixtures.ts';

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

/** simctl and devicectl as given; the two Mach-O tools as Xcode 26.2 ships them, with no hook. */
function writeShims(
  layout: Layout,
  shims: { simctl?: FakeXcrunShim; devicectl?: FakeXcrunShim },
): FakeXcrunHost {
  return writeFakeXcrunShims(layout.root, {
    ...shims,
    xcdevice: { hook: 'none' },
    xctrace: { hook: 'none' },
  });
}

async function acquire(layout: Layout, host: FakeXcrunHost) {
  return await withFakeXcrunHost(host, () =>
    acquireXcodebuildSimulatorSetRedirect(scopedSimulator(layout.requestedSetPath), {
      xctestDeviceSetPath: layout.xctestDeviceSetPath,
      backupPath: layout.backupPath,
      lockDirPath: layout.lockDirPath,
      xcrunShimPaths: host.xcrunShimPaths,
    }),
  );
}

async function assertRefused(layout: Layout, host: FakeXcrunHost): Promise<AppError> {
  let refusal: AppError | undefined;
  await assert.rejects(acquire(layout, host), (error: unknown) => {
    assert.ok(error instanceof AppError);
    refusal = error;
    return true;
  });
  assert.ok(refusal);
  assert.equal(refusal.code, 'COMMAND_FAILED');
  assert.equal(refusal.details?.reason, REASON);
  assert.equal(refusal.details?.hint, ROW_HINT);
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

function shimOf(refusal: AppError, tool: XcrunToolName): Record<string, unknown> | undefined {
  return shimsOf(refusal).find((shim) => shim.tool === tool);
}

const SIMCTL_EQUAL = { expectedVersion: '1155.4', installedVersion: '1155.4' };
const DEVICECTL_EQUAL = { expectedVersion: '629.3', installedVersion: '629.3' };

test('an armed simctl shim refuses the redirect', async () => {
  const layout = makeLayout();
  const host = writeShims(layout, {
    simctl: { expectedVersion: '1051.17.7', installedVersion: '1155.4' },
    devicectl: { hook: 'none' },
  });

  const refusal = await assertRefused(layout, host);

  assert.deepEqual(shimOf(refusal, 'simctl'), {
    tool: 'simctl',
    shimPath: host.xcrunShimPaths.simctl,
    hook: 'armed',
    expectedVersion: '1051.17.7',
    frameworkInfoPlistPath: fakeFrameworkInfoPlistPath(layout.root, 'simctl'),
    installedVersion: '1155.4',
  });
});

test('an armed devicectl shim refuses the redirect even when simctl matches', async () => {
  const layout = makeLayout();
  const host = writeShims(layout, {
    simctl: SIMCTL_EQUAL,
    devicectl: { expectedVersion: '506.6', installedVersion: '629.3' },
  });

  const refusal = await assertRefused(layout, host);

  assert.equal(shimOf(refusal, 'simctl')?.hook, 'disarmed');
  assert.equal(shimOf(refusal, 'devicectl')?.hook, 'armed');
  assert.deepEqual(
    shimsOf(refusal).map((shim) => shim.tool),
    [...XCRUN_TOOL_NAMES],
  );
});

test('matching versions on both hooked shims let the redirect through', async () => {
  const layout = makeLayout();
  await assertRedirected(
    layout,
    writeShims(layout, { simctl: SIMCTL_EQUAL, devicectl: DEVICECTL_EQUAL }),
  );
});

for (const tool of ['simctl', 'devicectl'] as const) {
  const other = tool === 'simctl' ? { devicectl: DEVICECTL_EQUAL } : { simctl: SIMCTL_EQUAL };

  test(`a ${tool} shim without -runFirstLaunch has no hook to arm`, async () => {
    const layout = makeLayout();
    await assertRedirected(layout, writeShims(layout, { ...other, [tool]: { hook: 'none' } }));
  });

  // Each shape breaks one value and keeps the rest readable and equal, so the refusal is that value's.
  const unreadable: Record<
    string,
    { text: (plistPath: string) => string; plistReadable: boolean }
  > = {
    'no EXPECTED_VERSION': {
      text: (plistPath) =>
        hookedShimText('1', plistPath).replace('EXPECTED_VERSION="1"', 'EXPECTED_VERSION='),
      plistReadable: true,
    },
    'no Info.plist path on the CURRENT_VERSION line': {
      text: (plistPath) => hookedShimText('1', plistPath).replace(`"${plistPath}"`, '"$PLIST"'),
      plistReadable: true,
    },
    'an unreadable framework Info.plist': {
      text: (plistPath) => hookedShimText('1', plistPath),
      plistReadable: false,
    },
  };
  for (const [shape, { text, plistReadable }] of Object.entries(unreadable)) {
    test(`a hooked ${tool} shim with ${shape} fails closed`, async () => {
      const layout = makeLayout();
      const plistPath = fakeFrameworkInfoPlistPath(layout.root, tool);
      const host = writeShims(layout, { ...other, [tool]: { text: text(plistPath) } });
      if (plistReadable) host.installedVersions.set(plistPath, '1');

      const refusal = await assertRefused(layout, host);

      assert.equal(shimOf(refusal, tool)?.hook, 'armed');
    });
  }

  test(`a ${tool} that xcrun cannot locate refuses the redirect`, async () => {
    const layout = makeLayout();
    const host = writeShims(layout, other);

    const refusal = await assertRefused(layout, host);

    assert.deepEqual(shimOf(refusal, tool), {
      tool,
      shimPath: null,
      hook: 'armed',
      expectedVersion: null,
      frameworkInfoPlistPath: null,
      installedVersion: null,
    });
  });
}

test('the framework Info.plist is the one the shim text names', async () => {
  const layout = makeLayout();
  const otherPlist = path.join(layout.root, 'Other.framework', 'Info.plist');
  const host = writeShims(layout, {
    simctl: { text: hookedShimText('1155.4', otherPlist) },
    devicectl: { hook: 'none' },
  });
  host.installedVersions.set(otherPlist, '1155.4');

  await assertRedirected(layout, host);

  assert.deepEqual(host.plistReads, [otherPlist]);
});

test('the captured Xcode 26.2 simctl shim reads as armed against CoreSimulator 1155.4', async () => {
  const captured = RUNNER_STARTUP_FAILURE_FIXTURES.find(
    (fixture) => fixture.id === 'xcode-26-2-simctl-shim-first-launch',
  );
  assert.ok(captured);
  const layout = makeLayout();
  const host = writeShims(layout, {
    simctl: { text: `#!/bin/bash\n${captured.output}fi\n` },
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

test('the hint stays the row hint while the message and details carry the versions', async () => {
  for (const [expectedVersion, installedVersion] of [
    ['506.6', '629.3'],
    ['507.1', '700.2'],
  ] as const) {
    const layout = makeLayout();
    const refusal = await assertRefused(
      layout,
      writeShims(layout, {
        simctl: SIMCTL_EQUAL,
        devicectl: { expectedVersion, installedVersion },
      }),
    );

    assert.ok(ROW_HINT);
    assert.match(
      refusal.message,
      new RegExp(
        `Xcode's devicectl expects CoreDevice ${expectedVersion}; installed ${installedVersion}`,
      ),
    );
    assert.equal(shimOf(refusal, 'devicectl')?.installedVersion, installedVersion);
  }
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
