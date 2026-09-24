import path from 'node:path';
import type { ExecResult } from '@agent-device/host-kit/command';
import { snapshotSourceError } from './errors.ts';
import type { SnapshotSourceDeadline } from './deadline.ts';
import {
  readSnapshotSourceToolchain,
  SNAPSHOT_BRIDGE_COMPILE_FILENAMES,
  SNAPSHOT_BRIDGE_SOURCE_FILENAMES,
  type SnapshotSourceToolchainIdentity,
} from './cache-identity.ts';
import {
  execNativeBuildClang,
  fingerprintNativeBuildSource,
  nativeBuildCacheKey,
  nativeBuildManifestFieldsMatch,
  ensureNativeBuildCacheEntry,
} from './native-build-cache.ts';
import { SNAPSHOT_SOURCE_PROTOCOL_VERSION, SNAPSHOT_SOURCE_VERSION } from './protocol.ts';
import type {
  SnapshotSourceBridgeBinary,
  SnapshotSourceHost,
  SnapshotSourceLimits,
} from './types.ts';

const CACHE_SCHEMA_VERSION = 1 as const;
const BRIDGE_FILENAME = 'snapshot-bridge';
const MANIFEST_FIELDS = [
  'schemaVersion',
  'protocolVersion',
  'sourceVersion',
  'sourceHash',
  'cacheKey',
  'toolchain',
] as const;

/**
 * @internal Upper bound on a single snapshot-bridge clang invocation, exposed for the host bridge
 * tests so they budget their own compile from the same ceiling instead of a stricter constant. The
 * live build also stays under the caller's snapshot-source deadline, which can bind tighter.
 */
export const BUILD_TIMEOUT_MS = 120_000;

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
  const sourceHash = await fingerprintNativeBuildSource(
    input.host,
    sourceRoot,
    SNAPSHOT_BRIDGE_SOURCE_FILENAMES,
    deadline,
  );
  const toolchain = await readSnapshotSourceToolchain(input.host, input.runtime, deadline);
  const cacheKey = nativeBuildCacheKey({
    schemaVersion: CACHE_SCHEMA_VERSION,
    protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
    sourceVersion: SNAPSHOT_SOURCE_VERSION,
    sourceHash,
    toolchain,
  });
  const cacheRoot =
    input.cacheRoot ?? path.join(input.host.homeDirectory(), '.agent-device', 'snapshot-source');
  const manifest = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
    sourceVersion: SNAPSHOT_SOURCE_VERSION,
    sourceHash,
    cacheKey,
    toolchain,
  };
  const entry = await ensureNativeBuildCacheEntry({
    host: input.host,
    deadline,
    cacheRoot,
    cacheKey,
    binaryFilename: BRIDGE_FILENAME,
    manifest,
    manifestMatches: (candidate) =>
      nativeBuildManifestFieldsMatch(candidate, manifest, MANIFEST_FIELDS),
    build: async (outputPath) => {
      const result = await compileSnapshotBridge(
        input.host,
        deadline,
        toolchain.architecture,
        sourceRoot,
        outputPath,
      );
      if (result.exitCode !== 0 || !input.host.exists(outputPath)) {
        throw snapshotSourceError('unsupported', 'native-build-failed', {
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 4096),
        });
      }
    },
  });
  return {
    path: entry.path,
    sourceHash,
    cacheKey,
    protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
    sourceVersion: SNAPSHOT_SOURCE_VERSION,
  };
}

/**
 * One clang invocation for the bridge sources. A compile exec this module asked to be killed is
 * reported with the budget it hit: after the identity read stopped opening `xcrun` of its own
 * (#2712), this is the process's first `xcrun` exec, and the exec layer's bare
 * `xcrun timed out after Nms` would land on a job as an unattributed command failure again.
 */
async function compileSnapshotBridge(
  host: SnapshotSourceHost,
  deadline: SnapshotSourceDeadline,
  architecture: SnapshotSourceToolchainIdentity['architecture'],
  sourceRoot: string,
  outputPath: string,
): Promise<ExecResult> {
  return execNativeBuildClang({
    host,
    deadline,
    argv: [
      '--sdk',
      'iphonesimulator',
      'clang',
      '-arch',
      architecture,
      '-mios-simulator-version-min=15.0',
      '-fobjc-arc',
      '-Werror',
      '-Wall',
      '-Wextra',
      '-framework',
      'Foundation',
      '-framework',
      'CoreGraphics',
      ...SNAPSHOT_BRIDGE_COMPILE_FILENAMES.map((sourceFile) => path.join(sourceRoot, sourceFile)),
      '-o',
      outputPath,
    ],
    budgetMs: BUILD_TIMEOUT_MS,
    deadlineReason: 'native-build-deadline',
    label: 'bridge',
  });
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
