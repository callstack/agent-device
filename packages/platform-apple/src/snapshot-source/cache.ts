import path from 'node:path';
import { snapshotSourceError } from './errors.ts';
import type { SnapshotSourceDeadline } from './deadline.ts';
import {
  readSnapshotSourceToolchain,
  SNAPSHOT_BRIDGE_COMPILE_FILENAMES,
  SNAPSHOT_BRIDGE_SOURCE_FILENAMES,
  type SnapshotSourceToolchainIdentity,
} from './cache-identity.ts';
import {
  ensureNativeBuildCacheEntry,
  execNativeBuildClang,
  fingerprintNativeBuildSource,
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
  const cacheRoot =
    input.cacheRoot ?? path.join(input.host.homeDirectory(), '.agent-device', 'snapshot-source');
  const entry = await ensureNativeBuildCacheEntry({
    host: input.host,
    deadline,
    cacheRoot,
    binaryFilename: BRIDGE_FILENAME,
    lockDescription: BRIDGE_LOCK_DESCRIPTION,
    keyInputs: {
      schemaVersion: CACHE_SCHEMA_VERSION,
      protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
      sourceVersion: SNAPSHOT_SOURCE_VERSION,
      sourceHash,
      toolchain,
      // Placeholder paths keep the key independent of the install location and build directory.
      compileArgv: buildSnapshotBridgeCompileArgv({
        architecture: toolchain.architecture,
        sourceRoot: '',
        outputPath: '',
      }),
    },
    build: async (outputPath) => {
      const result = await execNativeBuildClang({
        host: input.host,
        deadline,
        argv: buildSnapshotBridgeCompileArgv({
          architecture: toolchain.architecture,
          sourceRoot,
          outputPath,
        }),
        budgetMs: BUILD_TIMEOUT_MS,
        label: 'bridge',
      });
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
    cacheKey: entry.cacheKey,
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
