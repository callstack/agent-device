import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempForTest } from './tmp-dir.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { writeRunnerCacheMetadataForArtifacts } from '../runner-cache.ts';
import type { RunnerCacheRefusal } from '../runner-artifact-manifest.ts';
import { resolveExpectedRunnerCacheMetadata } from '../runner-xctestrun.ts';

// Scratch trees and certified runner products shared by the tests that exercise
// cache reuse: a case needs an `.xctestrun` naming a product bundle whose bytes
// a manifest certifies, which is more than `writeXctestrunFixture` alone gives.

export const REPO_ROOT_FOR_TEST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

/** A scratch directory removed when the calling test finishes. */
export async function makeScratchDir(): Promise<string> {
  const tmpDir = await mkdtempForTest('agent-device-xctestrun-');
  onTestFinished(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });
  return tmpDir;
}

/**
 * A scratch directory under the repository's own `.tmp`, for cases whose build must resolve
 * the runner project — `ensureXctestrunArtifact` refuses to start one without it.
 */
export async function makeProjectScratchDir(): Promise<string> {
  const tmpRoot = path.join(REPO_ROOT_FOR_TEST, '.tmp');
  await fs.promises.mkdir(tmpRoot, { recursive: true });
  const tmpDir = await fs.promises.mkdtemp(path.join(tmpRoot, 'agent-device-xctestrun-'));
  onTestFinished(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });
  return tmpDir;
}

export function writeXctestrunFixture(
  xctestrunPath: string,
  options: { projectRoot: string; productRelativePaths: string[] },
): void {
  // Paths reach this plist as text, and a checkout directory can carry an `&` or a `'` in its
  // name. Unescaped, the plist would be malformed and the product-path reader would find nothing,
  // so the case under test would silently exercise a different path.
  const entries = options.productRelativePaths
    .map(
      (relativePath) => `        <string>${escapeXmlText(`__TESTROOT__/${relativePath}`)}</string>`,
    )
    .join('\n');
  fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
  fs.writeFileSync(
    xctestrunPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ProjectRootHint</key>
  <string>${escapeXmlText(options.projectRoot)}</string>
  <key>ProductPaths</key>
  <array>
${entries}
  </array>
</dict>
</plist>`,
    'utf8',
  );
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function withRunnerDerivedPathEnv(derivedPath: string): void {
  const previousDerivedPath = process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = derivedPath;
  onTestFinished(() => {
    restoreEnvVar('AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH', previousDerivedPath);
  });
}

export function withoutRunnerDerivedPathEnv(): void {
  const previousDerivedPath = process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  onTestFinished(() => {
    restoreEnvVar('AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH', previousDerivedPath);
  });
}

export function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export function stripRunnerCacheArtifacts(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const { artifacts: _artifacts, ...rest } = metadata;
  return rest;
}

/**
 * A content manifest certifies bytes, so a fixture product needs some. Mirrors what a build
 * leaves behind: a bundle directory holding an executable.
 */
/** The bytes a fixture product bundle holds, exported so a tamper can keep the same length. */
export const RUNNER_FIXTURE_EXECUTABLE_BYTES = Buffer.from('runner-executable\n');

export async function seedRunnerProductBundle(bundlePath: string): Promise<void> {
  await fs.promises.mkdir(bundlePath, { recursive: true });
  await fs.promises.writeFile(
    path.join(bundlePath, path.basename(bundlePath, '.app')),
    RUNNER_FIXTURE_EXECUTABLE_BYTES,
    { mode: 0o755 },
  );
}

/**
 * Publishes the metadata the production writer would, so a fixture tree is really certified.
 * Returns the refusal when the tree cannot be certified, which callers assert rather than ignore.
 */
export async function writeRunnerCacheMetadataWithArtifacts(params: {
  derivedPath: string;
  device: DeviceInfo;
  xctestrunPath: string;
  productPaths: string[];
}): Promise<RunnerCacheRefusal | null> {
  return writeRunnerCacheMetadataForArtifacts(
    params.derivedPath,
    resolveExpectedRunnerCacheMetadata(params.device, REPO_ROOT_FOR_TEST),
    params.xctestrunPath,
    params.productPaths,
  );
}

/**
 * A macOS runner product tree that already carries a valid manifest, the shape a restored
 * cache arrives in. Under the repository's `.tmp` so the build it can fall back to resolves
 * the runner project.
 */
export async function makeCachedRunnerXctestrun(device: DeviceInfo): Promise<{
  derivedPath: string;
  existingXctestrunPath: string;
}> {
  const tmpDir = await makeProjectScratchDir();
  const derivedPath = path.join(tmpDir, 'custom-derived');
  const existingXctestrunPath = path.join(derivedPath, 'existing.xctestrun');
  await fs.promises.mkdir(derivedPath, { recursive: true });
  await seedRunnerProductBundle(path.join(derivedPath, 'Runner.app'));
  writeXctestrunFixture(existingXctestrunPath, {
    projectRoot: REPO_ROOT_FOR_TEST,
    productRelativePaths: ['Runner.app'],
  });
  await writeRunnerCacheMetadataWithArtifacts({
    derivedPath,
    device,
    xctestrunPath: existingXctestrunPath,
    productPaths: [path.join(derivedPath, 'Runner.app')],
  });
  return { derivedPath, existingXctestrunPath };
}
