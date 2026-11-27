import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  resolveRunnerBundleBuildSettings,
  resolveRunnerSandboxBuildArgs,
  type RunnerXctestrunCacheMetadata,
} from '../runner-cache-metadata.ts';
import { evaluateExistingXctestrun } from '../runner-cache.ts';
import { resolveReleasedXctestrunArtifact } from '../runner-release-artifact.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { makeScratchDir, writeXctestrunFixture } from './runner-xctestrun.fixtures.ts';

const expectedCacheMetadata: RunnerXctestrunCacheMetadata = {
  schemaVersion: 3,
  packageVersion: '0.21.44',
  runnerSourceFingerprint: 'source',
  platformName: 'iOS',
  deviceKind: 'simulator',
  target: 'mobile',
  buildDestinationFamily: 'generic/platform=iOS Simulator',
  runnerBundleBuildSettings: resolveRunnerBundleBuildSettings({}),
  runnerSigningBuildSettings: [],
  runnerPerformanceBuildSettings: [],
  runnerArchBuildSettings: [],
  runnerSandboxBuildArgs: resolveRunnerSandboxBuildArgs({}),
  xcodeVersion: '27.1',
  xcodeBuildVersion: '27A9275',
  sdkName: 'iphonesimulator',
  sdkVersion: '27.1',
  sdkBuildVersion: '24A94232',
};

it.each([
  { name: 'matching archive', match: true },
  { name: 'wrong package version', manifest: { version: '0.0.1' } },
  { name: 'wrong Xcode version', manifest: { xcodeVersion: '27.2' } },
  { name: 'wrong Xcode build', manifest: { xcodeBuildVersion: 'other' } },
  { name: 'wrong SDK name', manifest: { sdkName: 'iphoneos' } },
  { name: 'wrong SDK version', manifest: { sdkVersion: '27.2' } },
  { name: 'wrong SDK build', manifest: { sdkBuildVersion: 'other' } },
  { name: 'wrong architecture', manifest: { architecture: 'x64' } },
  { name: 'wrong sources', manifest: { runnerSourceFingerprint: 'other' } },
  { name: 'checksum mismatch', download: 'wrong bytes' },
  { name: 'archive missing', archiveStatus: 404 },
])(
  'certifies only matching release products ($name)',
  async ({ match, manifest, download, archiveStatus }) => {
    const derived = await makeScratchDir();
    const xctestrun = 'runner.xctestrun';
    const archive = 'test archive';
    const product = 'Debug-iphonesimulator/Runner.app';
    const extractRunnerReleaseArchive = vi.fn(async ({ outputRoot }: { outputRoot: string }) => {
      fs.mkdirSync(path.join(outputRoot, product), { recursive: true });
      fs.writeFileSync(path.join(outputRoot, product, 'Runner'), 'executable');
      writeXctestrunFixture(path.join(outputRoot, xctestrun), {
        projectRoot: derived,
        productRelativePaths: [product],
      });
    });
    appleRunnerTestHost.update({ readHostCpuArchSync: () => 'arm64', extractRunnerReleaseArchive });
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('.manifest.json')
        ? Response.json({
            ...expectedCacheMetadata,
            version: expectedCacheMetadata.packageVersion,
            architecture: 'arm64',
            sha256: createHash('sha256').update(archive).digest('hex'),
            xctestrun,
            ...manifest,
          })
        : new Response(archiveStatus ? null : (download ?? archive), { status: archiveStatus }),
    );
    vi.stubGlobal('fetch', fetch);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const result = await resolveReleasedXctestrunArtifact({
      derived,
      expectedCacheMetadata,
      options: {},
      assertAdmitted: () => {},
    });
    expect(fetch).toHaveBeenCalledTimes(manifest ? 1 : 2);
    if (match) {
      expect(result?.cache).toBe('release');
      expect(result?.xctestrunPath).toContain(xctestrun);
      expect(extractRunnerReleaseArchive).toHaveBeenCalledOnce();
      const existing = await evaluateExistingXctestrun({ derived, expectedCacheMetadata });
      expect(existing.reason).toBe('reuse_ready');
    } else {
      expect(result).toBeNull();
      expect(extractRunnerReleaseArchive).not.toHaveBeenCalled();
      expect(fs.readdirSync(derived)).toEqual([]);
    }
  },
);

it.each([
  { name: 'HTTP 404', reply: async () => new Response(null, { status: 404 }), calls: 1 },
  {
    name: 'connection failure',
    reply: async () => {
      throw new Error('offline');
    },
    calls: 1,
  },
  { name: 'Intel host', arch: 'x64', calls: 0 },
  { name: 'older Xcode', xcodeVersion: '26.2', calls: 0 },
] as const)('falls back without creating products ($name)', async (scenario) => {
  const derived = await makeScratchDir();
  const extractRunnerReleaseArchive = vi.fn();
  appleRunnerTestHost.update({
    readHostCpuArchSync: () => scenario.arch ?? 'arm64',
    extractRunnerReleaseArchive,
  });
  const fetch = vi.fn('reply' in scenario ? scenario.reply : undefined);
  vi.stubGlobal('fetch', fetch);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  await expect(
    resolveReleasedXctestrunArtifact({
      derived,
      expectedCacheMetadata: {
        ...expectedCacheMetadata,
        xcodeVersion: scenario.xcodeVersion ?? expectedCacheMetadata.xcodeVersion,
      },
      options: {},
      assertAdmitted: () => {},
    }),
  ).resolves.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(scenario.calls);
  expect(extractRunnerReleaseArchive).not.toHaveBeenCalled();
  expect(fs.readdirSync(derived)).toEqual([]);
});
