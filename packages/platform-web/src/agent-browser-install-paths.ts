import crypto from 'node:crypto';
import path from 'node:path';
import {
  hostFileStatSync,
  hostTemporaryDirectory,
  readHostDirectorySync,
} from '@agent-device/host-kit/host-file';
import { hostPlatform } from '@agent-device/host-kit/process';

/** Everything that locates one version's managed install, its home, and its sockets. */
export type ManagedInstallPaths = {
  stateDir: string;
  installDir: string;
  homeDir: string;
  runtimeHomeDir: string;
  socketDir: string;
};

export function managedInstallPaths(stateDir: string, version: string): ManagedInstallPaths {
  const installDir = path.join(managedToolsRoot(stateDir), version);
  return {
    stateDir,
    installDir,
    homeDir: path.join(installDir, 'home'),
    runtimeHomeDir: resolveManagedRuntimeHomeDir(installDir),
    socketDir: resolveManagedSocketDir(installDir),
  };
}

/**
 * Every version directory under the state dir's managed tools root. A backend left running by a
 * previous version lives in a sibling of the current install, so ownership of the fleet spans all of
 * them rather than the one the running pin names.
 */
export function listManagedInstallPaths(stateDir: string): ManagedInstallPaths[] {
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
    .map((version) => managedInstallPaths(stateDir, version));
}

function managedToolsRoot(stateDir: string): string {
  return path.join(stateDir, 'tools', 'agent-browser');
}

function resolveManagedRuntimeHomeDir(installDir: string): string {
  if (hostPlatform() === 'win32') return path.join(installDir, 'home');
  return path.join(hostTemporaryDirectory(), 'agent-device-web', installHash(installDir));
}

function resolveManagedSocketDir(installDir: string): string {
  return path.join(hostTemporaryDirectory(), 'adw', installHash(installDir));
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
