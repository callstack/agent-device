import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { restoreLegacyXctestDeviceSetRedirect } from '../legacy-xctest-device-set.ts';

afterEach(() => {
  vi.restoreAllMocks();
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

  const phases = restoreRecordingPhases(paths);

  assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isSymbolicLink(), false);
  assert.ok(fs.existsSync(path.join(paths.xctestDeviceSetPath, 'HOST-UDID')));
  assert.equal(fs.existsSync(paths.backupPath), false);
  // Unlinking never follows the link: the scoped set it pointed at keeps its devices.
  assert.ok(fs.existsSync(path.join(paths.scopedSetPath, 'SCOPED-UDID')));
  assert.deepEqual(phases, [
    'ios_runner_legacy_xctest_device_set_link_removed',
    'ios_runner_legacy_xctest_device_set_backup_restored',
  ]);
});

test('a symlink an older redirect left without a backup is removed, whatever it points at', () => {
  for (const target of ['scoped', 'external'] as const) {
    const paths = makeLegacyPaths();
    const linkTarget =
      target === 'scoped'
        ? paths.scopedSetPath
        : path.join(path.dirname(paths.scopedSetPath), 'external-volume');
    fs.mkdirSync(linkTarget, { recursive: true });
    fs.symlinkSync(linkTarget, paths.xctestDeviceSetPath, 'dir');
    const diagnostics: unknown[] = [];

    restoreLegacyXctestDeviceSetRedirect(
      (diagnostic) => diagnostics.push(diagnostic),
      paths.xctestDeviceSetPath,
    );

    assert.equal(fs.lstatSync(paths.xctestDeviceSetPath, { throwIfNoEntry: false }), undefined);
    assert.ok(fs.existsSync(linkTarget), target);
    assert.deepEqual(diagnostics, [
      {
        phase: 'ios_runner_legacy_xctest_device_set_link_removed',
        resourcePath: paths.xctestDeviceSetPath,
        data: { linkTarget },
      },
    ]);
  }
});

test('a backup never replaces a host set that is already in place', () => {
  const paths = makeLegacyPaths();
  fs.mkdirSync(path.join(paths.xctestDeviceSetPath, 'CURRENT-UDID'), { recursive: true });
  fs.mkdirSync(path.join(paths.backupPath, 'OLD-UDID'), { recursive: true });

  restoreRecordingPhases(paths);

  assert.ok(fs.existsSync(path.join(paths.xctestDeviceSetPath, 'CURRENT-UDID')));
  assert.ok(fs.existsSync(path.join(paths.backupPath, 'OLD-UDID')));
});

test('a host with no leftovers is left untouched and reports nothing', () => {
  const paths = makeLegacyPaths();

  const phases = restoreRecordingPhases(paths);

  assert.equal(fs.existsSync(paths.xctestDeviceSetPath), false);
  assert.equal(fs.existsSync(paths.backupPath), false);
  assert.deepEqual(phases, []);
});

/** Runs the restore with the other daemon's whole restore landing just before this one's `call`. */
function withOtherDaemonFinishingBefore(
  call: 'unlinkSync' | 'renameSync',
  paths: LegacyRedirect,
): string[] {
  const original = fs[call] as (...args: unknown[]) => unknown;
  vi.spyOn(fs, call).mockImplementationOnce(((...args: unknown[]) => {
    restoreRecordingPhases(paths);
    return original.apply(fs, args);
  }) as never);
  return restoreRecordingPhases(paths);
}

test('a daemon whose unlink or rename the other daemon already made finishes the restore', () => {
  for (const call of ['unlinkSync', 'renameSync'] as const) {
    const paths = makeLegacyPaths();
    fs.mkdirSync(path.join(paths.backupPath, 'HOST-UDID'), { recursive: true });
    fs.symlinkSync(paths.scopedSetPath, paths.xctestDeviceSetPath, 'dir');

    const phases = withOtherDaemonFinishingBefore(call, paths);

    assert.equal(
      phases.includes('ios_runner_legacy_xctest_device_set_restore_failed'),
      false,
      call,
    );
    assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isSymbolicLink(), false, call);
    assert.ok(fs.existsSync(path.join(paths.xctestDeviceSetPath, 'HOST-UDID')), call);
    assert.equal(fs.existsSync(paths.backupPath), false, call);
    assert.ok(fs.existsSync(path.join(paths.scopedSetPath, 'SCOPED-UDID')), call);
    vi.restoreAllMocks();
  }
});

test('an unlink that fails while the link is still there is reported, not thrown', () => {
  const paths = makeLegacyPaths();
  fs.mkdirSync(paths.backupPath);
  fs.symlinkSync(paths.scopedSetPath, paths.xctestDeviceSetPath, 'dir');
  vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  });
  const diagnostics: unknown[] = [];

  restoreLegacyXctestDeviceSetRedirect(
    (diagnostic) => diagnostics.push(diagnostic),
    paths.xctestDeviceSetPath,
  );

  assert.deepEqual(diagnostics, [
    {
      phase: 'ios_runner_legacy_xctest_device_set_restore_failed',
      resourcePath: paths.xctestDeviceSetPath,
      data: { error: 'EACCES: permission denied' },
    },
  ]);
  assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isSymbolicLink(), true);
  assert.ok(fs.existsSync(paths.backupPath));
});

function restoreRecordingPhases(paths: LegacyRedirect): string[] {
  const phases: string[] = [];
  restoreLegacyXctestDeviceSetRedirect(
    (diagnostic) => phases.push(diagnostic.phase),
    paths.xctestDeviceSetPath,
  );
  return phases;
}
