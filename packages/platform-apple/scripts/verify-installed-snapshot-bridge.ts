import path from 'node:path';
import { ensureSnapshotBridgeBinary } from '../src/snapshot-source/cache.ts';
import { createSnapshotSourceDeadline } from '../src/snapshot-source/deadline.ts';
import { createSnapshotSourceHost } from '../src/snapshot-source/host.ts';
import { resolveSnapshotSourceLimits } from '../src/snapshot-source/limits.ts';

const [installedRoot, cacheRoot] = process.argv.slice(2);
if (!installedRoot || !cacheRoot) {
  throw new Error('Usage: verify-installed-snapshot-bridge <installed-root> <cache-root>');
}

const host = {
  ...createSnapshotSourceHost(),
  projectRoot: () => installedRoot,
};
const limits = resolveSnapshotSourceLimits({ maxDurationMs: 120_000 });
const prepared = await ensureSnapshotBridgeBinary({
  host,
  runtime: 'installed-package-verification',
  limits,
  deadline: createSnapshotSourceDeadline(limits.maxDurationMs, undefined),
  cacheRoot,
});
if (!prepared.path.startsWith(`${cacheRoot}${path.sep}`) || !host.exists(prepared.path)) {
  throw new Error('Installed snapshot bridge preparation did not publish its compiled binary.');
}
