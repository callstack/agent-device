import path from 'node:path';
import { hostHomeDirectory } from '@agent-device/host-kit/host-file';
import { runAppleToolCommand } from '../core/tool-provider.ts';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../runner/apple-runner-platform.ts';
import { createNativeBuildDeadline, type NativeBuildDeadline } from './deadline.ts';
import { NativeBuildError } from './errors.ts';
import { createNativeBuildHost, type NativeBuildHost } from './host.ts';
import { readHostToolchainIdentity } from './toolchain-identity.ts';
import { ensureNativeBuildCacheEntry, fingerprintNativeBuildSource } from './cache.ts';

type NativeHelperBuildRequest = Readonly<{
  host: NativeBuildHost;
  deadline: NativeBuildDeadline;
  sourceRoot: string;
  outputPath: string;
}>;

/** Shared owner for helper source identity, toolchain fingerprinting, timeout, cache, and errors. */
export async function ensureNativeHelperBinary(
  input: Readonly<{
    signal?: AbortSignal;
    host?: NativeBuildHost;
    cacheRoot?: string;
    sourceRoot?: string;
    resolveSourceRoot: (host: NativeBuildHost) => string;
    sourceFilenames: readonly string[];
    cacheDirectory: string;
    schemaVersion: number;
    lockDescription: string;
    binaryFilename: string;
    buildTimeoutMs: number;
    compileArgv: (input: Readonly<{ sourceRoot: string; outputPath: string }>) => readonly string[];
    build: (request: NativeHelperBuildRequest) => Promise<void>;
    wrapFailure: (error: NativeBuildError) => unknown;
  }>,
): Promise<Readonly<{ path: string }>> {
  const host = input.host ?? createNativeBuildHost(runAppleToolCommand);
  const deadline = createNativeBuildDeadline(
    COLD_TOOLCHAIN_PROBE_TIMEOUT_MS + input.buildTimeoutMs,
    input.signal,
  );
  try {
    const sourceRoot = input.sourceRoot ?? input.resolveSourceRoot(host);
    const sourceHash = await fingerprintNativeBuildSource(
      host,
      sourceRoot,
      input.sourceFilenames,
      deadline,
    );
    const toolchain = await readHostToolchainIdentity(host, deadline);
    const cacheRoot =
      input.cacheRoot ?? path.join(hostHomeDirectory(), '.agent-device', input.cacheDirectory);
    return await ensureNativeBuildCacheEntry({
      host,
      deadline,
      lockDescription: input.lockDescription,
      cacheRoot,
      binaryFilename: input.binaryFilename,
      keyInputs: {
        schemaVersion: input.schemaVersion,
        sourceHash,
        toolchain,
        compileArgv: input.compileArgv({ sourceRoot: '', outputPath: '' }),
      },
      build: (outputPath) => input.build({ host, deadline, sourceRoot, outputPath }),
    });
  } catch (error) {
    if (!(error instanceof NativeBuildError) || error.buildFailureKind === 'cancelled') throw error;
    throw input.wrapFailure(error);
  }
}
