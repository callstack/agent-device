import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANONICAL_PLATFORM_FAMILIES,
  checkPlatformPackagePolicy,
  type PlatformPackageDeclaration,
} from './platform-package-policy.ts';
import { classifyZone } from './model.ts';

const inventoryModuleNames = {
  apple: 'appleInventoryModule',
  android: 'androidInventoryModule',
  harmonyos: 'harmonyosInventoryModule',
  vega: 'vegaInventoryModule',
  linux: 'linuxInventoryModule',
  web: 'webInventoryModule',
} as const;

function declarations(): PlatformPackageDeclaration[] {
  return CANONICAL_PLATFORM_FAMILIES.map((family) => ({
    dir: `packages/platform-${family}`,
    family,
    name: `@agent-device/platform-${family}`,
    private: true,
    exportedSubpaths: [`@agent-device/platform-${family}`],
  }));
}

function facade(family: (typeof CANONICAL_PLATFORM_FAMILIES)[number]): string {
  return [
    "import type { DeviceInventoryHost, InventoryPlatformModule, PlatformModuleMetadata } from '@agent-device/contracts/platform';",
    'const metadata = Object.freeze({',
    `  family: '${family}',`,
    '} satisfies PlatformModuleMetadata);',
    'export const inventoryModule = Object.freeze({',
    '  ...metadata,',
    '  loadInventory: async (host: DeviceInventoryHost) => {',
    "    const { createInventory } = await import('./inventory.ts');",
    '    return createInventory(host);',
    '  },',
    '} satisfies InventoryPlatformModule);',
  ].join('\n');
}

function composition(families = CANONICAL_PLATFORM_FAMILIES): string {
  return [
    "import { createPlatformModuleRegistry } from '@agent-device/contracts/platform';",
    ...families.map(
      (family) =>
        `import { inventoryModule as ${inventoryModuleNames[family]} } from '@agent-device/platform-${family}';`,
    ),
    'export const platformModuleRegistry = createPlatformModuleRegistry([',
    ...families.map((family) => `  ${inventoryModuleNames[family]},`),
    ']);',
  ].join('\n');
}

function validSources(): Map<string, string> {
  return new Map([
    ['src/platform-runtime.ts', composition()],
    ...CANONICAL_PLATFORM_FAMILIES.map(
      (family) => [`packages/platform-${family}/src/index.ts`, facade(family)] as const,
    ),
  ]);
}

function messages(sources: ReadonlyMap<string, string>, packages = declarations()): string[] {
  return checkPlatformPackagePolicy(sources, packages).map((violation) => violation.message);
}

test('the inventory substrate has six private lazy packages and one exact composition root', () => {
  assert.deepEqual(checkPlatformPackagePolicy(validSources(), declarations()), []);
});

test('platform workspace packages are R11-owned unranked zones', () => {
  for (const family of CANONICAL_PLATFORM_FAMILIES) {
    assert.equal(classifyZone(`platform-${family}`), 'unranked', family);
  }
});

test('untracked production TypeScript makes committed-state evidence fail closed', () => {
  const found = checkPlatformPackagePolicy(validSources(), declarations(), {
    untrackedProductionFiles: ['packages/platform-apple/src/mechanics.ts'],
  });
  assert.match(found.map(({ message }) => message).join('\n'), /untracked production source/);
});

test('family packages are exact, private, and expose only their root facade', () => {
  const packages = declarations();
  packages[0] = { ...packages[0]!, private: false };
  packages[1] = { ...packages[1]!, name: '@agent-device/not-android' };
  packages[2] = {
    ...packages[2]!,
    exportedSubpaths: [packages[2]!.name, `${packages[2]!.name}/internal`],
  };
  packages.pop();

  const found = messages(validSources(), packages).join('\n');
  assert.match(found, /platform-apple must be private/);
  assert.match(found, /platform-android must be named '@agent-device\/platform-android'/);
  assert.match(found, /platform-harmonyos must export only its root façade/);
  assert.match(found, /missing canonical platform package.*platform-web/);
});

test('composition policy does not pin local platform-module identifier spelling', () => {
  const sources = validSources();
  sources.set(
    'src/platform-runtime.ts',
    composition().replaceAll('appleInventoryModule', 'selectedAppleModule'),
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations()), []);
});

test('only src/platform-runtime.ts may import a concrete platform package', () => {
  for (const statement of [
    "import { applePlatformMetadata } from '@agent-device/platform-apple';",
    "import type { AppleThing } from '@agent-device/platform-apple';",
    "void import('@agent-device/platform-apple');",
    "export { applePlatformMetadata } from '@agent-device/platform-apple';",
  ]) {
    const sources = validSources();
    sources.set('src/daemon/not-the-root.test.ts', statement);
    assert.match(messages(sources).join('\n'), /only src\/platform-runtime\.ts may import/);
  }
});

test('contracts never depend on a concrete platform package in production or tests', () => {
  for (const statement of [
    "import { applePlatformMetadata } from '@agent-device/platform-apple';",
    "import type { AppleThing } from '@agent-device/platform-apple';",
    "void import('@agent-device/platform-apple');",
    "export { applePlatformMetadata } from '@agent-device/platform-apple';",
  ]) {
    const sources = validSources();
    sources.set('packages/contracts/src/platform-runtime.test.ts', statement);
    assert.match(messages(sources).join('\n'), /contracts may never import a concrete platform/);
  }
});

test('platform packages cannot escape to root, daemon, siblings, or raw process primitives', () => {
  const planted = [
    "import type { DaemonRequest } from '../../../src/daemon/types.ts';",
    "export { x } from '../../../src/core/x.ts';",
    "void import('@agent-device/platform-android');",
    "import { spawn } from 'node:child_process';",
    "import type { ChildProcess } from 'child_process';",
  ];
  for (const statement of planted) {
    const sources = validSources();
    sources.set('packages/platform-apple/src/probe.test.ts', statement);
    assert.ok(
      messages(sources).some((message) =>
        /may not reach root|may not import sibling|raw process primitives/.test(message),
      ),
      statement,
    );
  }
});

test('platform packages cannot depend on any other workspace implementation package', () => {
  for (const specifier of [
    '@agent-device/selectors',
    '@agent-device/provider-webdriver',
    '@agent-device/ad-script',
  ]) {
    const sources = validSources();
    sources.set(
      'packages/platform-apple/src/probe.test.ts',
      `import type { Forbidden } from '${specifier}';`,
    );
    assert.match(
      messages(sources).join('\n'),
      /may import workspace code only from contracts or kernel/,
    );
  }
});

test('package-owned tests may import their own public facade', () => {
  const sources = validSources();
  sources.set(
    'packages/platform-apple/src/index.test.ts',
    "import { inventoryModule } from '@agent-device/platform-apple';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations()), []);
});

test('platform facades cannot evaluate mechanics eagerly', () => {
  for (const statement of [
    "import { helper } from './helper-manager.ts';",
    "export { probe } from './probe.ts';",
    "import './implementation.ts';",
  ]) {
    const sources = validSources();
    sources.set('packages/platform-apple/src/index.ts', `${statement}\n${facade('apple')}`);
    assert.match(messages(sources).join('\n'), /facade must not eagerly evaluate/);
  }

  const sources = validSources();
  sources.set(
    'packages/platform-apple/src/index.ts',
    `${facade('apple')}\nexport const loadApple = () => import('./implementation.ts');`,
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations()), []);
});

test('composition policy does not infer host authority from function or class names', () => {
  const sources = validSources();
  sources.set(
    'src/platform-runtime.ts',
    `${composition()}\nclass AppleHelperManager {}\nnew AppleHelperManager();\nprobeAndroidSdk();`,
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations()), []);
});

test('composition keeps platform implementation loaders behind selected use', () => {
  for (const method of ['loadInventory', 'loadRuntime']) {
    const sources = validSources();
    sources.set(
      'src/platform-runtime.ts',
      `${composition()}\nappleInventoryModule.${method}(host);`,
    );
    assert.match(messages(sources).join('\n'), /implementation loader.*selected use/, method);
  }
});

test('implementation-loader detection ignores comments, strings, and deferred function bodies', () => {
  const sources = validSources();
  sources.set(
    'src/platform-runtime.ts',
    [
      composition(),
      "const documentation = 'appleInventoryModule.loadInventory(host)';",
      '// appleInventoryModule.loadRuntime(host);',
      'export function loadSelectedFamily() { return appleInventoryModule.loadInventory(host); }',
    ].join('\n'),
  );
  assert.ok(
    !messages(sources).some((message) => /implementation loader.*selected use/.test(message)),
  );
});

test('composition imports are category-based for future contracts and host adapters', () => {
  const sources = validSources();
  sources.set(
    'src/platform-runtime.ts',
    [
      composition(),
      "import type { PlatformRequestScope } from '@agent-device/contracts/platform';",
      "import { hostCommandRunner } from './platform-runtime-host/command.ts';",
      "import { createComposedDeviceInventoryGateways } from './platform-runtime-device-inventory.ts';",
      'void hostCommandRunner;',
      'void createComposedDeviceInventoryGateways;',
      'export type Scope = PlatformRequestScope;',
    ].join('\n'),
  );
  assert.ok(!messages(sources).some((message) => /composition imports only/.test(message)));

  sources.set('src/platform-runtime.ts', `${composition()}\nimport { daemon } from './daemon.ts';`);
  assert.match(messages(sources).join('\n'), /composition imports only/);
});

test('Node resolves only each platform package root facade', () => {
  for (const family of CANONICAL_PLATFORM_FAMILIES) {
    const specifier = `@agent-device/platform-${family}`;
    assert.ok(import.meta.resolve(specifier).endsWith(`packages/platform-${family}/src/index.ts`));
    assert.throws(
      () => import.meta.resolve(`${specifier}/src/index.ts`),
      /ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath/,
    );
  }
});
