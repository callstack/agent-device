import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

import { computeDaemonCodeSignature } from '../code-signature.ts';

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
  const srcPath = path.join(root, 'src', 'daemon.ts');

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
 * The signature a running daemon must report to be reusable. A dist entry is
 * a bundle of ~120 chunks and walks in ~5ms, so it keeps the direct walk; a
 * source checkout's ~800-module graph costs ~30ms and goes through the
 * stat-validated cache (`code-signature-cache.ts`), which returns the
 * identical signature in ~1.5ms.
 *
 * The cache loads on demand, which is why this is async: an installed client
 * runs the dist arm on every invocation and never reaches it, so a static
 * import would put the cache and its atomic-publish dependency in the startup
 * closure of a CLI that cannot use them (`eager-closure-budgets.ts`).
 *
 * Deliberately NOT memoized, unlike the launch spec above: a long-lived
 * client (the MCP server) must still notice a daemon rebuilt underneath it,
 * and the cache is what makes re-answering that question per request cheap.
 */
export async function resolveLocalDaemonCodeSignature(): Promise<string> {
  const launchSpec = resolveDaemonLaunchSpec();
  if (!launchSpec.useSrc) {
    return computeDaemonCodeSignature(launchSpec.distPath, launchSpec.root);
  }
  const { resolveCachedDaemonCodeSignature } = await import('../code-signature-cache.ts');
  return resolveCachedDaemonCodeSignature(launchSpec.srcPath, launchSpec.root);
}
