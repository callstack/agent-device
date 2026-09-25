import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { IOS_DEVICE, IOS_SIMULATOR, TVOS_SIMULATOR } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { STUBBED_APPLE_TOOLCHAIN, stubAppleToolchainProbes } from './apple-toolchain-fixtures.ts';
import {
  isSameRunnerSimulator,
  restoreLegacyXctestDeviceSetRedirect,
  runnerSimulatorSetFailureDetails,
  xcodebuildDestinationArgs,
} from '../runner-device-set.ts';

const toolchainProbe = stubAppleToolchainProbes();
beforeEach(resetAllProcessMemosForTests);
afterEach(() => {
  vi.restoreAllMocks();
});

const DESTINATION = 'platform=iOS Simulator,id=sim-1';

test('a scoped-set simulator names its set to xcodebuild beside the destination', () => {
  const device = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulators' };

  assert.deepEqual(xcodebuildDestinationArgs(device, DESTINATION), [
    '-destination',
    DESTINATION,
    '-DVTSimulatorSetLocation=/tmp/tenant-a/simulators',
  ]);
});

test('every Apple simulator family in a scoped set names its set', () => {
  const device = { ...TVOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulators' };

  assert.ok(
    xcodebuildDestinationArgs(device, DESTINATION).includes(
      '-DVTSimulatorSetLocation=/tmp/tenant-a/simulators',
    ),
  );
});

test('the default set, a blank set path and a physical device leave the destination alone', () => {
  for (const device of [
    IOS_SIMULATOR,
    { ...IOS_SIMULATOR, simulatorSetPath: '   ' },
    { ...IOS_DEVICE, simulatorSetPath: '/tmp/tenant-a/simulators' },
  ]) {
    assert.deepEqual(xcodebuildDestinationArgs(device, DESTINATION), ['-destination', DESTINATION]);
  }
});

test('a failure reports the scoped set and the selected Xcode only for a scoped-set simulator', () => {
  const scoped = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulators' };

  assert.deepEqual(runnerSimulatorSetFailureDetails(scoped), {
    simulatorSetPath: '/tmp/tenant-a/simulators',
    xcodeVersion: STUBBED_APPLE_TOOLCHAIN.xcodeVersion,
  });
  assert.deepEqual(runnerSimulatorSetFailureDetails(IOS_SIMULATOR), {});
});

test('a failure whose Xcode cannot be read still names the scoped set, and no Xcode key', () => {
  toolchainProbe.mockReturnValue({ exitCode: 1, stdout: '', stderr: 'xcode-select: error' });

  assert.deepEqual(
    runnerSimulatorSetFailureDetails({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/sims' }),
    { simulatorSetPath: '/tmp/tenant-a/sims' },
  );
});

test('one udid in two simulator sets names two simulators', () => {
  const tenantA = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulators' };

  assert.equal(isSameRunnerSimulator(tenantA, { ...tenantA }), true);
  assert.equal(
    isSameRunnerSimulator(IOS_SIMULATOR, { ...IOS_SIMULATOR, simulatorSetPath: ' ' }),
    true,
  );
  assert.equal(isSameRunnerSimulator(tenantA, IOS_SIMULATOR), false);
  assert.equal(
    isSameRunnerSimulator(tenantA, { ...tenantA, simulatorSetPath: '/tmp/tenant-b/simulators' }),
    false,
  );
});

type LegacyRedirect = {
  xctestDeviceSetPath: string;
  backupPath: string;
  scopedSetPath: string;
};

function makeLegacyPaths(): LegacyRedirect {
  const root = mkdtempForTestSync('agent-device-legacy-xctest-set-');
  const developer = path.join(root, 'Library', 'Developer');
  fs.mkdirSync(developer, { recursive: true });
  const scopedSetPath = path.join(root, 'tenant-set');
  fs.mkdirSync(path.join(scopedSetPath, 'SCOPED-UDID'), { recursive: true });
  return {
    xctestDeviceSetPath: path.join(developer, 'XCTestDevices'),
    backupPath: path.join(developer, 'XCTestDevices.agent-device-backup'),
    scopedSetPath,
  };
}

test('an older redirect is undone: the symlink goes and the host set comes back', () => {
  const paths = makeLegacyPaths();
  fs.mkdirSync(path.join(paths.backupPath, 'HOST-UDID'), { recursive: true });
  fs.symlinkSync(paths.scopedSetPath, paths.xctestDeviceSetPath, 'dir');

  restoreLegacyXctestDeviceSetRedirect(IOS_SIMULATOR, paths.xctestDeviceSetPath);

  assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isSymbolicLink(), false);
  assert.ok(fs.existsSync(path.join(paths.xctestDeviceSetPath, 'HOST-UDID')));
  assert.equal(fs.existsSync(paths.backupPath), false);
  // Unlinking never follows the link: the scoped set it pointed at keeps its devices.
  assert.ok(fs.existsSync(path.join(paths.scopedSetPath, 'SCOPED-UDID')));
});

test('a symlink an older redirect left into this scoped set without a backup is removed', () => {
  const paths = makeLegacyPaths();
  fs.symlinkSync(paths.scopedSetPath, paths.xctestDeviceSetPath, 'dir');

  restoreLegacyXctestDeviceSetRedirect(
    { ...IOS_SIMULATOR, simulatorSetPath: paths.scopedSetPath },
    paths.xctestDeviceSetPath,
  );

  assert.equal(fs.lstatSync(paths.xctestDeviceSetPath, { throwIfNoEntry: false }), undefined);
  assert.ok(fs.existsSync(path.join(paths.scopedSetPath, 'SCOPED-UDID')));
});

test('a host-owned XCTestDevices symlink with no backup survives a default-set startup', () => {
  const paths = makeLegacyPaths();
  fs.symlinkSync(paths.scopedSetPath, paths.xctestDeviceSetPath, 'dir');

  restoreLegacyXctestDeviceSetRedirect(IOS_SIMULATOR, paths.xctestDeviceSetPath);

  assert.equal(fs.readlinkSync(paths.xctestDeviceSetPath), paths.scopedSetPath);
});

test('a host-owned XCTestDevices symlink elsewhere survives a scoped-set startup', () => {
  const paths = makeLegacyPaths();
  const external = path.join(path.dirname(paths.scopedSetPath), 'external-volume');
  fs.mkdirSync(external);
  fs.symlinkSync(external, paths.xctestDeviceSetPath, 'dir');

  restoreLegacyXctestDeviceSetRedirect(
    { ...IOS_SIMULATOR, simulatorSetPath: paths.scopedSetPath },
    paths.xctestDeviceSetPath,
  );

  assert.equal(fs.readlinkSync(paths.xctestDeviceSetPath), external);
});

test('a backup never replaces a host set that is already in place', () => {
  const paths = makeLegacyPaths();
  fs.mkdirSync(path.join(paths.xctestDeviceSetPath, 'CURRENT-UDID'), { recursive: true });
  fs.mkdirSync(path.join(paths.backupPath, 'OLD-UDID'), { recursive: true });

  restoreLegacyXctestDeviceSetRedirect(IOS_SIMULATOR, paths.xctestDeviceSetPath);

  assert.ok(fs.existsSync(path.join(paths.xctestDeviceSetPath, 'CURRENT-UDID')));
  assert.ok(fs.existsSync(path.join(paths.backupPath, 'OLD-UDID')));
});

test('a host with no leftovers is left untouched', () => {
  const paths = makeLegacyPaths();

  restoreLegacyXctestDeviceSetRedirect(IOS_SIMULATOR, paths.xctestDeviceSetPath);

  assert.equal(fs.existsSync(paths.xctestDeviceSetPath), false);
  assert.equal(fs.existsSync(paths.backupPath), false);
});

/** Runs `step` with the other daemon's whole restore landing just before this daemon's `call`. */
function withOtherDaemonFinishingBefore(
  call: 'readlinkSync' | 'unlinkSync' | 'renameSync',
  paths: LegacyRedirect,
  device: Parameters<typeof restoreLegacyXctestDeviceSetRedirect>[0],
): void {
  const original = fs[call] as (...args: unknown[]) => unknown;
  vi.spyOn(fs, call).mockImplementationOnce(((...args: unknown[]) => {
    restoreLegacyXctestDeviceSetRedirect(device, paths.xctestDeviceSetPath);
    return original.apply(fs, args);
  }) as never);
  restoreLegacyXctestDeviceSetRedirect(device, paths.xctestDeviceSetPath);
}

test('a daemon whose unlink or rename the other daemon already made finishes the restore', () => {
  for (const call of ['unlinkSync', 'renameSync'] as const) {
    const paths = makeLegacyPaths();
    fs.mkdirSync(path.join(paths.backupPath, 'HOST-UDID'), { recursive: true });
    fs.symlinkSync(paths.scopedSetPath, paths.xctestDeviceSetPath, 'dir');

    withOtherDaemonFinishingBefore(call, paths, IOS_SIMULATOR);

    assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isSymbolicLink(), false, call);
    assert.ok(fs.existsSync(path.join(paths.xctestDeviceSetPath, 'HOST-UDID')), call);
    assert.equal(fs.existsSync(paths.backupPath), false, call);
    assert.ok(fs.existsSync(path.join(paths.scopedSetPath, 'SCOPED-UDID')), call);
    vi.restoreAllMocks();
  }
});

test('a daemon whose link the other daemon removed before it was read leaves the host alone', () => {
  const paths = makeLegacyPaths();
  const scoped = { ...IOS_SIMULATOR, simulatorSetPath: paths.scopedSetPath };
  fs.symlinkSync(paths.scopedSetPath, paths.xctestDeviceSetPath, 'dir');

  withOtherDaemonFinishingBefore('readlinkSync', paths, scoped);

  assert.equal(fs.lstatSync(paths.xctestDeviceSetPath, { throwIfNoEntry: false }), undefined);
  assert.ok(fs.existsSync(path.join(paths.scopedSetPath, 'SCOPED-UDID')));
});

test('an unlink that fails while the link is still there is reported', () => {
  const paths = makeLegacyPaths();
  fs.mkdirSync(paths.backupPath);
  fs.symlinkSync(paths.scopedSetPath, paths.xctestDeviceSetPath, 'dir');
  vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  });

  assert.throws(
    () => restoreLegacyXctestDeviceSetRedirect(IOS_SIMULATOR, paths.xctestDeviceSetPath),
    /EACCES/,
  );
});
