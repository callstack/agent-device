import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import { runAppleToolCommand } from '../core/tool-provider.ts';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../runner/apple-runner-platform.ts';
import { readHostToolchainIdentity } from '../snapshot-source/cache-identity.ts';
import {
  createSnapshotSourceDeadline,
  type SnapshotSourceDeadline,
} from '../snapshot-source/deadline.ts';
import { SnapshotSourceError } from '../snapshot-source/errors.ts';
import { createSnapshotSourceHost } from '../snapshot-source/host.ts';
import {
  ensureNativeBuildCacheEntry,
  execNativeBuildClang,
  fingerprintNativeBuildSource,
} from '../snapshot-source/native-build-cache.ts';
import type { SnapshotSourceHost } from '../snapshot-source/types.ts';

const FOLD_HELPER_SOURCE_FILENAME = 'Fold.m';
const FOLD_HELPER_BINARY_FILENAME = 'fold-helper';
const FOLD_HELPER_SCHEMA_VERSION = 1 as const;
const FOLD_HELPER_LOCK_DESCRIPTION = 'iOS Simulator fold helper cache';
const FOLD_HELPER_BUILD_HINT =
  'Select an Xcode with the iOS simulator SDK and foldable HID support using DEVELOPER_DIR.';

/** Upper bound on a single fold-helper clang invocation; the same budget the prior per-call build used. */
export const FOLD_HELPER_BUILD_TIMEOUT_MS = 30_000;

/** Ceiling on locating, probing and (if needed) building a cached fold-helper binary. */
const FOLD_HELPER_PREPARATION_DEADLINE_MS =
  COLD_TOOLCHAIN_PROBE_TIMEOUT_MS + FOLD_HELPER_BUILD_TIMEOUT_MS;

/**
 * The fold helper binary for the host's active toolchain, building and caching it if needed. Shares
 * the snapshot bridge's content+toolchain-keyed build cache (`native-build-cache.ts`), so a fold
 * call after the first serves a cached binary instead of recompiling `Fold.m`, and a `DEVELOPER_DIR`
 * switch busts the cache instead of serving a binary built against a different SDK (#2796).
 *
 * Build and cache failures surface as `AppError('COMMAND_FAILED', ..., {reason:
 * 'fold-helper-build-failed'})`, the error shape `sendSimulatorFoldPose` reported before this cache
 * existed, carrying the underlying failure's hint and details.
 */
export async function ensureFoldHelperBinary(
  input: Readonly<{
    signal?: AbortSignal;
    host?: SnapshotSourceHost;
    cacheRoot?: string;
    sourceRoot?: string;
  }> = {},
): Promise<Readonly<{ path: string }>> {
  const host = input.host ?? createFoldHelperCacheHost();
  const deadline = createSnapshotSourceDeadline(FOLD_HELPER_PREPARATION_DEADLINE_MS, input.signal);
  try {
    const sourceRoot = input.sourceRoot ?? path.join(host.projectRoot(), 'apple', 'fold-helper');
    const sourceHash = await fingerprintNativeBuildSource(
      host,
      sourceRoot,
      [FOLD_HELPER_SOURCE_FILENAME],
      deadline,
    );
    const toolchain = await readHostToolchainIdentity(host, deadline);
    const cacheRoot =
      input.cacheRoot ?? path.join(host.homeDirectory(), '.agent-device', 'fold-helper');
    return await ensureNativeBuildCacheEntry({
      host,
      deadline,
      lockDescription: FOLD_HELPER_LOCK_DESCRIPTION,
      cacheRoot,
      binaryFilename: FOLD_HELPER_BINARY_FILENAME,
      keyInputs: {
        schemaVersion: FOLD_HELPER_SCHEMA_VERSION,
        sourceHash,
        toolchain,
        // Placeholder paths keep the key independent of the install location and build directory.
        compileArgv: buildFoldHelperCompileArgv({ sourceRoot: '', outputPath: '' }),
      },
      build: (outputPath) => compileFoldHelper(host, deadline, sourceRoot, outputPath),
    });
  } catch (error) {
    throw asFoldHelperCacheError(error);
  }
}

function createFoldHelperCacheHost(): SnapshotSourceHost {
  const real = createSnapshotSourceHost();
  return {
    ...real,
    // Routed through the Apple tool-provider scope, not `run`'s default `runCmd`, so a fold test
    // can fake every exec this cache makes the same way it fakes the simctl dispatch (#2796).
    run: (command, args, options) => runAppleToolCommand(command, args, options),
  };
}

/**
 * The production `xcrun`/clang argv for the fold helper source, exposed so a darwin-only
 * conformance test can compile it with `-Werror` appended and a unit test can assert it never
 * carries `-Werror` on its own (#2796).
 */
export function buildFoldHelperCompileArgv(
  input: Readonly<{ sourceRoot: string; outputPath: string }>,
): readonly string[] {
  return [
    '--sdk',
    'iphonesimulator',
    'clang',
    '-mios-simulator-version-min=15.0',
    '-fobjc-arc',
    '-Wall',
    '-Wextra',
    '-framework',
    'Foundation',
    '-framework',
    'IOKit',
    path.join(input.sourceRoot, FOLD_HELPER_SOURCE_FILENAME),
    '-o',
    input.outputPath,
  ];
}

async function compileFoldHelper(
  host: SnapshotSourceHost,
  deadline: SnapshotSourceDeadline,
  sourceRoot: string,
  outputPath: string,
): Promise<void> {
  const result = await execNativeBuildClang({
    host,
    deadline,
    argv: buildFoldHelperCompileArgv({ sourceRoot, outputPath }),
    budgetMs: FOLD_HELPER_BUILD_TIMEOUT_MS,
    label: 'fold helper',
  });
  if (result.exitCode !== 0 || !host.exists(outputPath)) {
    throw foldHelperBuildFailed(execFailureDetails(result));
  }
}

/**
 * Rewraps a cache failure as the fold helper's build error, keeping its hint and typed details; a
 * cancellation, and any error that is not a snapshot-source failure, passes through unchanged.
 */
function asFoldHelperCacheError(error: unknown): unknown {
  if (!(error instanceof SnapshotSourceError) || error.failureKind === 'cancelled') return error;
  const { bridgeFailure: _kind, bridgeFailureCode: cause, ...details } = error.details ?? {};
  return foldHelperBuildFailed({ ...details, cause }, error);
}

function foldHelperBuildFailed(details: Readonly<Record<string, unknown>>, cause?: unknown) {
  return new AppError(
    'COMMAND_FAILED',
    'Unable to build the simulator fold helper',
    { hint: FOLD_HELPER_BUILD_HINT, ...details, reason: 'fold-helper-build-failed' },
    cause,
  );
}
