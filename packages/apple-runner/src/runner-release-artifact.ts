import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveRunnerDerivedOverride } from './apple-runner-platform.ts';
import type { RunnerXctestrunArtifact } from './runner-artifact.ts';
import {
  emitRunnerXctestrunDecision,
  requireCertifiedRunnerCacheArtifacts,
  writeRunnerCacheMetadataForArtifacts,
} from './runner-cache.ts';
import type { RunnerXctestrunCacheMetadata } from './runner-cache-metadata.ts';
import {
  resolveRunnerCacheKey,
  resolveRunnerBundleBuildSettings,
  resolveRunnerSandboxBuildArgs,
} from './runner-cache-metadata.ts';
import {
  emitDiagnostic,
  hasScopedAppleToolProvider,
  hostEnvironment,
  extractRunnerReleaseArchive,
  isRecord,
  readHostCpuArchSync,
} from './host.ts';
import { requireRunnerPhaseRemainingMs, type RunnerPhaseBudget } from './runner-phase-budget.ts';
import { resolveExistingXctestrunProductPaths } from './runner-xctestrun-products.ts';

const RELEASE_FETCH_TIMEOUT_MS = 2500;
const MANIFEST_MAX_BYTES = 4096;
const ARCHIVE_MAX_BYTES = 12 * 1024 * 1024;

function acceptsRelease(metadata: RunnerXctestrunCacheMetadata): boolean {
  return (
    metadata.deviceKind === 'simulator' &&
    metadata.sdkName === 'iphonesimulator' &&
    /^27(?:\.|$)/.test(metadata.xcodeVersion) &&
    /^\d+\.\d+\.\d+$/.test(metadata.packageVersion) &&
    JSON.stringify(metadata.runnerBundleBuildSettings) ===
      JSON.stringify(resolveRunnerBundleBuildSettings({})) &&
    JSON.stringify(metadata.runnerSandboxBuildArgs) ===
      JSON.stringify(resolveRunnerSandboxBuildArgs({})) &&
    metadata.runnerArchBuildSettings.every((arg) => arg === 'ARCHS=arm64') &&
    readHostCpuArchSync() === 'arm64'
  );
}

async function fetchReleaseFile(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Apple runner release file exceeds its size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function readMatchingManifest(data: Buffer, expected: RunnerXctestrunCacheMetadata) {
  const manifest: unknown = JSON.parse(data.toString('utf8'));
  if (
    !isRecord(manifest) ||
    manifest.version !== expected.packageVersion ||
    manifest.xcodeVersion !== expected.xcodeVersion ||
    manifest.xcodeBuildVersion !== expected.xcodeBuildVersion ||
    manifest.sdkName !== expected.sdkName ||
    manifest.sdkVersion !== expected.sdkVersion ||
    manifest.sdkBuildVersion !== expected.sdkBuildVersion ||
    typeof manifest.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    typeof manifest.xctestrun !== 'string' ||
    !/^[\w-][\w.-]*\.xctestrun$/.test(manifest.xctestrun)
  ) {
    return null;
  }
  return { sha256: manifest.sha256, xctestrun: manifest.xctestrun };
}

/** Stages a complete release product set under the caller's existing runner cache lock. */
async function stageRunnerReleaseArtifact(
  derived: string,
  expected: RunnerXctestrunCacheMetadata,
  budget: RunnerPhaseBudget | undefined,
): Promise<{ directory: string; xctestrunPath: string; productPaths: string[] } | null> {
  if (!acceptsRelease(expected)) return null;
  const remaining = requireRunnerPhaseRemainingMs(budget, 'runner_release_lookup');
  const timeout = AbortSignal.timeout(Math.min(RELEASE_FETCH_TIMEOUT_MS, remaining ?? Infinity));
  const signal = budget?.signal ? AbortSignal.any([budget.signal, timeout]) : timeout;
  const version = expected.packageVersion;
  const base = `https://github.com/callstack/agent-device/releases/download/v${version}/agent-device-ios-local-runner-${version}`;
  let download: string | undefined;
  let directory: string | undefined;
  let staged = false;
  try {
    const data = await fetchReleaseFile(`${base}.manifest.json`, MANIFEST_MAX_BYTES, signal);
    const manifest = data && readMatchingManifest(data, expected);
    if (!manifest) return null;
    const archive = await fetchReleaseFile(`${base}.tar.gz`, ARCHIVE_MAX_BYTES, signal);
    if (!archive) return null;
    if (createHash('sha256').update(archive).digest('hex') !== manifest.sha256) {
      throw new Error('Apple runner release checksum mismatch');
    }

    const build = path.join(derived, 'Build');
    await fs.mkdir(build, { recursive: true });
    download = await fs.mkdtemp(path.join(build, 'ReleaseProducts-'));
    const archivePath = path.join(download, 'release.tar.gz');
    directory = `${download}-launch`;
    await fs.writeFile(archivePath, archive, { mode: 0o600, signal });
    await extractRunnerReleaseArchive({ archivePath, outputRoot: directory, signal });
    const xctestrunPath = path.join(directory, manifest.xctestrun);
    const productPaths = await resolveExistingXctestrunProductPaths(xctestrunPath, true);
    if (!productPaths?.length)
      throw new Error('Apple runner release is missing its launch products');
    signal.throwIfAborted();
    staged = true;
    return { directory, xctestrunPath, productPaths };
  } catch (error) {
    budget?.signal?.throwIfAborted();
    emitDiagnostic({
      level: 'warn',
      phase: 'runner_release_unavailable',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
    return null;
  } finally {
    if (download) await fs.rm(download, { recursive: true, force: true });
    if (directory && !staged) await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function resolveReleasedXctestrunArtifact(params: {
  derived: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  options: { budget?: RunnerPhaseBudget };
  assertAdmitted: () => void;
}): Promise<RunnerXctestrunArtifact | null> {
  const { derived, expectedCacheMetadata, options, assertAdmitted } = params;
  if (resolveRunnerDerivedOverride(hostEnvironment().env) || hasScopedAppleToolProvider())
    return null;
  const { budget } = options;
  assertAdmitted();
  const staged = await stageRunnerReleaseArtifact(derived, expectedCacheMetadata, budget);
  if (!staged) return null;
  const { directory, xctestrunPath, productPaths } = staged;
  try {
    assertAdmitted();
    budget?.signal?.throwIfAborted();
    requireCertifiedRunnerCacheArtifacts(
      await writeRunnerCacheMetadataForArtifacts(
        derived,
        expectedCacheMetadata,
        xctestrunPath,
        productPaths,
      ),
      derived,
    );
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  emitRunnerXctestrunDecision('reuse', 'release_artifact', { derived, xctestrunPath });
  return {
    xctestrunPath,
    derived,
    cache: 'miss',
    cacheKey: resolveRunnerCacheKey(expectedCacheMetadata),
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'manifest',
  };
}
