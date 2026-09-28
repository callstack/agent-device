import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import { findProjectRoot } from '@agent-device/host-kit/version';
import type { NativeBuildDeadline } from '../native-build/deadline.ts';
import type { NativeBuildHost } from '../native-build/host.ts';
import { execNativeBuildClang } from '../native-build/cache.ts';
import { ensureNativeHelperBinary } from '../native-build/helper-cache.ts';

const FOLD_HELPER_SOURCE_FILENAME = 'Fold.m';
const FOLD_HELPER_BINARY_FILENAME = 'fold-helper';
const FOLD_HELPER_SCHEMA_VERSION = 1 as const;
const FOLD_HELPER_LOCK_DESCRIPTION = 'iOS Simulator fold helper cache';
const FOLD_HELPER_BUILD_HINT =
  'Select an Xcode with the iOS simulator SDK and foldable HID support using DEVELOPER_DIR.';

/** Upper bound on a single fold-helper clang invocation; the same budget the prior per-call build used. */
export const FOLD_HELPER_BUILD_TIMEOUT_MS = 30_000;

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
  return await ensureNativeHelperBinary({
    ...input,
    resolveSourceRoot: () => path.join(findProjectRoot(), 'apple', 'fold-helper'),
    sourceFilenames: [FOLD_HELPER_SOURCE_FILENAME],
    cacheDirectory: 'fold-helper',
    schemaVersion: FOLD_HELPER_SCHEMA_VERSION,
    lockDescription: FOLD_HELPER_LOCK_DESCRIPTION,
    binaryFilename: FOLD_HELPER_BINARY_FILENAME,
    buildTimeoutMs: FOLD_HELPER_BUILD_TIMEOUT_MS,
    compileArgv: buildFoldHelperCompileArgv,
    build: ({ host, deadline, sourceRoot, outputPath }) =>
      compileFoldHelper(host, deadline, sourceRoot, outputPath),
    wrapFailure: (error) =>
      foldHelperBuildFailed({ ...error.buildDetails, cause: error.buildFailureCode }, error),
  });
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
function foldHelperBuildFailed(details: Readonly<Record<string, unknown>>, cause?: unknown) {
  return new AppError(
    'COMMAND_FAILED',
    'Unable to build the simulator fold helper',
    { hint: FOLD_HELPER_BUILD_HINT, ...details, reason: 'fold-helper-build-failed' },
    cause,
  );
}
