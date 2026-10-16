// The shared isolation walk (R83 test-kit, R85 plugin framework): forbidden packages reached
// directly, through other workspace packages or by import, relative escapes, and reference cycles —
// run against both policies, then each policy's own forbidden class.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkPackageIsolation,
  parseManifests,
  PLUGIN_FRAMEWORK_INDEPENDENCE_RULE,
  PLUGIN_FRAMEWORK_ISOLATION,
  TEST_KIT_ISOLATION,
  type PackageIsolationPolicy,
} from './package-isolation.ts';
import { readTrackedPackageManifests } from './package-boundaries.ts';
import { listTrackedTypeScriptFiles } from './tracked-sources.ts';

type Manifest = Record<string, unknown>;

const repoRoot = path.resolve(import.meta.dirname, '../..');
const POLICIES = [TEST_KIT_ISOLATION, PLUGIN_FRAMEWORK_ISOLATION];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/** A workspace of manifests keyed by package directory name; both isolated packages build on kernel. */
function workspace(overrides: Record<string, Manifest> = {}): Map<string, string> {
  const base: Record<string, Manifest> = {
    'test-kit': {
      name: '@agent-device/test-kit',
      dependencies: { '@agent-device/kernel': 'workspace:*' },
    },
    plugins: {
      name: '@agent-device/plugins',
      dependencies: { '@agent-device/kernel': 'workspace:*' },
    },
    kernel: { name: '@agent-device/kernel' },
    contracts: { name: '@agent-device/contracts' },
    'host-kit': { name: '@agent-device/host-kit' },
    'platform-android': { name: '@agent-device/platform-android' },
    'platform-apple': { name: '@agent-device/platform-apple' },
    'provider-webdriver': { name: '@agent-device/provider-webdriver' },
    'provider-testmu': { name: '@agent-device/testmu' },
    daemon: { name: '@agent-device/daemon' },
    proxy: { name: '@agent-device/proxy' },
  };
  const merged: Record<string, Manifest> = { ...base };
  for (const [dir, manifest] of Object.entries(overrides)) {
    merged[dir] = { ...base[dir], ...manifest };
  }
  return new Map(
    Object.entries(merged).map(([dir, manifest]) => [
      `packages/${dir}/package.json`,
      JSON.stringify(manifest),
    ]),
  );
}

function dirOf(policy: PackageIsolationPolicy): string {
  return policy.dir.replace('packages/', '');
}

function check(
  policy: PackageIsolationPolicy,
  overrides: Record<string, Manifest> = {},
  sources: Record<string, string> = {},
) {
  return checkPackageIsolation(
    parseManifests(workspace(overrides)),
    new Map(Object.entries(sources)),
    policy,
  );
}

function source(policy: PackageIsolationPolicy, text: string) {
  return { [`${policy.dir}/src/a.ts`]: text };
}

test('the real repository holds every isolation policy', () => {
  const sources = new Map(
    listTrackedTypeScriptFiles(repoRoot).map((file) => [
      file,
      fs.readFileSync(path.join(repoRoot, file), 'utf8'),
    ]),
  );
  const manifests = parseManifests(readTrackedPackageManifests(repoRoot));
  for (const policy of POLICIES) {
    assert.deepEqual(checkPackageIsolation(manifests, sources, policy), [], policy.name);
  }
});

test('a repo without the isolated package has nothing to isolate', () => {
  for (const policy of POLICIES) {
    assert.deepEqual(
      checkPackageIsolation(parseManifests(new Map()), new Map(), policy),
      [],
      policy.name,
    );
  }
});

test('an isolated package built only on foundations holds', () => {
  for (const policy of POLICIES) {
    const dir = dirOf(policy);
    assert.deepEqual(
      check(
        policy,
        {
          [dir]: {
            dependencies: {
              '@agent-device/kernel': 'workspace:*',
              '@agent-device/contracts': 'workspace:*',
              '@agent-device/host-kit': 'workspace:*',
            },
          },
        },
        source(policy, "import { AppError } from '@agent-device/kernel/errors';"),
      ),
      [],
      policy.name,
    );
  }
});

test('a provider package is refused in every dependency field, under a non-provider name too', () => {
  for (const policy of POLICIES) {
    for (const name of ['@agent-device/provider-webdriver', '@agent-device/testmu']) {
      for (const field of DEPENDENCY_FIELDS) {
        const found = check(policy, { [dirOf(policy)]: { [field]: { [name]: 'workspace:*' } } });
        assert.equal(found.length, 1, `${policy.name} ${name} in ${field}`);
        assert.equal(found[0]!.file, `${policy.dir}/package.json`);
        assert.equal(found[0]!.rule, policy.rule);
        assert.match(found[0]!.message, new RegExp(`${policy.name} -> ${name}`));
      }
    }
  }
});

test('a provider reached through other workspace packages is refused with its chain', () => {
  for (const policy of POLICIES) {
    for (const field of DEPENDENCY_FIELDS) {
      const found = check(policy, {
        [dirOf(policy)]: {
          dependencies: { '@agent-device/host-kit': 'workspace:*' },
        },
        'host-kit': { dependencies: { '@agent-device/contracts': 'workspace:*' } },
        contracts: { [field]: { '@agent-device/provider-webdriver': 'workspace:*' } },
      });
      assert.equal(found.length, 1, `${policy.name} via ${field}`);
      assert.match(
        found[0]!.message,
        new RegExp(
          `${policy.name} -> @agent-device/host-kit -> @agent-device/contracts -> ` +
            `@agent-device/provider-webdriver`,
        ),
      );
    }
  }
});

test('a package outside the isolated package reach may declare a forbidden package', () => {
  for (const policy of POLICIES) {
    assert.deepEqual(
      check(policy, {
        proxy: { dependencies: { '@agent-device/provider-webdriver': 'workspace:*' } },
      }),
      [],
      policy.name,
    );
  }
});

test('a package the isolated package reaches cannot declare it back, directly or transitively', () => {
  for (const policy of POLICIES) {
    const direct = check(policy, {
      kernel: { devDependencies: { [policy.name]: 'workspace:*' } },
    });
    assert.equal(direct.length, 1, policy.name);
    assert.equal(direct[0]!.file, 'packages/kernel/package.json');
    assert.match(direct[0]!.message, /project-reference cycle/);

    const transitive = check(policy, {
      kernel: { dependencies: { '@agent-device/contracts': 'workspace:*' } },
      contracts: { optionalDependencies: { [policy.name]: 'workspace:*' } },
    });
    assert.equal(transitive.length, 1, policy.name);
    assert.equal(transitive[0]!.file, 'packages/contracts/package.json');
    assert.match(
      transitive[0]!.message,
      new RegExp(
        `${policy.name} -> @agent-device/kernel -> @agent-device/contracts -> ${policy.name}`,
      ),
    );

    assert.deepEqual(
      check(policy, { proxy: { devDependencies: { [policy.name]: 'workspace:*' } } }),
      [],
      policy.name,
    );
  }
});

test('a diamond and a shared foundation are not a cycle or a false ban', () => {
  for (const policy of POLICIES) {
    assert.deepEqual(
      check(policy, {
        [dirOf(policy)]: {
          dependencies: {
            '@agent-device/host-kit': 'workspace:*',
            '@agent-device/contracts': 'workspace:*',
          },
        },
        'host-kit': { dependencies: { '@agent-device/kernel': 'workspace:*' } },
        contracts: { dependencies: { '@agent-device/kernel': 'workspace:*' } },
      }),
      [],
      policy.name,
    );
  }
});

test('a static, type-only, dynamic, re-export, inline-type or mocked import of a provider is refused', () => {
  for (const policy of POLICIES) {
    const entry = "'@agent-device/provider-webdriver/plugin'";
    for (const text of [
      `import { createCloudWebDriverRuntime } from ${entry};`,
      `import type { CloudWebDriverProviderOptions } from ${entry};`,
      `const { createCloudWebDriverRuntime } = await import(${entry});`,
      `export { createCloudWebDriverRuntime } from ${entry};`,
      `type Options = import(${entry}).CloudWebDriverProviderOptions;`,
      `import '@agent-device/testmu';`,
      `vi.mock(${entry}, () => ({}));`,
      `vi.mock(${entry.replaceAll("'", '`')}, () => ({}));`,
      `vi['mock'](${entry});`,
      `vi.doMock(${entry});`,
      `await vi.importActual(${entry});`,
      `vi.mock(import(${entry}));`,
      `import { vi as mocks } from 'vitest';\nmocks.mock(${entry});`,
      `import * as testing from 'vitest';\ntesting.vi.mock(${entry});`,
    ]) {
      const found = check(policy, {}, source(policy, text));
      assert.equal(found.length, 1, `${policy.name}: ${text}`);
      assert.equal(found[0]!.rule, policy.rule);
      assert.equal(found[0]!.file, `${policy.dir}/src/a.ts`);
    }
  }
});

test('an import ignores comments, non-literal mock arguments, other objects and its own directory', () => {
  for (const policy of POLICIES) {
    const entry = "'@agent-device/provider-webdriver/plugin'";
    for (const text of [
      `// vi.mock(${entry});`,
      'vi.mock(`@agent-device/provider-webdriver/${name}`);',
      `other.mock(${entry});`,
      `import { vi as mocks } from 'not-vitest';\nmocks.mock(${entry});`,
      `import type { vi as mocks } from 'vitest';\nmocks.mock(${entry});`,
      "import { b } from './b.ts';\nimport { c } from '@agent-device/daemon-contracts/device-claims';",
    ]) {
      assert.deepEqual(check(policy, {}, source(policy, text)), [], `${policy.name}: ${text}`);
    }
  }
});

test('a mock of a provider is refused through an alias even where a local shadows the alias name', () => {
  for (const policy of POLICIES) {
    const entry = "'@agent-device/provider-webdriver/plugin'";
    const vitest = "import { vi as mocks } from 'vitest';";
    for (const text of [
      `${vitest}\nfunction f(mocks) { mocks.mock(${entry}); }`,
      `${vitest}\n{ const mocks = other; mocks.doMock(${entry}); }`,
      `import * as testing from 'vitest';\nconst f = (testing) => testing.vi.mock(${entry});`,
      `${vitest}\nfunction f(x = mocks.mock(${entry})) { var mocks; }`,
      `${vitest}\nswitch (mocks.mock(${entry})) { case 0: let mocks; }`,
      `${vitest}\nclass C { static { mocks.mock(${entry}); } }`,
    ]) {
      assert.equal(check(policy, {}, source(policy, text)).length, 1, `${policy.name}: ${text}`);
    }
  }
});

test('relative reach out of the package directory is refused', () => {
  for (const policy of POLICIES) {
    for (const specifier of [
      '../../../src/platform-runtime-gateway.ts',
      '../../kernel/src/errors.ts',
    ]) {
      const found = check(policy, {}, source(policy, `import { x } from '${specifier}';`));
      assert.equal(found.length, 1, `${policy.name}: ${specifier}`);
    }
  }
});

test('test-kit also refuses platform, daemon and root packages that the plugin framework may use', () => {
  const forbidden = [
    '@agent-device/platform-apple',
    '@agent-device/platform-android/runner',
    '@agent-device/daemon',
    'agent-device',
    'agent-device/commands',
  ];
  for (const name of forbidden) {
    const dependency = name
      .split('/')
      .slice(0, name.startsWith('@') ? 2 : 1)
      .join('/');
    for (const field of DEPENDENCY_FIELDS) {
      const found = check(TEST_KIT_ISOLATION, { 'test-kit': { [field]: { [dependency]: '*' } } });
      assert.equal(found.length, 1, `${dependency} in ${field}`);
      assert.match(found[0]!.message, /belongs in it/);
    }
    assert.equal(
      check(TEST_KIT_ISOLATION, {}, source(TEST_KIT_ISOLATION, `import { x } from '${name}';`))
        .length,
      1,
      name,
    );
    assert.deepEqual(
      check(
        PLUGIN_FRAMEWORK_ISOLATION,
        {},
        source(PLUGIN_FRAMEWORK_ISOLATION, `import { x } from '${name}';`),
      ),
      [],
      name,
    );
  }
  assert.deepEqual(
    check(PLUGIN_FRAMEWORK_ISOLATION, {
      plugins: { dependencies: { '@agent-device/platform-apple': 'workspace:*' } },
    }),
    [],
  );
});

test('the plugin framework carries R85 and its provider-policy remedy', () => {
  const [found] = check(PLUGIN_FRAMEWORK_ISOLATION, {
    plugins: { dependencies: { '@agent-device/provider-webdriver': 'workspace:*' } },
  });
  assert.equal(found?.rule, PLUGIN_FRAMEWORK_INDEPENDENCE_RULE);
  assert.match(found!.message, /policy from the composing root/);
});
