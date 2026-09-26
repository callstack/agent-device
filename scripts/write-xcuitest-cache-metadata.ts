#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunnerXctestrunCacheMetadata } from '@agent-device/platform-apple/runner/operations';
import {
  findRunnerXctestrun,
  isRunnerXcuitestScriptPlatform,
  requireCertifiedRunnerCacheArtifacts,
  requireRunnerBuildSettingsMatchBuildLog,
  resolveExistingRunnerProductPaths,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerScriptDevice,
  writeRunnerCacheMetadataForArtifacts,
} from '@agent-device/platform-apple/runner/operations';

const USAGE =
  'Usage: write-xcuitest-cache-metadata.ts <ios|macos|tvos|visionos> <derived> <destination> <build-log>';

/**
 * Publishes the cache metadata for a `scripts/build-xcuitest-apple.sh` build. The identity half
 * resolves through the same owner the daemon uses; the recorded recipe is then checked against
 * what `xcodebuild` echoed in the build log, so a script that drifted from that identity cannot
 * have its products certified. The artifact half digests the bytes on disk now, after the
 * isolation scan succeeded, so a manifest exists exactly for builds that passed the scan.
 */
type WriterInvocation = {
  device: ReturnType<typeof resolveRunnerScriptDevice>;
  derivedPath: string;
  buildLogPath: string;
};

// fallow-ignore-next-line complexity
function parseWriterInvocation(args: readonly string[]): WriterInvocation {
  const [platform, derivedPath, destination, buildLogPath] = args;
  if (!platform || !derivedPath || !destination || !buildLogPath) {
    throw new Error(USAGE);
  }
  if (!isRunnerXcuitestScriptPlatform(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  return {
    device: resolveRunnerScriptDevice(platform, destination),
    derivedPath: path.resolve(derivedPath),
    buildLogPath: path.resolve(buildLogPath),
  };
}

async function writeXcuitestCacheMetadata(
  args: readonly string[],
  cwd: string,
): Promise<RunnerXctestrunCacheMetadata> {
  const { device, derivedPath, buildLogPath } = parseWriterInvocation(args);
  const metadata = resolveExpectedRunnerCacheMetadata(device, cwd);
  requireRunnerBuildSettingsMatchBuildLog(metadata, buildLogPath);

  const xctestrunPath = findRunnerXctestrun(derivedPath, device);
  if (!xctestrunPath) {
    throw new Error(`No .xctestrun found under ${derivedPath}`);
  }
  const productPaths = await resolveExistingRunnerProductPaths(xctestrunPath);
  if (!productPaths || productPaths.length === 0) {
    throw new Error(`Runner products referenced by ${xctestrunPath} are missing`);
  }
  requireCertifiedRunnerCacheArtifacts(
    await writeRunnerCacheMetadataForArtifacts(derivedPath, metadata, xctestrunPath, productPaths),
    derivedPath,
  );
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await writeXcuitestCacheMetadata(process.argv.slice(2), process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
