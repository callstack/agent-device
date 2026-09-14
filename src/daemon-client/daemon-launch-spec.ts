import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { DAEMON_SOURCE_ENTRY, findProjectRoot, readVersion } from '@agent-device/host-kit/version';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

import {
  computeDaemonCodeSignature,
  resolveDaemonCodeOrigin,
} from '@agent-device/host-kit/code-signature';
import type { DaemonInfo } from './daemon-client-metadata.ts';

export type DaemonLaunchSpec = {
  root: string;
  distPath: string;
  distPaths: string[];
  srcPath: string;
  useSrc: boolean;
};

// Which entry this client launches cannot change under it: a source client
// stays a source client whatever a concurrent build produces, and the paths
// themselves are derived from the project root. So the ~8 existence probes run
// once per process, cleared between tests by the shared process-memo reset.
const launchSpecMemo = createTtlMemo<'local', DaemonLaunchSpec>();

/** Which daemon entry this client would launch, and the root it belongs to. */
export function resolveDaemonLaunchSpec(): DaemonLaunchSpec {
  const memoized = launchSpecMemo.get('local');
  if (memoized) return memoized;

  const root = findProjectRoot();
  const distPaths = [
    path.join(root, 'dist', 'src', 'internal', 'daemon.js'),
    path.join(root, 'dist', 'src', 'daemon.js'),
  ];
  const defaultDistPath = distPaths[0];
  if (defaultDistPath === undefined) {
    throw new AppError('COMMAND_FAILED', 'Daemon dist path list is empty');
  }
  const distPath = distPaths.find((candidate) => fs.existsSync(candidate)) ?? defaultDistPath;
  const srcPath = path.join(root, DAEMON_SOURCE_ENTRY);

  const hasDist = distPaths.some((candidate) => fs.existsSync(candidate));
  const hasSrc = fs.existsSync(srcPath);
  if (!hasDist && !hasSrc) {
    throw new AppError('COMMAND_FAILED', 'Daemon entry not found', { distPaths, srcPath });
  }
  const runningFromSource = process.execArgv.includes('--experimental-strip-types');
  const useSrc = runningFromSource ? hasSrc : !hasDist && hasSrc;

  const spec: DaemonLaunchSpec = { root, distPath, distPaths, srcPath, useSrc };
  launchSpecMemo.set('local', spec);
  return spec;
}

/**
 * What this tree would launch a daemon from, and what it can prove about that code.
 *
 * An installed tree carries no fingerprint at all, on purpose. Its bytes change on
 * install and not on edit, and every install of one published version is the same
 * artifact, so the version is the whole of the identity it can offer: `size:mtime`
 * cannot be a fingerprint of it, because an installer stamps a fresh mtime on every
 * file and two installs of identical bytes would then sign differently and replace
 * each other's daemon — live session with it (#2458). A source checkout is the tree
 * whose code moves under a version that does not, so it keeps a fingerprint.
 */
export type LocalDaemonCodeIdentity =
  | { origin: 'installed' }
  | { origin: 'checkout'; codeSignature: string };

/**
 * This tree's answer, read afresh on every call.
 *
 * A dist entry is a bundle of ~120 chunks and walks in ~5ms; a source checkout's graph
 * — ~1,500 modules once the workspace packages the daemon imports by specifier are
 * counted — costs tens of milliseconds and goes through the stat-validated cache
 * (`code-signature-cache.ts`), which replays the identical signature from `statSync`
 * alone. That cache loads on demand, which is why this is async: only the checkout arm
 * can reach it, and a static import would put it and its atomic-publish dependency in
 * the startup closure of every client that cannot use it (`eager-closure-budgets.ts`).
 *
 * Deliberately NOT memoized, unlike the launch spec above: a long-lived client (the
 * MCP server) must still notice a daemon rebuilt underneath it, and the cache is what
 * makes re-answering that question per request cheap.
 */
export async function resolveLocalDaemonCodeIdentity(): Promise<LocalDaemonCodeIdentity> {
  const launchSpec = resolveDaemonLaunchSpec();
  const origin = resolveDaemonCodeOrigin(launchSpec.root);
  if (origin === 'installed') return { origin };
  if (!launchSpec.useSrc) {
    return {
      origin,
      codeSignature: computeDaemonCodeSignature(launchSpec.distPath, launchSpec.root),
    };
  }
  const { resolveCachedDaemonCodeSignature } =
    await import('@agent-device/host-kit/code-signature-cache');
  return {
    origin,
    codeSignature: await resolveCachedDaemonCodeSignature(launchSpec.srcPath, launchSpec.root),
  };
}

/**
 * Why the daemon already running on this state directory cannot be reused, or
 * `undefined` when it can be.
 *
 * One ladder answers both questions, so a daemon can never be reused and announced as
 * replaced, or replaced without a reason to print. The version answers first because
 * it is cheap and decides alone for the common pair of installed trees; the code
 * identity (`resolveCodeIdentityMismatch`) answers next and unreachability last.
 */
export async function resolveDaemonTakeoverReason(
  info: DaemonInfo,
  reachable: boolean,
): Promise<string | undefined> {
  if (info.version !== readVersion()) return `version mismatch (client v${readVersion()})`;
  const localIdentity = await resolveLocalDaemonCodeIdentity();
  const codeMismatch = resolveCodeIdentityMismatch(localIdentity, info);
  if (codeMismatch) return codeMismatch;
  if (!reachable) return 'unreachable';
  return undefined;
}

/**
 * Whether the running daemon holds the code this client would launch, given what each
 * side can prove about itself.
 *
 * The bypass is pairwise, not one-sided: it holds only where BOTH sides are installed,
 * because that is the only pair whose shared version already fixes the bytes both run.
 * One side cannot vouch for the other — an installed client that reused an unreported
 * daemon would run whatever a modified checkout beside it chose to publish under this
 * version (#2458). A daemon that predates the field is therefore judged by its
 * signature, the rule it was reused under until now, which costs a long-lived state
 * directory one takeover after an upgrade.
 *
 * The two trees rarely meet: a checkout keeps its daemon in a worktree-scoped state
 * directory and an installed client in the shared one (`src/daemon-resolution.ts`, same
 * test). An explicit `--state-dir` is what puts them together, and that is where this
 * pair has to hold.
 */
function resolveCodeIdentityMismatch(
  local: LocalDaemonCodeIdentity,
  info: DaemonInfo,
): string | undefined {
  if (local.origin === 'installed') {
    return info.codeOrigin === 'installed' ? undefined : describeCodeOriginMismatch(local, info);
  }
  if (info.codeOrigin === 'installed') return describeCodeOriginMismatch(local, info);
  return info.codeSignature === local.codeSignature ? undefined : 'code-signature mismatch';
}

function describeCodeOriginMismatch(
  local: LocalDaemonCodeIdentity,
  info: DaemonInfo,
): `code origin mismatch (${string}, client ${string})` {
  return `code origin mismatch (daemon ${info.codeOrigin ?? 'unreported'}, client ${local.origin})`;
}
