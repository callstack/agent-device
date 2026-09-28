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

const SOURCE_FILENAME = 'WatchControl.m';
const BINARY_FILENAME = 'watch-control';
const SCHEMA_VERSION = 1 as const;
const LOCK_DESCRIPTION = 'watchOS Simulator control helper cache';
const BUILD_HINT =
  'Select an Xcode that provides CoreSimulator and SimulatorKit using DEVELOPER_DIR.';
export const WATCH_HELPER_BUILD_TIMEOUT_MS = 30_000;
const PREPARATION_DEADLINE_MS = COLD_TOOLCHAIN_PROBE_TIMEOUT_MS + WATCH_HELPER_BUILD_TIMEOUT_MS;

export async function ensureWatchHelperBinary(
  input: Readonly<{
    signal?: AbortSignal;
    host?: NativeBuildHost;
    cacheRoot?: string;
    sourceRoot?: string;
  }> = {},
): Promise<Readonly<{ path: string }>> {
  const host = input.host ?? createWatchHelperCacheHost();
  const deadline = createNativeBuildDeadline(PREPARATION_DEADLINE_MS, input.signal);
  try {
    const sourceRoot = input.sourceRoot ?? resolveWatchHelperSourceRoot(host);
    const sourceHash = await fingerprintNativeBuildSource(
      host,
      sourceRoot,
      [SOURCE_FILENAME],
      deadline,
    );
    const toolchain = await readHostToolchainIdentity(host, deadline);
    const cacheRoot =
      input.cacheRoot ?? path.join(hostHomeDirectory(), '.agent-device', 'watch-helper');
    return await ensureNativeBuildCacheEntry({
      host,
      deadline,
      lockDescription: LOCK_DESCRIPTION,
      cacheRoot,
      binaryFilename: BINARY_FILENAME,
      keyInputs: {
        schemaVersion: SCHEMA_VERSION,
        sourceHash,
        toolchain,
        compileArgv: buildWatchHelperCompileArgv({ sourceRoot: '', outputPath: '' }),
      },
      build: (outputPath) => compileWatchHelper(host, deadline, sourceRoot, outputPath),
    });
  } catch (error) {
    throw asWatchHelperCacheError(error);
  }
}

function createWatchHelperCacheHost(): NativeBuildHost {
  return createNativeBuildHost((command, args, options) =>
    runAppleToolCommand(command, args, options),
  );
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

function asWatchHelperCacheError(error: unknown): unknown {
  if (!(error instanceof NativeBuildError) || error.buildFailureKind === 'cancelled') return error;
  return watchHelperBuildFailed({ ...error.buildDetails, cause: error.buildFailureCode }, error);
}

function watchHelperBuildFailed(details: Readonly<Record<string, unknown>>, cause?: unknown) {
  return new AppError(
    'COMMAND_FAILED',
    'Unable to build the watchOS Simulator control helper',
    { hint: BUILD_HINT, ...details, reason: 'watch-helper-build-failed' },
    cause,
  );
}
