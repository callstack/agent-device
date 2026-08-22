import {
  checkLockfileInstallSync,
  STALE_NODE_MODULES_MESSAGE,
} from '../../utils/lockfile-install-sync.ts';
import { findProjectRoot } from '../../utils/version.ts';
import type { DoctorCheck } from '@agent-device/contracts/observability';

/**
 * The stale-install probe for #1963, scoped to what it can actually diagnose.
 *
 * Returns `undefined` — no check line at all — when the root holds no source checkout.
 * A published agent-device ships neither pnpm-lock.yaml nor an installed snapshot, so
 * every packaged `doctor` run would otherwise carry a lockfile line that means nothing
 * to an end user and would drag the overall status down with it. Doctor already models
 * an out-of-scope question as an absent check rather than an informational one: under
 * `--remote` the whole device-inventory family is omitted, and the route tests assert
 * that absence. This follows that vocabulary.
 *
 * The caller is responsible for the other scope gate: this must not run under `--remote`,
 * where the daemon's own root would describe the server's deployment rather than the
 * caller's worktree. session-doctor.ts enforces that by calling this only after the
 * remote branch has already returned.
 */
export function nodeModulesLockfileCheck(
  repoRoot: string = findProjectRoot(),
): DoctorCheck | undefined {
  const result = checkLockfileInstallSync(repoRoot);
  if (result.status === 'no-source-checkout') return undefined;
  if (result.status === 'in-sync') {
    return {
      id: 'node-modules',
      status: 'pass',
      summary: 'node_modules matches pnpm-lock.yaml.',
    };
  }
  return {
    id: 'node-modules',
    status: 'fail',
    summary: STALE_NODE_MODULES_MESSAGE,
    hint: 'Run this from every worktree whose node_modules might have drifted, not just the main checkout.',
    command: 'pnpm install',
    evidence: { repoRoot, reason: result.reason },
  };
}
