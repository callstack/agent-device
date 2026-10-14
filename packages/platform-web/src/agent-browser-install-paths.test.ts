import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from './__tests__/test-utils.ts';
import { listManagedInstallPaths, managedInstallPaths } from './agent-browser-install-paths.ts';

test('install paths are keyed by state dir and version', () => {
  const stateDir = path.join(path.sep, 'state');
  const current = managedInstallPaths(stateDir, '0.39.0');

  expect(current.installDir).toBe(path.join(stateDir, 'tools', 'agent-browser', '0.39.0'));
  expect(current.homeDir).toBe(path.join(current.installDir, 'home'));
  expect(managedInstallPaths(stateDir, '0.27.1').socketDir).not.toBe(current.socketDir);
  expect(managedInstallPaths(stateDir, '0.39.0')).toEqual(current);
});

test('listing finds every installed version and tolerates a missing tools root', () => {
  const stateDir = mkdtempForTestSync('agent-device-web-installs-');
  try {
    expect(listManagedInstallPaths(stateDir)).toEqual([]);

    for (const version of ['0.27.1', '0.39.0']) {
      fs.mkdirSync(managedInstallPaths(stateDir, version).installDir, { recursive: true });
    }

    expect(
      listManagedInstallPaths(stateDir)
        .map(({ installDir }) => path.basename(installDir))
        .sort(),
    ).toEqual(['0.27.1', '0.39.0']);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('listing skips the install lock file beside the version directories', () => {
  const stateDir = mkdtempForTestSync('agent-device-web-installs-');
  try {
    const { installDir } = managedInstallPaths(stateDir, '0.39.0');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '..', '.agent-browser-install.lock'), '');

    expect(listManagedInstallPaths(stateDir).map((install) => install.installDir)).toEqual([
      installDir,
    ]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
