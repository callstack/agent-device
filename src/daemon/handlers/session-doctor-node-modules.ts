import {
  checkLockfileInstallSync,
  STALE_NODE_MODULES_MESSAGE,
} from '../../utils/lockfile-install-sync.ts';
import { findProjectRoot } from '../../utils/version.ts';
import type { DoctorCheck } from '@agent-device/contracts/observability';

export function nodeModulesLockfileCheck(repoRoot: string = findProjectRoot()): DoctorCheck {
  const result = checkLockfileInstallSync(repoRoot);
  if (result.inSync) {
    return {
      id: 'node-modules',
      status: 'pass',
      summary: 'node_modules matches pnpm-lock.yaml.',
    };
  }
  if (result.reason === 'lockfile-missing') {
    return {
      id: 'node-modules',
      status: 'warn',
      summary: 'pnpm-lock.yaml not found; cannot verify node_modules is in sync.',
      evidence: { repoRoot, reason: result.reason },
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
