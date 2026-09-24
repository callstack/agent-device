import { createHash } from 'node:crypto';
import path from 'node:path';
import { withProcessLock } from '@agent-device/host-kit/file';
import { isCommandTimeoutError, type ExecResult } from '@agent-device/host-kit/command';
import { remainingSnapshotSourceMs, type SnapshotSourceDeadline } from './deadline.ts';
import { SnapshotSourceError, snapshotSourceError } from './errors.ts';
import type { SnapshotSourceHost } from './types.ts';

const MANIFEST_FILENAME = 'manifest.json';

export type NativeBuildCacheEntry = Readonly<{ path: string; cacheKey: string }>;

/**
 * One locked cache entry keyed on everything its build depends on: a candidate hit is verified
 * against its manifest's key and binary hash, a miss builds into a temp directory and publishes it
 * with an atomic rename, and a build that fails leaves no partial entry behind. Every runtime clang
 * build in this package shares this mechanism so a stale entry, a corrupt cache, or a
 * `DEVELOPER_DIR` switch is handled once (#2796).
 */
export async function ensureNativeBuildCacheEntry(
  input: Readonly<{
    host: SnapshotSourceHost;
    deadline: SnapshotSourceDeadline;
    cacheRoot: string;
    binaryFilename: string;
    /** Names the contended resource in a lock-stall diagnostic; every caller states its own. */
    lockDescription: string;
    /** Everything the built binary depends on: hashed into the cache key and recorded in the manifest. */
    keyInputs: Readonly<Record<string, unknown>>;
    /** Builds `outputPath` and throws its own typed error on failure. */
    build: (outputPath: string) => Promise<void>;
  }>,
): Promise<NativeBuildCacheEntry> {
  const { host, deadline, cacheRoot, binaryFilename } = input;
  const cacheKey = createHash('sha256')
    .update(JSON.stringify(input.keyInputs))
    .digest('hex')
    .slice(0, 32);
  const entryPath = path.join(cacheRoot, cacheKey);
  return await withProcessLock({
    acquire: () =>
      host.acquireLock(path.join(cacheRoot, `${cacheKey}.lock`), {
        deadline,
        description: input.lockDescription,
      }),
    task: async () => {
      const cached = await readValidCacheEntry(host, entryPath, binaryFilename, cacheKey, deadline);
      if (cached) return { path: cached, cacheKey };
      remainingSnapshotSourceMs(deadline, 'native-build-deadline');
      if (host.exists(entryPath)) await host.remove(entryPath);
      remainingSnapshotSourceMs(deadline, 'native-build-deadline');
      await host.ensureDirectory(cacheRoot);
      const temporaryPath = path.join(cacheRoot, `.${cacheKey}.${host.processId()}.tmp`);
      remainingSnapshotSourceMs(deadline, 'native-build-deadline');
      await host.remove(temporaryPath);
      try {
        remainingSnapshotSourceMs(deadline, 'native-build-deadline');
        await host.ensureDirectory(temporaryPath);
        const outputPath = path.join(temporaryPath, binaryFilename);
        await input.build(outputPath);
        remainingSnapshotSourceMs(deadline, 'native-build-deadline');
        await host.chmod(outputPath, 0o755);
        const binarySha256 = await sha256File(host, outputPath);
        const manifest = { ...input.keyInputs, cacheKey, binarySha256 };
        await host.writeText(
          path.join(temporaryPath, MANIFEST_FILENAME),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
        remainingSnapshotSourceMs(deadline, 'native-build-deadline');
        await host.rename(temporaryPath, entryPath);
        return { path: path.join(entryPath, binaryFilename), cacheKey };
      } catch (error) {
        await host.remove(temporaryPath);
        throw error;
      }
    },
  });
}

async function readValidCacheEntry(
  host: SnapshotSourceHost,
  entryPath: string,
  binaryFilename: string,
  cacheKey: string,
  deadline: SnapshotSourceDeadline,
): Promise<string | undefined> {
  const binaryPath = path.join(entryPath, binaryFilename);
  const manifestPath = path.join(entryPath, MANIFEST_FILENAME);
  if (!host.exists(binaryPath) || !host.exists(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(await host.readText(manifestPath)) as Record<string, unknown>;
    if (manifest.cacheKey !== cacheKey || typeof manifest.binarySha256 !== 'string') {
      return undefined;
    }
    remainingSnapshotSourceMs(deadline, 'native-cache-hash-deadline');
    const matchesBinary = (await sha256File(host, binaryPath)) === manifest.binarySha256;
    return matchesBinary ? binaryPath : undefined;
  } catch (error) {
    if (isCacheReadCancellationOrTimeout(error)) throw error;
    return undefined;
  }
}

/** Distinguishes a real cache-read failure (corrupt entry, stale manifest) from a caller cancellation or deadline. */
function isCacheReadCancellationOrTimeout(error: unknown): boolean {
  return (
    error instanceof SnapshotSourceError &&
    (error.failureKind === 'cancelled' || error.failureKind === 'timeout')
  );
}

async function sha256File(host: SnapshotSourceHost, filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await host.readBinary(filePath))
    .digest('hex');
}

/**
 * SHA-256 over `sourceFilenames`, read from `root` in the given order and keyed by filename so a
 * rename busts the cache. Every runtime clang build in this package fingerprints its sources this
 * way, over its own filename list (#2796).
 */
export async function fingerprintNativeBuildSource(
  host: SnapshotSourceHost,
  root: string,
  sourceFilenames: readonly string[],
  deadline: SnapshotSourceDeadline,
): Promise<string> {
  const hash = createHash('sha256');
  for (const sourceFile of sourceFilenames) {
    const filePath = path.join(root, sourceFile);
    remainingSnapshotSourceMs(deadline, 'native-source-fingerprint-deadline');
    if (!host.exists(filePath)) {
      throw snapshotSourceError('unsupported', 'native-source-missing', { filePath });
    }
    hash.update(sourceFile);
    hash.update('\0');
    hash.update(await host.readBinary(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * One budgeted `xcrun` invocation, shared by every runtime clang build in this package so a compile
 * exec this module asked to be killed is reported once, as `'native-build-stalled'`, with the
 * budget it hit and a hint naming `label`'s build (#2796).
 */
export async function execNativeBuildClang(
  input: Readonly<{
    host: SnapshotSourceHost;
    deadline: SnapshotSourceDeadline;
    argv: readonly string[];
    budgetMs: number;
    /** Names the build in the stall hint, e.g. "bridge" or "fold helper". */
    label: string;
  }>,
): Promise<ExecResult> {
  const timeoutMs = Math.min(
    input.budgetMs,
    remainingSnapshotSourceMs(input.deadline, 'native-build-deadline'),
  );
  try {
    return await input.host.run('xcrun', [...input.argv], {
      signal: input.deadline.signal,
      timeoutMs,
      allowFailure: true,
    });
  } catch (error) {
    if (!isCommandTimeoutError(error)) throw error;
    throw snapshotSourceError(
      'timeout',
      'native-build-stalled',
      {
        timeoutMs,
        hint:
          `The Simulator SDK toolchain did not answer within ${timeoutMs}ms, which stopped the ${input.label} ` +
          `build before clang reported anything. Run \`xcrun --sdk iphonesimulator clang --version\` ` +
          `by hand until it answers, then retry.`,
      },
      error,
    );
  }
}
