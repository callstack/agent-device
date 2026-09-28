import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import { findProjectRoot } from '@agent-device/host-kit/version';
import type { NativeBuildDeadline } from '../native-build/deadline.ts';
import { type NativeBuildHost } from '../native-build/host.ts';
import { execNativeBuildClang } from '../native-build/cache.ts';
import { ensureNativeHelperBinary } from '../native-build/helper-cache.ts';

const SOURCE_FILENAME = 'WatchControl.m';
const BINARY_FILENAME = 'watch-control';
const SCHEMA_VERSION = 1 as const;
const LOCK_DESCRIPTION = 'watchOS Simulator control helper cache';
const BUILD_HINT =
  'Select an Xcode that provides CoreSimulator and SimulatorKit using DEVELOPER_DIR.';
export const WATCH_HELPER_BUILD_TIMEOUT_MS = 30_000;

export async function ensureWatchHelperBinary(
  input: Readonly<{
    signal?: AbortSignal;
    host?: NativeBuildHost;
    cacheRoot?: string;
    sourceRoot?: string;
  }> = {},
): Promise<Readonly<{ path: string }>> {
  return await ensureNativeHelperBinary({
    ...input,
    resolveSourceRoot: resolveWatchHelperSourceRoot,
    sourceFilenames: [SOURCE_FILENAME],
    cacheDirectory: 'watch-helper',
    schemaVersion: SCHEMA_VERSION,
    lockDescription: LOCK_DESCRIPTION,
    binaryFilename: BINARY_FILENAME,
    buildTimeoutMs: WATCH_HELPER_BUILD_TIMEOUT_MS,
    compileArgv: buildWatchHelperCompileArgv,
    build: ({ host, deadline, sourceRoot, outputPath }) =>
      compileWatchHelper(host, deadline, sourceRoot, outputPath),
    wrapFailure: (error) =>
      watchHelperBuildFailed({ ...error.buildDetails, cause: error.buildFailureCode }, error),
  });
}

function resolveWatchHelperSourceRoot(host: NativeBuildHost): string {
  const projectRoot = findProjectRoot();
  const checkoutRoot = path.join(projectRoot, 'apple', 'watch-helper');
  if (host.exists(path.join(checkoutRoot, SOURCE_FILENAME))) return checkoutRoot;
  const packagedRoot = path.join(projectRoot, 'dist', 'apple', 'watch-helper');
  if (host.exists(path.join(packagedRoot, SOURCE_FILENAME))) return packagedRoot;
  throw watchHelperBuildFailed({ reason: 'watch-helper-source-missing', projectRoot });
}

export function buildWatchHelperCompileArgv(
  input: Readonly<{ sourceRoot: string; outputPath: string }>,
): readonly string[] {
  return [
    '--sdk',
    'macosx',
    'clang',
    '-fobjc-arc',
    '-fblocks',
    '-Wall',
    '-Wextra',
    '-framework',
    'Foundation',
    '-framework',
    'CoreGraphics',
    path.join(input.sourceRoot, SOURCE_FILENAME),
    '-o',
    input.outputPath,
  ];
}

async function compileWatchHelper(
  host: NativeBuildHost,
  deadline: NativeBuildDeadline,
  sourceRoot: string,
  outputPath: string,
): Promise<void> {
  const result = await execNativeBuildClang({
    host,
    deadline,
    argv: buildWatchHelperCompileArgv({ sourceRoot, outputPath }),
    budgetMs: WATCH_HELPER_BUILD_TIMEOUT_MS,
    label: 'watch helper',
  });
  if (result.exitCode !== 0 || !host.exists(outputPath)) {
    throw watchHelperBuildFailed(execFailureDetails(result));
  }
}

function watchHelperBuildFailed(details: Readonly<Record<string, unknown>>, cause?: unknown) {
  return new AppError(
    'COMMAND_FAILED',
    'Unable to build the watchOS Simulator control helper',
    { hint: BUILD_HINT, ...details, reason: 'watch-helper-build-failed' },
    cause,
  );
}
