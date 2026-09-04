import { createHash } from 'node:crypto';
import path from 'node:path';
import { SnapshotSourceError, snapshotSourceError } from './errors.ts';
import { remainingSnapshotSourceMs, type SnapshotSourceDeadline } from './deadline.ts';
import {
  fingerprintSnapshotBridgeSource,
  readSnapshotSourceToolchain,
  SNAPSHOT_BRIDGE_COMPILE_FILENAMES,
  SNAPSHOT_BRIDGE_SOURCE_FILENAMES,
  type SnapshotSourceToolchainIdentity,
} from './cache-identity.ts';
import { SNAPSHOT_SOURCE_PROTOCOL_VERSION, SNAPSHOT_SOURCE_VERSION } from './protocol.ts';
import type {
  SnapshotSourceBridgeBinary,
  SnapshotSourceHost,
  SnapshotSourceLimits,
} from './types.ts';

type SnapshotBridgeCacheManifest = Readonly<{
  schemaVersion: 1;
  protocolVersion: number;
  sourceVersion: string;
  sourceHash: string;
  cacheKey: string;
  toolchain: SnapshotSourceToolchainIdentity;
  binarySha256: string;
}>;

const CACHE_SCHEMA_VERSION = 1 as const;
const BRIDGE_FILENAME = 'snapshot-bridge';
const MANIFEST_FILENAME = 'manifest.json';
const BUILD_TIMEOUT_MS = 120_000;

export async function ensureSnapshotBridgeBinary(
  input: Readonly<{
    host: SnapshotSourceHost;
    runtime: string;
    limits: SnapshotSourceLimits;
    deadline: SnapshotSourceDeadline;
    sourceRoot?: string;
    cacheRoot?: string;
  }>,
): Promise<SnapshotSourceBridgeBinary> {
  const deadline = input.deadline;
  const sourceRoot = input.sourceRoot ?? resolveSnapshotBridgeSourceRoot(input.host);
  const sourceHash = await fingerprintSnapshotBridgeSource(input.host, sourceRoot, deadline);
  const toolchain = await readSnapshotSourceToolchain(input.host, input.runtime, deadline);
  const cacheKey = hashJson({
    schemaVersion: CACHE_SCHEMA_VERSION,
    protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
    sourceVersion: SNAPSHOT_SOURCE_VERSION,
    sourceHash,
    toolchain,
  });
  const cacheRoot =
    input.cacheRoot ?? path.join(input.host.homeDirectory(), '.agent-device', 'snapshot-source');
  const entryPath = path.join(cacheRoot, cacheKey);
  const releaseLock = await input.host.acquireLock(path.join(cacheRoot, `${cacheKey}.lock`), {
    deadline,
  });
  try {
    const cached = await readValidCache(
      input.host,
      entryPath,
      {
        sourceHash,
        cacheKey,
        toolchain,
      },
      deadline,
    );
    if (cached) return cached;
    remainingSnapshotSourceMs(deadline, 'native-build-deadline');
    if (input.host.exists(entryPath)) await input.host.remove(entryPath);

    remainingSnapshotSourceMs(deadline, 'native-build-deadline');
    await input.host.ensureDirectory(cacheRoot);
    const temporaryPath = path.join(cacheRoot, `.${cacheKey}.${input.host.processId()}.tmp`);
    remainingSnapshotSourceMs(deadline, 'native-build-deadline');
    await input.host.remove(temporaryPath);
    try {
      remainingSnapshotSourceMs(deadline, 'native-build-deadline');
      await input.host.ensureDirectory(temporaryPath);
      const outputPath = path.join(temporaryPath, BRIDGE_FILENAME);
      const result = await input.host.run(
        'xcrun',
        [
          '--sdk',
          'iphonesimulator',
          'clang',
          '-arch',
          toolchain.architecture,
          '-mios-simulator-version-min=15.0',
          '-fobjc-arc',
          '-Werror',
          '-Wall',
          '-Wextra',
          '-framework',
          'Foundation',
          '-framework',
          'CoreGraphics',
          ...SNAPSHOT_BRIDGE_COMPILE_FILENAMES.map((sourceFile) =>
            path.join(sourceRoot, sourceFile),
          ),
          '-o',
          outputPath,
        ],
        {
          signal: deadline.signal,
          timeoutMs: Math.min(
            BUILD_TIMEOUT_MS,
            remainingSnapshotSourceMs(deadline, 'native-build-deadline'),
          ),
          allowFailure: true,
        },
      );
      if (result.exitCode !== 0 || !input.host.exists(outputPath)) {
        throw snapshotSourceError('unsupported', 'native-build-failed', {
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 4096),
        });
      }
      remainingSnapshotSourceMs(deadline, 'native-build-deadline');
      await input.host.chmod(outputPath, 0o755);
      const binarySha256 = await sha256File(input.host, outputPath, deadline);
      const manifest: SnapshotBridgeCacheManifest = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
        sourceVersion: SNAPSHOT_SOURCE_VERSION,
        sourceHash,
        cacheKey,
        toolchain,
        binarySha256,
      };
      await input.host.writeText(
        path.join(temporaryPath, MANIFEST_FILENAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      remainingSnapshotSourceMs(deadline, 'native-build-deadline');
      await input.host.rename(temporaryPath, entryPath);
      return {
        path: path.join(entryPath, BRIDGE_FILENAME),
        sourceHash,
        cacheKey,
        protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
        sourceVersion: SNAPSHOT_SOURCE_VERSION,
      };
    } catch (error) {
      await input.host.remove(temporaryPath);
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

function resolveSnapshotBridgeSourceRoot(host: SnapshotSourceHost): string {
  const projectRoot = host.projectRoot();
  const checkoutRoot = path.join(projectRoot, 'apple', 'snapshot-bridge');
  if (
    SNAPSHOT_BRIDGE_SOURCE_FILENAMES.every((sourceFile) =>
      host.exists(path.join(checkoutRoot, sourceFile)),
    )
  ) {
    return checkoutRoot;
  }
  const packagedRoot = path.join(projectRoot, 'dist', 'apple', 'snapshot-bridge');
  if (
    SNAPSHOT_BRIDGE_SOURCE_FILENAMES.every((sourceFile) =>
      host.exists(path.join(packagedRoot, sourceFile)),
    )
  ) {
    return packagedRoot;
  }
  throw snapshotSourceError('unsupported', 'native-source-missing', { projectRoot });
}

// fallow-ignore-next-line complexity
async function readValidCache(
  host: SnapshotSourceHost,
  entryPath: string,
  expected: Readonly<{
    sourceHash: string;
    cacheKey: string;
    toolchain: SnapshotSourceToolchainIdentity;
  }>,
  deadline: SnapshotSourceDeadline,
): Promise<SnapshotSourceBridgeBinary | undefined> {
  const binaryPath = path.join(entryPath, BRIDGE_FILENAME);
  if (!host.exists(binaryPath) || !host.exists(path.join(entryPath, MANIFEST_FILENAME))) {
    return undefined;
  }
  try {
    const manifest = JSON.parse(
      await host.readText(path.join(entryPath, MANIFEST_FILENAME)),
    ) as Partial<SnapshotBridgeCacheManifest>;
    if (
      manifest.schemaVersion !== CACHE_SCHEMA_VERSION ||
      manifest.protocolVersion !== SNAPSHOT_SOURCE_PROTOCOL_VERSION ||
      manifest.sourceVersion !== SNAPSHOT_SOURCE_VERSION ||
      manifest.sourceHash !== expected.sourceHash ||
      manifest.cacheKey !== expected.cacheKey ||
      JSON.stringify(manifest.toolchain) !== JSON.stringify(expected.toolchain) ||
      typeof manifest.binarySha256 !== 'string'
    ) {
      return undefined;
    }
    if ((await sha256File(host, binaryPath, deadline)) !== manifest.binarySha256) return undefined;
    return {
      path: binaryPath,
      sourceHash: expected.sourceHash,
      cacheKey: expected.cacheKey,
      protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
      sourceVersion: SNAPSHOT_SOURCE_VERSION,
    };
  } catch (error) {
    if (
      error instanceof SnapshotSourceError &&
      (error.failureKind === 'cancelled' || error.failureKind === 'timeout')
    ) {
      throw error;
    }
    return undefined;
  }
}

async function sha256File(
  host: SnapshotSourceHost,
  filePath: string,
  deadline: SnapshotSourceDeadline,
): Promise<string> {
  remainingSnapshotSourceMs(deadline, 'native-cache-hash-deadline');
  return createHash('sha256')
    .update(await host.readBinary(filePath))
    .digest('hex');
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}
