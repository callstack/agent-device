import crypto from 'node:crypto';
import path from 'node:path';
import { hostFileStatSync, readHostDirectorySync } from '@agent-device/host-kit/host-file';
import type { WebMachine } from './toolbox.ts';

/** Everything that locates one version's managed install, its home, and its sockets. */
export type ManagedInstallPaths = {
  stateDir: string;
  installDir: string;
  homeDir: string;
  runtimeHomeDir: string;
  socketDir: string;
};

/**
 * The host's own machine answers, which every path below is built from. Each of these paths has to be
 * one the spawned backend can use, so the operating system and the temporary directory named by them
 * are the ones that process sees: the host the commands run on, not the bundle that built the argv.
 */
export type WebInstallMachine = Pick<WebMachine, 'hostOs' | 'temporaryDirectory'>;

export function managedInstallPaths(
  stateDir: string,
  version: string,
  machine: WebInstallMachine,
): ManagedInstallPaths {
  const installDir = path.join(managedToolsRoot(stateDir), version);
  return {
    stateDir,
    installDir,
    homeDir: path.join(installDir, 'home'),
    runtimeHomeDir: resolveManagedRuntimeHomeDir(installDir, machine),
    socketDir: resolveManagedSocketDir(installDir, machine),
  };
}

/**
 * Every version directory under the state dir's managed tools root. A backend left running by a
 * previous version lives in a sibling of the current install, so ownership of the fleet spans all of
 * them rather than the one the running pin names.
 */
export function listManagedInstallPaths(
  stateDir: string,
  machine: WebInstallMachine,
): ManagedInstallPaths[] {
  const root = managedToolsRoot(stateDir);
  let entries: string[];
  try {
    entries = readHostDirectorySync(root);
  } catch (error) {
    if (isNoEntryError(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => isDirectory(path.join(root, entry)))
    .map((version) => managedInstallPaths(stateDir, version, machine));
}

function managedToolsRoot(stateDir: string): string {
  return path.join(stateDir, 'tools', 'agent-browser');
}

function resolveManagedRuntimeHomeDir(installDir: string, machine: WebInstallMachine): string {
  if (machine.hostOs === 'win32') return path.join(installDir, 'home');
  return path.join(machine.temporaryDirectory, 'agent-device-web', installHash(installDir));
}

function resolveManagedSocketDir(installDir: string, machine: WebInstallMachine): string {
  return path.join(machine.temporaryDirectory, 'adw', installHash(installDir));
}

function installHash(installDir: string): string {
  return crypto.createHash('sha1').update(installDir).digest('hex').slice(0, 12);
}

function isDirectory(entryPath: string): boolean {
  try {
    return hostFileStatSync(entryPath).isDirectory();
  } catch (error) {
    if (isNoEntryError(error)) return false;
    throw error;
  }
}

export function isNoEntryError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
