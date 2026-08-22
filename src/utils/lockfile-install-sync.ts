import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// pnpm writes the exact lockfile snapshot it resolved from into
// node_modules/.pnpm/lock.yaml on every install, and re-checks it before deciding
// whether it can skip re-resolution (e.g. under --frozen-lockfile). Hashing that
// snapshot and comparing it against the checkout's pnpm-lock.yaml is the same
// staleness signal pnpm itself relies on, without shelling out to pnpm or hand-parsing
// node_modules/.modules.yaml (which, as of pnpm 11, carries no lockfile hash field —
// confirmed by inspecting a real .modules.yaml in this checkout).
const LOCKFILE_BASENAME = 'pnpm-lock.yaml';
const INSTALLED_SNAPSHOT_RELATIVE_PATH = ['node_modules', '.pnpm', 'lock.yaml'];

// Shared verbatim between the `doctor` node-modules probe
// (src/daemon/handlers/session-doctor-node-modules.ts) and the check:affected preflight
// (scripts/check-affected/run.ts), so a stale install names the same cause on both
// surfaces instead of drifting into two different wordings over time.
export const STALE_NODE_MODULES_MESSAGE =
  'node_modules was installed from a different lockfile; run pnpm install';

export type LockfileInstallSyncResult =
  | { readonly inSync: true }
  | {
      readonly inSync: false;
      // 'lockfile-missing': no pnpm-lock.yaml in the checkout — a broken checkout, not a
      // stale install, but the caller has nothing to compare against either way.
      // 'install-missing': no node_modules/.pnpm/lock.yaml — never installed here, which
      // is exactly the "fresh worktree" trap: without its own install, module resolution
      // silently walks up to another checkout's node_modules.
      // 'stale': both files exist but their contents (and therefore hashes) disagree —
      // node_modules was installed from a different pnpm-lock.yaml than the one checked out.
      readonly reason: 'lockfile-missing' | 'install-missing' | 'stale';
    };

/**
 * Compares the lockfile a checkout's node_modules was installed from against the
 * lockfile currently checked out, using a content hash of each — no subprocess.
 * Works from any worktree: both paths are resolved under the given repoRoot, so a
 * worktree's own node_modules is checked against its own pnpm-lock.yaml, never another
 * checkout's.
 */
export function checkLockfileInstallSync(repoRoot: string): LockfileInstallSyncResult {
  const lockfileHash = hashFileIfExists(path.join(repoRoot, LOCKFILE_BASENAME));
  if (!lockfileHash) return { inSync: false, reason: 'lockfile-missing' };

  const installedSnapshotHash = hashFileIfExists(
    path.join(repoRoot, ...INSTALLED_SNAPSHOT_RELATIVE_PATH),
  );
  if (!installedSnapshotHash) return { inSync: false, reason: 'install-missing' };

  return lockfileHash === installedSnapshotHash
    ? { inSync: true }
    : { inSync: false, reason: 'stale' };
}

function hashFileIfExists(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
