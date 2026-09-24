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
const BRIDGE_LOCK_DESCRIPTION = 'iOS Simulator snapshot bridge cache';
const MANIFEST_FIELDS = [
  'schemaVersion',
  'protocolVersion',
  'sourceVersion',
  'sourceHash',
  'cacheKey',
  'toolchain',
  'compileArgv',
] as const;

/**
 * The bridge cache key, folding in the compile argv (built with placeholder `sourceRoot` and
 * `outputPath` values, which vary by install and by build and would otherwise make the key
 * unstable) alongside `sourceHash` and `toolchain`, so a change to a compiler flag or framework
 * list — covered by neither — cannot serve a binary built from a different command line (#2796
 * follow-up).
 */
export function snapshotBridgeCacheKey(
  input: Readonly<{
    sourceHash: string;
    toolchain: SnapshotSourceToolchainIdentity;
    compileArgv: readonly string[];
  }>,
): string {
  return nativeBuildCacheKey({
    schemaVersion: CACHE_SCHEMA_VERSION,
    protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
    sourceVersion: SNAPSHOT_SOURCE_VERSION,
    sourceHash: input.sourceHash,
    toolchain: input.toolchain,
    compileArgv: input.compileArgv,
  });
}

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
  const compileArgv = buildSnapshotBridgeCompileArgv({
    architecture: toolchain.architecture,
    sourceRoot: '',
    outputPath: '',
  });
  const cacheKey = snapshotBridgeCacheKey({ sourceHash, toolchain, compileArgv });
  const cacheRoot =
    input.cacheRoot ?? path.join(input.host.homeDirectory(), '.agent-device', 'snapshot-source');
  const manifest = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
    sourceVersion: SNAPSHOT_SOURCE_VERSION,
    sourceHash,
    cacheKey,
    toolchain,
    compileArgv,
  };
  const entry = await ensureNativeBuildCacheEntry({
    host: input.host,
    deadline,
    cacheRoot,
    cacheKey,
    binaryFilename: BRIDGE_FILENAME,
    lockDescription: BRIDGE_LOCK_DESCRIPTION,
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
 * The production `xcrun`/clang argv for the bridge sources, exposed so a darwin-only conformance
 * test can compile it with `-Werror` appended and a unit test can assert it never carries `-Werror`
 * on its own (#2796).
 */
export function buildSnapshotBridgeCompileArgv(
  input: Readonly<{
    architecture: SnapshotSourceToolchainIdentity['architecture'];
    sourceRoot: string;
    outputPath: string;
  }>,
): readonly string[] {
  return [
    '--sdk',
    'iphonesimulator',
    'clang',
    '-arch',
    input.architecture,
    '-mios-simulator-version-min=15.0',
    '-fobjc-arc',
    '-Wall',
    '-Wextra',
    '-framework',
    'Foundation',
    '-framework',
    'CoreGraphics',
    ...SNAPSHOT_BRIDGE_COMPILE_FILENAMES.map((sourceFile) =>
      path.join(input.sourceRoot, sourceFile),
    ),
    '-o',
    input.outputPath,
  ];
}

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
    argv: buildSnapshotBridgeCompileArgv({ architecture, sourceRoot, outputPath }),
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
