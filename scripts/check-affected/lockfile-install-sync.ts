import fs from 'node:fs';
import path from 'node:path';

const LOCKFILE_BASENAME = 'pnpm-lock.yaml';
const INSTALLED_SNAPSHOT_RELATIVE_PATH = ['node_modules', '.pnpm', 'lock.yaml'];

export const STALE_NODE_MODULES_MESSAGE =
  "node_modules does not match this worktree's pnpm-lock.yaml";

export type LockfileInstallSyncResult =
  | { readonly status: 'no-source-checkout' }
  | { readonly status: 'in-sync' }
  | {
      readonly status: 'out-of-sync';
      readonly reason: 'install-missing' | 'stale';
    };

/**
 * Compares pnpm's installed lockfile snapshot with this worktree's lockfile.
 * This is intentionally synchronous and subprocess-free: it runs before any gate.
 */
export function checkLockfileInstallSync(repoRoot: string): LockfileInstallSyncResult {
  const lockfile = readFileIfExists(path.join(repoRoot, LOCKFILE_BASENAME));
  if (!lockfile) return { status: 'no-source-checkout' };

  const installedSnapshot = readFileIfExists(
    path.join(repoRoot, ...INSTALLED_SNAPSHOT_RELATIVE_PATH),
  );
  if (!installedSnapshot) return { status: 'out-of-sync', reason: 'install-missing' };

  return lockfile.equals(installedSnapshot)
    ? { status: 'in-sync' }
    : { status: 'out-of-sync', reason: 'stale' };
}

function readFileIfExists(filePath: string): Buffer | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath);
}
