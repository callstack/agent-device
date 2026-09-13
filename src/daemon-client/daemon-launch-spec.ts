import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  DAEMON_SOURCE_ENTRY,
  findProjectRoot,
  isSourceCheckoutProjectRoot,
  readVersion,
} from '@agent-device/host-kit/version';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

import { computeDaemonCodeSignature } from '@agent-device/host-kit/code-signature';
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
 * The signature a running daemon must report to be reused, or `undefined` when this
 * tree's version already pins its code — which is what an installed package is.
 *
 * An installed tree's bytes change on install and not on edit, and every install of
 * one published version is the same artifact, so its version is the identity a client
 * can compare. `size:mtime` cannot be: an installer stamps a fresh mtime on every
 * install, so two installs of identical bytes sign differently, and demanding they
 * agree replaces a daemon that already runs exactly this code — its live session with
 * it (#2458). A source checkout is the tree whose code moves under a version that does
 * not, which is the drift a fingerprint still has to catch.
 *
 * The two trees do not normally compete for one daemon: a checkout keeps it in a
 * worktree-scoped state directory and an installed client in the shared one
 * (`src/daemon/config.ts`, same test). An explicit `--state-dir` is what puts them
 * together, and adopting the checkout's daemon there still adopts this version's code.
 *
 * A dist entry is a bundle of ~120 chunks and walks in ~5ms; a source checkout's graph
 * — ~1,500 modules once the workspace packages the daemon imports by specifier are
 * counted — costs tens of milliseconds and goes through the stat-validated cache
 * (`code-signature-cache.ts`), which replays the identical signature from `statSync`
 * alone. That cache loads on demand, which is why this is async: only the source arm
 * can reach it, and a static import would put it and its atomic-publish dependency in
 * the startup closure of every client that cannot use it (`eager-closure-budgets.ts`).
 *
 * Deliberately NOT memoized, unlike the launch spec above: a long-lived client (the
 * MCP server) must still notice a daemon rebuilt underneath it, and the cache is what
 * makes re-answering that question per request cheap.
 */
export async function resolveLocalDaemonCodeSignature(): Promise<string | undefined> {
  const launchSpec = resolveDaemonLaunchSpec();
  if (!isSourceCheckoutProjectRoot(launchSpec.root)) return undefined;
  if (!launchSpec.useSrc) {
    return computeDaemonCodeSignature(launchSpec.distPath, launchSpec.root);
  }
  const { resolveCachedDaemonCodeSignature } =
    await import('@agent-device/host-kit/code-signature-cache');
  return resolveCachedDaemonCodeSignature(launchSpec.srcPath, launchSpec.root);
}

/**
 * Why the daemon already running on this state directory cannot be reused, or
 * `undefined` when it can be.
 *
 * One ladder answers both questions, so a daemon can never be reused and announced as
 * replaced, or replaced without a reason to print. The version answers first because
 * it is cheap, and for an installed client it answers alone; only a source checkout
 * goes on to ask `resolveLocalDaemonCodeSignature`, and unreachability decides last.
 */
export async function resolveDaemonTakeoverReason(
  info: DaemonInfo,
  reachable: boolean,
): Promise<string | undefined> {
  if (info.version !== readVersion()) return `version mismatch (client v${readVersion()})`;
  const localCodeSignature = await resolveLocalDaemonCodeSignature();
  if (localCodeSignature !== undefined && info.codeSignature !== localCodeSignature) {
    return 'code-signature mismatch';
  }
  if (!reachable) return 'unreachable';
  return undefined;
}
