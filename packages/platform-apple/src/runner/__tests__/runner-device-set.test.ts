import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { IOS_DEVICE, IOS_SIMULATOR, TVOS_SIMULATOR } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  restoreLegacyXctestDeviceSetRedirect,
  runnerSimulatorSetFailureDetails,
  xcodebuildDestinationArgs,
} from '../runner-device-set.ts';

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

test('a failure reports the scoped set and the Xcode only for a scoped-set simulator', () => {
  const scoped = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulators' };

  assert.deepEqual(runnerSimulatorSetFailureDetails(scoped, '26.2'), {
    simulatorSetPath: '/tmp/tenant-a/simulators',
    xcodeVersion: '26.2',
  });
  assert.deepEqual(runnerSimulatorSetFailureDetails(IOS_SIMULATOR, '26.2'), {});
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

  restoreLegacyXctestDeviceSetRedirect(paths.xctestDeviceSetPath);

  assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isSymbolicLink(), false);
  assert.ok(fs.existsSync(path.join(paths.xctestDeviceSetPath, 'HOST-UDID')));
  assert.equal(fs.existsSync(paths.backupPath), false);
  // Unlinking never follows the link: the scoped set it pointed at keeps its devices.
  assert.ok(fs.existsSync(path.join(paths.scopedSetPath, 'SCOPED-UDID')));
});

test('a symlink an older redirect left without a backup is removed', () => {
  const paths = makeLegacyPaths();
  fs.symlinkSync(paths.scopedSetPath, paths.xctestDeviceSetPath, 'dir');

  restoreLegacyXctestDeviceSetRedirect(paths.xctestDeviceSetPath);

  assert.equal(fs.lstatSync(paths.xctestDeviceSetPath, { throwIfNoEntry: false }), undefined);
  assert.ok(fs.existsSync(path.join(paths.scopedSetPath, 'SCOPED-UDID')));
});

test('a backup never replaces a host set that is already in place', () => {
  const paths = makeLegacyPaths();
  fs.mkdirSync(path.join(paths.xctestDeviceSetPath, 'CURRENT-UDID'), { recursive: true });
  fs.mkdirSync(path.join(paths.backupPath, 'OLD-UDID'), { recursive: true });

  restoreLegacyXctestDeviceSetRedirect(paths.xctestDeviceSetPath);

  assert.ok(fs.existsSync(path.join(paths.xctestDeviceSetPath, 'CURRENT-UDID')));
  assert.ok(fs.existsSync(path.join(paths.backupPath, 'OLD-UDID')));
});

test('a host with no leftovers is left untouched', () => {
  const paths = makeLegacyPaths();

  restoreLegacyXctestDeviceSetRedirect(paths.xctestDeviceSetPath);

  assert.equal(fs.existsSync(paths.xctestDeviceSetPath), false);
  assert.equal(fs.existsSync(paths.backupPath), false);
});
