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
  // The root holds no pnpm-lock.yaml, so there is no source checkout here to diagnose.
  // A published agent-device install is exactly this: package.json `files` ships bin/,
  // dist/ and the helper artifacts, never the lockfile, and an npm tarball never carries
  // node_modules. Callers must treat this as "question does not apply", not as a defect
  // — reporting a stale install here would fire on every end user's packaged `doctor`.
  | { readonly status: 'no-source-checkout' }
  | { readonly status: 'in-sync' }
  | {
      readonly status: 'out-of-sync';
      // 'install-missing': pnpm-lock.yaml is present but node_modules/.pnpm/lock.yaml is
      // not — a source checkout that was never installed, which is exactly the fresh-worktree
      // trap: without its own install, module resolution silently walks up to another
      // checkout's node_modules.
      // 'stale': both files exist but their contents (and therefore hashes) disagree —
      // node_modules was installed from a different pnpm-lock.yaml than the one checked out.
      readonly reason: 'install-missing' | 'stale';
    };

/**
 * Compares the lockfile a checkout's node_modules was installed from against the
 * lockfile currently checked out, using a content hash of each — no subprocess.
 *
 * Whether this is a source checkout at all is decided by the presence of
 * `pnpm-lock.yaml` under `repoRoot`, not by any heuristic about where the code was
 * installed from: the lockfile is committed in every worktree and shipped in no
 * published package, so its presence is the fact itself rather than a proxy for it.
 *
 * Works from any worktree: both paths are resolved under the given repoRoot, so a
 * worktree's own node_modules is checked against its own pnpm-lock.yaml, never another
 * checkout's.
 */
export function checkLockfileInstallSync(repoRoot: string): LockfileInstallSyncResult {
  const lockfileHash = hashFileIfExists(path.join(repoRoot, LOCKFILE_BASENAME));
  if (!lockfileHash) return { status: 'no-source-checkout' };

  const installedSnapshotHash = hashFileIfExists(
    path.join(repoRoot, ...INSTALLED_SNAPSHOT_RELATIVE_PATH),
  );
  if (!installedSnapshotHash) return { status: 'out-of-sync', reason: 'install-missing' };

  return lockfileHash === installedSnapshotHash
    ? { status: 'in-sync' }
    : { status: 'out-of-sync', reason: 'stale' };
}

function hashFileIfExists(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
