import fs from 'node:fs';
import { realHostMachineFacts } from './toolbox.fixtures.ts';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from './__tests__/test-utils.ts';
import { listManagedInstallPaths, managedInstallPaths } from './agent-browser-install-paths.ts';

const machine = realHostMachineFacts();

test('install paths are keyed by state dir and version', () => {
  const stateDir = path.join(path.sep, 'state');
  const current = managedInstallPaths(stateDir, '0.39.0', machine);

  expect(current.installDir).toBe(path.join(stateDir, 'tools', 'agent-browser', '0.39.0'));
  expect(current.homeDir).toBe(path.join(current.installDir, 'home'));
  expect(managedInstallPaths(stateDir, '0.27.1', machine).socketDir).not.toBe(current.socketDir);
  expect(managedInstallPaths(stateDir, '0.39.0', machine)).toEqual(current);
});

test('the runtime home and socket dir come from the host that runs the backend', () => {
  const stateDir = path.join(path.sep, 'state');
  const current = managedInstallPaths(stateDir, '0.39.0', machine);

  // POSIX shortens the home to the host's temporary directory: a socket path over the macOS
  // 104-character limit is unusable, and the host names the short directory that is not.
  expect(
    current.runtimeHomeDir.startsWith(path.join(machine.temporaryDirectory, 'agent-device-web')),
  ).toBe(true);
  expect(current.socketDir.startsWith(path.join(machine.temporaryDirectory, 'adw'))).toBe(true);

  // The answers are the host's, not this process's: another temporary directory moves both, so a
  // backend spawned for that host finds its own home and socket rather than the bundle's.
  const elsewhere = {
    ...machine,
    temporaryDirectory: path.join(machine.temporaryDirectory, 'other'),
  };
  const moved = managedInstallPaths(stateDir, '0.39.0', elsewhere);
  expect(moved.runtimeHomeDir).not.toBe(current.runtimeHomeDir);
  expect(moved.socketDir).not.toBe(current.socketDir);
  expect(
    moved.runtimeHomeDir.startsWith(path.join(elsewhere.temporaryDirectory, 'agent-device-web')),
  ).toBe(true);

  // Windows keeps the home inside the install, so the backend's paths stay under one root.
  const windows = managedInstallPaths(stateDir, '0.39.0', { ...machine, hostOs: 'win32' });
  expect(windows.runtimeHomeDir).toBe(path.join(windows.installDir, 'home'));
});

test('listing finds every installed version and tolerates a missing tools root', () => {
  const stateDir = mkdtempForTestSync('agent-device-web-installs-');
  try {
    expect(listManagedInstallPaths(stateDir, machine)).toEqual([]);

    for (const version of ['0.27.1', '0.39.0']) {
      fs.mkdirSync(managedInstallPaths(stateDir, version, machine).installDir, { recursive: true });
    }

    expect(
      listManagedInstallPaths(stateDir, machine)
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
    const { installDir } = managedInstallPaths(stateDir, '0.39.0', machine);
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, '..', '.agent-browser-install.lock'), '');

    expect(listManagedInstallPaths(stateDir, machine).map((install) => install.installDir)).toEqual(
      [installDir],
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
