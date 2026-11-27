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

it.each(['match', 'different toolchain', 'bad checksum'] as const)(
  'certifies only matching, checksum-verified release products (%s)',
  async (outcome) => {
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
            xcodeBuildVersion:
              outcome === 'different toolchain' ? 'other' : expectedCacheMetadata.xcodeBuildVersion,
            sha256: createHash('sha256')
              .update(outcome === 'bad checksum' ? 'untrusted' : archive)
              .digest('hex'),
            xctestrun,
          })
        : new Response(archive),
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
    expect(fetch).toHaveBeenCalledTimes(outcome === 'different toolchain' ? 1 : 2);
    if (outcome === 'match') {
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
