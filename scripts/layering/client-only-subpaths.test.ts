// `CLIENT_ONLY_SUBPATHS` in package-boundaries.ts: the caller-side replay source collector stays
// out of daemon production code, which receives the client's source bundle in the request.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLIENT_ONLY_SUBPATHS,
  checkPackageInternalSites,
  checkRootSites,
  specifierSites,
  type WorkspacePackage,
} from './package-boundaries.ts';

const daemon: WorkspacePackage = {
  dir: 'packages/daemon',
  name: '@agent-device/daemon',
  exportTargets: new Map(),
  workspaceDependencies: new Set(['@agent-device/replay-port']),
  workspaceDependencyField: 'dependencies',
  externalDependencies: new Map(),
};

test('the caller-side replay source subpaths are denied to daemon production code only', () => {
  // Pin the set independently: iterating the checker's own set would let deleting an entry
  // silently delete its accept/deny coverage with it.
  assert.deepEqual([...CLIENT_ONLY_SUBPATHS].sort(), [
    '@agent-device/replay-port/script-source-bundle',
    '@agent-device/replay-port/source-discovery',
  ]);
  const rootDeps = new Set(daemon.workspaceDependencies);
  for (const specifier of CLIENT_ONLY_SUBPATHS) {
    const sites = (file: string) => specifierSites(file, `import { f } from '${specifier}';`);
    const check = (file: string) =>
      file.startsWith('src/')
        ? checkRootSites(sites(file), [], rootDeps, true)
        : checkPackageInternalSites(daemon, sites(file), [], true);
    for (const file of [
      'src/commands/replay/index.ts',
      'src/daemon/__tests__/replay.test.ts',
      'packages/daemon/src/__tests__/replay.test.ts',
    ]) {
      assert.deepEqual(
        check(file).filter((v) => /caller-side replay sources/.test(v.message)),
        [],
        file,
      );
    }
    for (const file of [
      'src/daemon/replay-runtime.ts',
      'packages/daemon/src/replay-runtime.ts',
      'src/daemon.ts',
      'src/daemon-composition.ts',
    ]) {
      const violations = check(file).filter((v) => /caller-side replay sources/.test(v.message));
      assert.equal(violations.length, 1, file);
    }
  }
});
