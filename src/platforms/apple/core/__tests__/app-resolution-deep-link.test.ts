import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import assert from 'node:assert/strict';

import { resolveIosSimulatorDeepLinkBundleId } from '../app-resolution.ts';
import {
  withFakeAppleTool,
  type FakeAppleToolResponse,
} from '../../../../__tests__/test-utils/fake-apple-tool.ts';
import { mkdtempForTest } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

function unexpectedArgs(args: string[]): FakeAppleToolResponse {
  return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
}

type SchemeFixture = {
  root: string;
  plistA: string;
  listing: string;
};

async function makeSchemeFixture(): Promise<SchemeFixture> {
  const root = await mkdtempForTest('deep-link-url-schemes-');
  const bundleDirs = { a: path.join(root, 'AppA.app'), b: path.join(root, 'AppB.app') };
  await fs.mkdir(bundleDirs.a, { recursive: true });
  await fs.mkdir(bundleDirs.b, { recursive: true });
  await fs.writeFile(path.join(bundleDirs.a, 'Info.plist'), '');
  await fs.writeFile(path.join(bundleDirs.b, 'Info.plist'), '');
  const listing = JSON.stringify({
    'com.example.appa': {
      ApplicationType: 'User',
      CFBundleDisplayName: 'App A',
      Path: bundleDirs.a,
    },
    'com.example.appb': {
      ApplicationType: 'User',
      CFBundleDisplayName: 'App B',
      Path: bundleDirs.b,
    },
  });
  return { root, plistA: path.join(bundleDirs.a, 'Info.plist'), listing };
}

const SCHEME_PROBES = [
  {
    suffix: 'AppA.app/Info.plist',
    schemesJson: '{"CFBundleURLTypes":[{"CFBundleURLSchemes":["alpha"]}]}',
  },
  {
    suffix: 'AppB.app/Info.plist',
    schemesJson: '{"CFBundleURLTypes":[{"CFBundleURLSchemes":["beta"]}]}',
  },
];

function createSchemeTool(
  fixture: SchemeFixture,
  options: { failFirstProbes?: number } = {},
): { handle: (args: string[]) => FakeAppleToolResponse; probeCount: () => number } {
  let probeCount = 0;

  const respondToPlutil = (plistPath: string): FakeAppleToolResponse => {
    const probe = SCHEME_PROBES.find((candidate) => plistPath.endsWith(candidate.suffix));
    if (!probe) return '{}';
    probeCount += 1;
    if (options.failFirstProbes !== undefined && probeCount <= options.failFirstProbes) {
      return { stdout: '', exitCode: 1 };
    }
    return probe.schemesJson;
  };

  return {
    handle(args) {
      if (args[0] === 'simctl' && args[1] === 'listapps') return fixture.listing;
      if (args[0] === 'plutil' && args[1] === '-convert') return respondToPlutil(args[5] ?? '');
      return unexpectedArgs(args);
    },
    probeCount: () => probeCount,
  };
}

test('resolveIosSimulatorDeepLinkBundleId memoizes per-app url-scheme probes', async () => {
  const fixture = await makeSchemeFixture();
  const tool = createSchemeTool(fixture);

  await withFakeAppleTool(tool.handle, async ({ calls }) => {
    const plutilProbes = () => calls.filter((args) => args[0] === 'plutil').length;

    const first = await resolveIosSimulatorDeepLinkBundleId(IOS_TEST_SIMULATOR, 'alpha://one');
    assert.equal(first, 'com.example.appa');
    const probesAfterFirst = plutilProbes();
    assert.equal(probesAfterFirst, 2);

    const second = await resolveIosSimulatorDeepLinkBundleId(IOS_TEST_SIMULATOR, 'beta://two');
    assert.equal(second, 'com.example.appb');
    assert.equal(plutilProbes(), probesAfterFirst);
  });
});

test('a failed url-scheme probe is retried on the next lookup instead of cached', async () => {
  const fixture = await makeSchemeFixture();
  const tool = createSchemeTool(fixture, { failFirstProbes: 1 });

  await withFakeAppleTool(tool.handle, async () => {
    const duringFailure = await resolveIosSimulatorDeepLinkBundleId(
      IOS_TEST_SIMULATOR,
      'alpha://one',
    );
    assert.equal(duringFailure, undefined);

    const afterRecovery = await resolveIosSimulatorDeepLinkBundleId(
      IOS_TEST_SIMULATOR,
      'alpha://one',
    );
    assert.equal(afterRecovery, 'com.example.appa');
    // AppA retried once after the failure; AppB's successful probe stayed cached.
    assert.equal(tool.probeCount(), 3);
  });
});

test('rewriting the Info.plist invalidates the cached scheme set', async () => {
  const fixture = await makeSchemeFixture();
  const tool = createSchemeTool(fixture);

  await withFakeAppleTool(tool.handle, async ({ calls }) => {
    const plutilProbes = () => calls.filter((args) => args[0] === 'plutil').length;

    assert.equal(
      await resolveIosSimulatorDeepLinkBundleId(IOS_TEST_SIMULATOR, 'alpha://one'),
      'com.example.appa',
    );
    const probesBeforeRewrite = plutilProbes();

    await fs.writeFile(fixture.plistA, '/* rewritten */');
    const later = Date.now() + 5_000;
    await fs.utimes(fixture.plistA, new Date(later), new Date(later));

    assert.equal(
      await resolveIosSimulatorDeepLinkBundleId(IOS_TEST_SIMULATOR, 'alpha://one'),
      'com.example.appa',
    );
    assert.equal(plutilProbes(), probesBeforeRewrite + 1);
  });
});
