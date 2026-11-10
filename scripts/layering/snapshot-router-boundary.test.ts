import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ARCHITECTURE_OWNERSHIP } from './architecture-ownership.ts';
import { executablePolicyViolations } from './executable-policies.ts';
import { workspaceSpecifierTargets } from './package-boundaries.ts';
import { listTrackedPackageManifests, listTrackedTypeScriptFiles } from './tracked-sources.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * ADR 0038: the snapshot source router in `packages/capture-kit/src/snapshot-router/` is platform
 * neutral. A platform or provider package declares its channels and binds them to the router; the
 * router never imports one back. The positive controls below exist because a clean tree looks the
 * same as a filter that stopped matching.
 */
function routerPolicy() {
  const policy = ARCHITECTURE_OWNERSHIP.executablePolicies.find(
    ({ name }) => name === 'snapshot-router',
  );
  if (!policy) throw new Error('snapshot-router ownership declaration is missing');
  return policy;
}

test('the snapshot router imports no platform or provider package', () => {
  const files = listTrackedTypeScriptFiles(repoRoot);
  const sources = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );

  assert.deepEqual(
    executablePolicyViolations(sources, workspaceSpecifierTargets(repoRoot))['snapshot-router'],
    [],
  );
});

test('every platform and provider package is a forbidden router target', () => {
  const packages = listTrackedPackageManifests(repoRoot)
    .map((manifest) => path.posix.dirname(manifest).slice('packages/'.length))
    .filter((name) => /^(?:platform|provider)-|^(?:apple-runner|tv-cdp)$/.test(name))
    .map((name) => `packages/${name}/`);

  assert.ok(packages.length > 0, 'expected platform and provider packages');
  const forbiddenRoots: readonly string[] = routerPolicy().forbiddenTargetRoots;
  for (const root of packages) {
    assert.ok(forbiddenRoots.includes(root), `${root} is not forbidden`);
  }
});

test('the boundary reports a router module that imports a platform or provider package', () => {
  const sources = new Map([
    ['packages/platform-apple/src/snapshot-target.ts', 'export const resolve = 1;\n'],
    ['packages/provider-limrun/src/index.ts', 'export const limrun = 1;\n'],
    [
      'packages/capture-kit/src/snapshot-router/router.ts',
      [
        "import { resolve } from '@agent-device/platform-apple/snapshot-target';",
        "const { limrun } = await import('../../../provider-limrun/src/index.ts');",
        'export const x = [resolve, limrun];',
        '',
      ].join('\n'),
    ],
  ]);
  const workspaceTargets = new Map([
    [
      '@agent-device/platform-apple/snapshot-target',
      'packages/platform-apple/src/snapshot-target.ts',
    ],
  ]);

  assert.deepEqual(executablePolicyViolations(sources, workspaceTargets)['snapshot-router'], [
    'packages/capture-kit/src/snapshot-router/router.ts:1 -> packages/platform-apple/src/snapshot-target.ts',
    'packages/capture-kit/src/snapshot-router/router.ts:2 -> packages/provider-limrun/src/index.ts',
  ]);
});
