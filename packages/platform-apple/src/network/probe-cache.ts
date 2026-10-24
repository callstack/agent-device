import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '@agent-device/host-kit/command';
import { hostHomeDirectory } from '@agent-device/host-kit/host-file';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { runAppleToolCommand } from '../core/tool-provider.ts';
import { createNativeBuildDeadline, type NativeBuildDeadline } from '../native-build/deadline.ts';
import { NativeBuildError } from '../native-build/errors.ts';
import { createNativeBuildHost, type NativeBuildHost } from '../native-build/host.ts';
import { readHostToolchainIdentity } from '../native-build/toolchain-identity.ts';
import {
  ensureNativeBuildCacheEntry,
  execNativeBuildClang,
  fingerprintNativeBuildSource,
} from '../native-build/cache.ts';

const PROBE_SOURCE_FILENAME = 'ADNetworkCapture.m';
const PROBE_BINARY_FILENAME = 'ADNetworkCapture.dylib';
const PROBE_SCHEMA_VERSION = 1 as const;
const PROBE_LOCK_DESCRIPTION = 'iOS Simulator network capture probe cache';
const PROBE_BUILD_HINT =
  'Select an Xcode with the iOS simulator SDK using DEVELOPER_DIR, or open the session without network capture.';

/** Upper bound on a single probe clang invocation. The probe is one small translation unit. */
export const NETWORK_PROBE_BUILD_TIMEOUT_MS = 30_000;

/** Ceiling on locating, fingerprinting and (if needed) building a cached probe binary. */
const NETWORK_PROBE_PREPARATION_DEADLINE_MS = NETWORK_PROBE_BUILD_TIMEOUT_MS + 15_000;

/**
 * The capture probe binary for the host's active toolchain, building and caching it on the first
 * simulator launch that asks for network capture. Shares the fold helper's content+toolchain-keyed
 * build cache (`native-build/cache.ts`), so a later launch serves the cached binary and a
 * `DEVELOPER_DIR` switch rebuilds instead of serving a binary compiled against another SDK.
 *
 * Build and cache failures surface as `AppError('COMMAND_FAILED', ..., {reason:
 * 'network-capture-probe-build-failed'})` with the underlying failure's details, so the caller
 * decides whether a launch fails or proceeds without capture.
 */
export async function ensureNetworkCaptureProbe(
  input: Readonly<{
    signal?: AbortSignal;
    host?: NativeBuildHost;
    cacheRoot?: string;
    sourceRoot?: string;
  }> = {},
): Promise<Readonly<{ path: string }>> {
  const host = input.host ?? createNativeBuildHost(runAppleToolCommand);
  const deadline = createNativeBuildDeadline(NETWORK_PROBE_PREPARATION_DEADLINE_MS, input.signal);
  try {
    const sourceRoot = input.sourceRoot ?? path.join(findProjectRoot(), 'apple', 'network-capture');
    const sourceHash = await fingerprintNativeBuildSource(
      host,
      sourceRoot,
      [PROBE_SOURCE_FILENAME],
      deadline,
    );
    const toolchain = await readHostToolchainIdentity(host, deadline);
    return await ensureNativeBuildCacheEntry({
      host,
      deadline,
      lockDescription: PROBE_LOCK_DESCRIPTION,
      cacheRoot: input.cacheRoot ?? defaultNetworkCaptureCacheRoot(),
      binaryFilename: PROBE_BINARY_FILENAME,
      keyInputs: {
        schemaVersion: PROBE_SCHEMA_VERSION,
        sourceHash,
        toolchain,
        // Placeholder paths keep the key independent of the install location and build directory.
        compileArgv: buildNetworkCaptureProbeCompileArgv({ sourceRoot: '', outputPath: '' }),
      },
      build: (outputPath) => compileNetworkCaptureProbe(host, deadline, sourceRoot, outputPath),
    });
  } catch (error) {
    throw asNetworkCaptureProbeError(error);
  }
}

/**
 * The production `xcrun`/clang argv for the probe source. Both simulator architectures are compiled
 * into one fat binary: the simulator runs an app in the host's own instruction set, so an arm64 Mac
 * needs the arm64 slice and an Intel Mac the x86_64 slice, and one artifact covers both.
 *
 * Exposed so a darwin-only conformance test can compile the source with `-Werror` appended, and a
 * unit test can assert the shipped argv never carries `-Werror` on its own (the same posture the
 * fold helper's argv keeps).
 */
export function buildNetworkCaptureProbeCompileArgv(
  input: Readonly<{ sourceRoot: string; outputPath: string }>,
): readonly string[] {
  return [
    '--sdk',
    'iphonesimulator',
    'clang',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-mios-simulator-version-min=15.0',
    '-dynamiclib',
    '-fobjc-arc',
    '-Wall',
    '-Wextra',
    '-framework',
    'Foundation',
    path.join(input.sourceRoot, PROBE_SOURCE_FILENAME),
    '-o',
    input.outputPath,
  ];
}

/** The daemon-wide probe cache root. */
function defaultNetworkCaptureCacheRoot(): string {
  return path.join(hostHomeDirectory(), '.agent-device', 'network-capture');
}

async function compileNetworkCaptureProbe(
  host: NativeBuildHost,
  deadline: NativeBuildDeadline,
  sourceRoot: string,
  outputPath: string,
): Promise<void> {
  const result = await execNativeBuildClang({
    host,
    deadline,
    argv: buildNetworkCaptureProbeCompileArgv({ sourceRoot, outputPath }),
    budgetMs: NETWORK_PROBE_BUILD_TIMEOUT_MS,
    label: 'network capture probe',
  });
  if (result.exitCode !== 0 || !host.exists(outputPath)) {
    throw networkCaptureProbeBuildFailed(execFailureDetails(result));
  }
}

/**
 * Rewraps a native-build cache failure as the probe's build error, keeping its hint and typed
 * details. A cancellation, and any error that is not a native-build failure (including the probe's
 * own `networkCaptureProbeBuildFailed`, already in its public shape), passes through unchanged.
 */
function asNetworkCaptureProbeError(error: unknown): unknown {
  if (!(error instanceof NativeBuildError) || error.buildFailureKind === 'cancelled') return error;
  return networkCaptureProbeBuildFailed(
    { ...error.buildDetails, cause: error.buildFailureCode },
    error,
  );
}

function networkCaptureProbeBuildFailed(
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
) {
  return new AppError(
    'COMMAND_FAILED',
    'Unable to build the iOS Simulator network capture probe',
    { hint: PROBE_BUILD_HINT, ...details, reason: 'network-capture-probe-build-failed' },
    cause,
  );
}
