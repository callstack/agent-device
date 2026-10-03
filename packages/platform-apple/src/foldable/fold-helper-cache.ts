import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import { hostHomeDirectory } from '@agent-device/host-kit/host-file';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { runAppleToolCommand } from '../core/tool-provider.ts';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../runner/apple-runner-platform.ts';
import { createNativeBuildDeadline, type NativeBuildDeadline } from '../native-build/deadline.ts';
import { NativeBuildError } from '../native-build/errors.ts';
import { createNativeBuildHost, type NativeBuildHost } from '../native-build/host.ts';
import { readHostToolchainIdentity } from '../native-build/toolchain-identity.ts';
import {
  ensureNativeBuildCacheEntry,
  execNativeBuildClang,
  fingerprintNativeBuildSource,
} from '../native-build/cache.ts';

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
 * the snapshot bridge's content+toolchain-keyed build cache (`native-build/cache.ts`), so a fold
 * call after the first serves a cached binary instead of recompiling `Fold.m`, and a `DEVELOPER_DIR`
 * switch busts the cache instead of serving a binary built against a different SDK (#2796, #2970).
 *
 * Build and cache failures surface as `AppError('COMMAND_FAILED', ..., {reason:
 * 'fold-helper-build-failed'})`, the error shape `sendSimulatorFoldPose` reported before this cache
 * existed, carrying the underlying failure's hint and details.
 */
export async function ensureFoldHelperBinary(
  input: Readonly<{
    signal?: AbortSignal;
    host?: NativeBuildHost;
    cacheRoot?: string;
    sourceRoot?: string;
  }> = {},
): Promise<Readonly<{ path: string }>> {
  const host = input.host ?? createFoldHelperCacheHost();
  const deadline = createNativeBuildDeadline(FOLD_HELPER_PREPARATION_DEADLINE_MS, input.signal);
  try {
    const sourceRoot = input.sourceRoot ?? path.join(findProjectRoot(), 'apple', 'fold-helper');
    const sourceHash = await fingerprintNativeBuildSource(
      host,
      sourceRoot,
      [FOLD_HELPER_SOURCE_FILENAME],
      deadline,
    );
    const toolchain = await readHostToolchainIdentity(host, deadline);
    const cacheRoot =
      input.cacheRoot ?? path.join(hostHomeDirectory(), '.agent-device', 'fold-helper');
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

function createFoldHelperCacheHost(): NativeBuildHost {
  // Routed through the Apple tool-provider scope, not `run`'s default `runCmd`, so a fold test can
  // fake every exec this cache makes the same way it fakes the simctl dispatch (#2796). A narrow
  // build host, not the full snapshot-bridge host: compilation needs no bridge socket and no
  // target-process inspection (#2970).
  return createNativeBuildHost(runAppleToolCommand);
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
  host: NativeBuildHost,
  deadline: NativeBuildDeadline,
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
 * Rewraps a native-build cache failure as the fold helper's build error, keeping its hint and typed
 * details; a cancellation, and any error that is not a native-build failure (including the fold
 * helper's own `foldHelperBuildFailed`, already in its public shape), passes through unchanged.
 */
function asFoldHelperCacheError(error: unknown): unknown {
  if (!(error instanceof NativeBuildError) || error.buildFailureKind === 'cancelled') return error;
  return foldHelperBuildFailed({ ...error.buildDetails, cause: error.buildFailureCode }, error);
}

function foldHelperBuildFailed(details: Readonly<Record<string, unknown>>, cause?: unknown) {
  return new AppError(
    'COMMAND_FAILED',
    'Unable to build the simulator fold helper',
    { hint: FOLD_HELPER_BUILD_HINT, ...details, reason: 'fold-helper-build-failed' },
    cause,
  );
}
