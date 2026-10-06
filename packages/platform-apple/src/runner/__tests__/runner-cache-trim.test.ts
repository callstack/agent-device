import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { appleRunnerTestHost } from '../test-host.ts';
import { resolveRunnerCacheMetadataPath } from '../runner-cache.ts';
import { trimRunnerBuildScratch } from '../runner-cache-trim.ts';
import { ensureXctestrunArtifact } from '../runner-xctestrun.ts';
import { appleToolchainProbeResult } from './apple-toolchain-fixtures.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { seedRunnerProductBundle } from './runner-xctestrun.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

const KEY = 'cache-0123456789abcdef';

let base: string;
let previousDerivedOverride: string | undefined;

beforeEach(() => {
  base = mkdtempForTestSync('agent-device-runner-trim-');
  previousDerivedOverride = process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  delete process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_TRIM;
});

afterEach(() => {
  if (previousDerivedOverride === undefined)
    delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  else process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = previousDerivedOverride;
  delete process.env.AGENT_DEVICE_IOS_RUNNER_CACHE_TRIM;
});

function seedBuiltKey(derived: string): string[] {
  const products = path.join(derived, 'Build', 'Products');
  const app = path.join(products, 'Debug-iphonesimulator', 'Runner.app');
  const xctestrun = path.join(products, 'Runner.xctestrun');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'Runner'), 'binary');
  fs.writeFileSync(xctestrun, '<plist/>');
  fs.writeFileSync(resolveRunnerCacheMetadataPath(derived), '{}');
  for (const scratch of [
    'Build/Intermediates.noindex/Runner.build/obj.o',
    'Build/Products/Debug-iphonesimulator/Runner.app.dSYM',
    'SDKExplicitPrecompiledModules/Foundation.pcm',
    'ModuleCache.noindex/session.timestamp',
    'Logs/Build/build.xcactivitylog',
  ]) {
    fs.mkdirSync(path.dirname(path.join(derived, scratch)), { recursive: true });
    fs.writeFileSync(path.join(derived, scratch), 'scratch');
  }
  return [xctestrun, app];
}

function tree(directory: string, prefix = ''): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory()
      ? [relative, ...tree(path.join(directory, entry.name), relative)]
      : [relative];
  });
}

test('trimming keeps the products and the metadata file and removes the rest', async () => {
  const derived = path.join(base, KEY);
  const protectedPaths = seedBuiltKey(derived);

  const removed = await trimRunnerBuildScratch(derived, protectedPaths);

  assert.deepEqual(removed.sort(), [
    'Build/Intermediates.noindex',
    'Logs',
    'ModuleCache.noindex',
    'SDKExplicitPrecompiledModules',
  ]);
  assert.deepEqual(
    tree(derived).sort(),
    [
      '.agent-device-runner-cache.json',
      'Build',
      'Build/Products',
      'Build/Products/Debug-iphonesimulator',
      'Build/Products/Debug-iphonesimulator/Runner.app',
      'Build/Products/Debug-iphonesimulator/Runner.app.dSYM',
      'Build/Products/Debug-iphonesimulator/Runner.app/Runner',
      'Build/Products/Runner.xctestrun',
    ].map((entry) => entry.replaceAll('/', path.sep)),
  );
});

test('trimming is skipped when disabled, under a derived path override, or outside a keyed cache', async () => {
  const derived = path.join(base, KEY);
  const protectedPaths = seedBuiltKey(derived);
  const before = tree(derived);

  assert.deepEqual(
    await trimRunnerBuildScratch(derived, protectedPaths, {
      AGENT_DEVICE_IOS_RUNNER_CACHE_TRIM: '0',
    }),
    [],
  );
  assert.deepEqual(
    await trimRunnerBuildScratch(derived, protectedPaths, {
      AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: derived,
    }),
    [],
  );
  const unkeyed = path.join(base, 'derived');
  const unkeyedProducts = seedBuiltKey(unkeyed);
  assert.deepEqual(await trimRunnerBuildScratch(unkeyed, unkeyedProducts, {}), []);

  assert.deepEqual(tree(derived), before);
});

test('a product outside the cache root leaves the tree untouched', async () => {
  const derived = path.join(base, KEY);
  seedBuiltKey(derived);
  const before = tree(derived);

  assert.deepEqual(
    await trimRunnerBuildScratch(derived, [path.join(base, 'elsewhere.app')], {}),
    [],
  );

  assert.deepEqual(tree(derived), before);
});

test('a product that is a symlink keeps the unit it points into', async () => {
  const derived = path.join(base, KEY);
  const [xctestrun] = seedBuiltKey(derived);
  const target = path.join(derived, 'Build', 'Intermediates.noindex', 'Runner.build');
  const link = path.join(derived, 'Build', 'Products', 'Linked.app');
  fs.symlinkSync(target, link);

  const removed = await trimRunnerBuildScratch(derived, [xctestrun!, link], {});

  assert.deepEqual(removed.sort(), [
    'Logs',
    'ModuleCache.noindex',
    'SDKExplicitPrecompiledModules',
  ]);
  assert.equal(fs.existsSync(path.join(target, 'obj.o')), true);
});

test('a runner build trims its key, and the next start reuses the products without rebuilding', async () => {
  resetAllProcessMemosForTests();
  const projectRoot = mkdtempForTestSync('agent-device-runner-trim-root-');
  fs.mkdirSync(
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    { recursive: true },
  );
  const runCmdStreaming = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
    const symroot = args.find((arg) => arg.startsWith('SYMROOT='))!.slice('SYMROOT='.length);
    const derived = path.dirname(path.dirname(symroot));
    await seedRunnerProductBundle(path.join(symroot, 'Debug-iphonesimulator', 'Runner.app'));
    fs.writeFileSync(
      path.join(symroot, 'Runner_iphonesimulator27.0-arm64.xctestrun'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>ProductPaths</key><array>
<string>__TESTROOT__/Debug-iphonesimulator/Runner.app</string>
</array></dict></plist>`,
    );
    for (const scratch of [
      'Build/Intermediates.noindex/obj.o',
      'Logs/build.log',
      'ModuleCache.noindex/m',
    ]) {
      fs.mkdirSync(path.dirname(path.join(derived, scratch)), { recursive: true });
      fs.writeFileSync(path.join(derived, scratch), 'scratch');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  appleRunnerTestHost.update({
    runCmdSync: vi.fn().mockImplementation(appleToolchainProbeResult),
    runCmdStreaming,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
  });

  const built = await ensureXctestrunArtifact(IOS_SIMULATOR, {});

  assert.equal(built.artifact, 'rebuilt');
  assert.deepEqual(fs.readdirSync(built.derived).sort(), [
    '.agent-device-runner-cache.json',
    'Build',
  ]);
  assert.deepEqual(fs.readdirSync(path.join(built.derived, 'Build')), ['Products']);

  const reused = await ensureXctestrunArtifact(IOS_SIMULATOR, {});

  assert.equal(reused.artifact, 'valid');
  assert.equal(reused.xctestrunPath, built.xctestrunPath);
  assert.equal(runCmdStreaming.mock.calls.length, 1);
});
