import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import { runAppleToolCommand } from '../core/tool-provider.ts';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../runner/apple-runner-platform.ts';
import {
  readHostToolchainIdentity,
  type HostToolchainIdentity,
} from '../snapshot-source/cache-identity.ts';
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
  nativeBuildCacheKey,
  nativeBuildManifestFieldsMatch,
} from '../snapshot-source/native-build-cache.ts';
import type { SnapshotSourceHost } from '../snapshot-source/types.ts';

const FOLD_HELPER_SOURCE_FILENAME = 'Fold.m';
const FOLD_HELPER_BINARY_FILENAME = 'fold-helper';
const FOLD_HELPER_SCHEMA_VERSION = 1 as const;
const FOLD_HELPER_LOCK_DESCRIPTION = 'iOS Simulator fold helper cache';
const MANIFEST_FIELDS = [
  'schemaVersion',
  'sourceHash',
  'cacheKey',
  'toolchain',
  'compileArgv',
] as const;

/**
 * The fold helper cache key, folding in the compile argv (fingerprinted with a placeholder
 * `sourceRoot` and `outputPath`) alongside `sourceHash` and `toolchain`, so a change to a compiler
 * flag or framework list cannot serve a binary built from a different command line (#2796
 * follow-up).
 */
export function foldHelperCacheKey(
  input: Readonly<{
    sourceHash: string;
    toolchain: HostToolchainIdentity;
    compileArgv: readonly string[];
  }>,
): string {
  return nativeBuildCacheKey({
    schemaVersion: FOLD_HELPER_SCHEMA_VERSION,
    sourceHash: input.sourceHash,
    toolchain: input.toolchain,
    compileArgv: input.compileArgv,
  });
}

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
 * Failures surface as `AppError('COMMAND_FAILED', ..., {reason: 'fold-helper-build-failed'})`, the
 * error shape `sendSimulatorFoldPose` reported before this cache existed.
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
    const compileArgv = buildFoldHelperCompileArgv({ sourceRoot: '', outputPath: '' });
    const cacheKey = foldHelperCacheKey({ sourceHash, toolchain, compileArgv });
    const cacheRoot =
      input.cacheRoot ?? path.join(host.homeDirectory(), '.agent-device', 'fold-helper');
    const manifest = {
      schemaVersion: FOLD_HELPER_SCHEMA_VERSION,
      sourceHash,
      cacheKey,
      toolchain,
      compileArgv,
    };
    return await ensureNativeBuildCacheEntry({
      host,
      deadline,
      lockDescription: FOLD_HELPER_LOCK_DESCRIPTION,
      cacheRoot,
      cacheKey,
      binaryFilename: FOLD_HELPER_BINARY_FILENAME,
      manifest,
      manifestMatches: (candidate) =>
        nativeBuildManifestFieldsMatch(candidate, manifest, MANIFEST_FIELDS),
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
    deadlineReason: 'fold-helper-build-deadline',
    label: 'fold helper',
  });
  if (result.exitCode !== 0 || !host.exists(outputPath)) {
    throw new AppError(
      'COMMAND_FAILED',
      'Unable to build the simulator fold helper',
      execFailureDetails(result, {
        reason: 'fold-helper-build-failed',
        hint: 'Select an Xcode with the iOS simulator SDK and foldable HID support using DEVELOPER_DIR.',
      }),
    );
  }
}

/**
 * `AppError('COMMAND_FAILED', ..., {reason: 'fold-helper-build-failed'})` for every cache failure,
 * matching the error `sendSimulatorFoldPose` reported before this cache existed, except a genuine
 * cancellation: `compileFoldHelper` already throws that exact shape on a build failure, so it
 * passes through unchanged.
 */
function asFoldHelperCacheError(error: unknown): unknown {
  if (!(error instanceof SnapshotSourceError)) return error;
  if (error.failureKind === 'cancelled') return error;
  return new AppError(
    'COMMAND_FAILED',
    'Unable to build the simulator fold helper',
    {
      reason: 'fold-helper-build-failed',
      hint: 'Select an Xcode with the iOS simulator SDK and foldable HID support using DEVELOPER_DIR.',
      cause: error.failureCode,
    },
    error,
  );
}
