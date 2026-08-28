import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANONICAL_PLATFORM_FAMILIES,
  checkPlatformPackagePolicy,
  checkPlatformsRootShape,
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
    exportedSubpaths:
      family === 'apple'
        ? [
            '@agent-device/platform-apple',
            '@agent-device/platform-apple/app-lifecycle',
            '@agent-device/platform-apple/app-resolution',
            '@agent-device/platform-apple/debug-symbols',
            '@agent-device/platform-apple/doctor',
            '@agent-device/platform-apple/interactions',
            '@agent-device/platform-apple/install-artifact',
            '@agent-device/platform-apple/macos',
            '@agent-device/platform-apple/perf',
            '@agent-device/platform-apple/physical-device',
            '@agent-device/platform-apple/runner',
            '@agent-device/platform-apple/runner/client',
            '@agent-device/platform-apple/runner/test-host',
            '@agent-device/platform-apple/runner/operations',
            '@agent-device/platform-apple/runner-owner',
            '@agent-device/platform-apple/simctl',
            '@agent-device/platform-apple/simulator',
            '@agent-device/platform-apple/tool-provider',
          ]
        : family === 'android'
          ? [
              '@agent-device/platform-android',
              '@agent-device/platform-android/adb-host',
              '@agent-device/platform-android/mechanics',
            ]
          : [`@agent-device/platform-${family}`],
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

test('retired platform family implementations are rejected from src/platforms', () => {
  const violations = checkPlatformsRootShape([
    'src/platforms/apple/core/apps.ts',
    'src/platforms/harmonyos/app-lifecycle.ts',
    'src/platforms/linux/snapshot.ts',
    'src/platforms/vega/interactor.ts',
    'src/platforms/web/provider.ts',
  ]);

  assert.deepEqual(
    violations.map(({ file, rule }) => ({ file, rule })),
    [
      { file: 'src/platforms/apple/core/apps.ts', rule: 'platforms-root-shape' },
      { file: 'src/platforms/harmonyos/app-lifecycle.ts', rule: 'platforms-root-shape' },
      { file: 'src/platforms/linux/snapshot.ts', rule: 'platforms-root-shape' },
      { file: 'src/platforms/vega/interactor.ts', rule: 'platforms-root-shape' },
      { file: 'src/platforms/web/provider.ts', rule: 'platforms-root-shape' },
    ],
  );
});

test('capture-kit and platform workspace packages are R11-owned unranked zones', () => {
  assert.equal(classifyZone('capture-kit'), 'unranked');
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
  assert.match(found, /platform-harmonyos must export exactly its root façade/);
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

test('external consumers use root facades with static imports only at the interactor seam', () => {
  const staticImport = validSources();
  staticImport.set(
    'src/daemon/not-the-root.ts',
    "import { applePlatformMetadata } from '@agent-device/platform-apple';",
  );
  assert.match(
    messages(staticImport).join('\n'),
    /production static imports of '@agent-device\/platform-apple' are limited to src\/platform-runtime\.ts and src\/core\/interactors\//,
  );

  for (const statement of [
    "import type { AppleThing } from '@agent-device/platform-apple';",
    "void import('@agent-device/platform-apple');",
  ]) {
    const sources = validSources();
    sources.set('src/daemon/not-the-root.ts', statement);
    assert.match(
      messages(sources).join('\n'),
      /production static imports of '@agent-device\/platform-apple' are limited to/,
    );
  }

  const hostDynamic = validSources();
  hostDynamic.set(
    'src/platform-runtime-network-web-transport.ts',
    "void import('@agent-device/platform-web');",
  );
  assert.deepEqual(messages(hostDynamic), []);

  const hostTypeOnly = validSources();
  hostTypeOnly.set(
    'src/platform-runtime-network-web-transport.ts',
    "import type { WebThing } from '@agent-device/platform-web';",
  );
  assert.deepEqual(messages(hostTypeOnly), []);

  const hostStatic = validSources();
  hostStatic.set(
    'src/platform-runtime-network-web-transport.ts',
    "import { resolveWebProvider } from '@agent-device/platform-web';",
  );
  assert.match(
    messages(hostStatic).join('\n'),
    /production static imports of '@agent-device\/platform-web' are limited to/,
  );

  const interactor = validSources();
  interactor.set(
    'src/core/interactors/apple.ts',
    "import { applePlatformMetadata } from '@agent-device/platform-apple';",
  );
  assert.deepEqual(messages(interactor), []);

  const testConsumer = validSources();
  testConsumer.set(
    'test/integration/platform-fixture.ts',
    "import { applePlatformMetadata } from '@agent-device/platform-apple';",
  );
  assert.deepEqual(messages(testConsumer), []);

  const reExport = validSources();
  reExport.set(
    'src/daemon/not-the-root.ts',
    "export { applePlatformMetadata } from '@agent-device/platform-apple';",
  );
  assert.match(
    messages(reExport).join('\n'),
    /production static imports of '@agent-device\/platform-apple' are limited to src\/platform-runtime\.ts and src\/core\/interactors\//,
  );

  const deep = validSources();
  deep.set(
    'src/daemon/not-the-root.ts',
    "import { implementation } from '@agent-device/platform-apple/internal';",
  );
  assert.match(
    messages(deep).join('\n'),
    /only src\/platform-runtime\.ts or its governed request-provider composition submodule may import/,
  );

  const governed = validSources();
  governed.set(
    'src/platform-runtime/request-providers.ts',
    "void import('@agent-device/platform-web');",
  );
  assert.deepEqual(checkPlatformPackagePolicy(governed, declarations()), []);
});

test('only the canonical composition root may import the private provider composition submodule', () => {
  const sources = validSources();
  sources.set(
    'src/platform-runtime.ts',
    composition() + "\nvoid import('./platform-runtime/request-providers.ts');",
  );
  sources.set('src/platform-runtime/request-providers.ts', 'export const providerScope = true;');
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations()), []);

  sources.set(
    'src/daemon/request-router.ts',
    "import { providerScope } from '../platform-runtime/request-providers.ts';",
  );
  assert.match(
    messages(sources).join('\n'),
    /only src\/platform-runtime\.ts may import the private request-provider composition submodule/,
  );
});

test('the apple runner mechanics facet subpaths are the enumerated exception', () => {
  // The façade subpath is the facet's consumer seam: root code may import it.
  const sources = validSources();
  sources.set(
    'src/daemon/selector-runtime.ts',
    "import type { RunnerCommand } from '@agent-device/platform-apple/runner';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations()), []);

  // The host-bound client factory has exactly one composition root.
  const clientSources = validSources();
  clientSources.set(
    'packages/platform-apple/src/core/runner-client.ts',
    "import { createAppleRunnerClient } from '@agent-device/platform-apple/runner/client';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(clientSources, declarations()), []);
  clientSources.set(
    'src/daemon/handlers/session.ts',
    "import { createAppleRunnerClient } from '@agent-device/platform-apple/runner/client';",
  );
  assert.match(
    messages(clientSources).join('\n'),
    /only the composition root packages\/platform-apple\/src\/core\/runner-client\.ts may construct/,
  );

  // The test-host installer is a single vitest setup file, dynamic imports included.
  const testHostSources = validSources();
  testHostSources.set(
    'scripts/vitest-apple-runner-host-setup.ts',
    "import { installAppleRunnerTestHost } from '@agent-device/platform-apple/runner/test-host';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(testHostSources, declarations()), []);
  testHostSources.set(
    'src/platform-runtime.ts',
    composition() + "\nvoid import('@agent-device/platform-apple/runner/test-host');",
  );
  assert.match(
    messages(testHostSources).join('\n'),
    /only scripts\/vitest-apple-runner-host-setup\.ts may import/,
  );

  // A NEW unenumerated subpath widens the export list and fails declarations.
  const widened = declarations();
  const apple = widened.find((pkg) => pkg.family === 'apple')!;
  widened[widened.indexOf(apple)] = {
    ...apple,
    exportedSubpaths: [...apple.exportedSubpaths, '@agent-device/platform-apple/internal'],
  };
  assert.match(
    messages(validSources(), widened).join('\n'),
    /platform-apple must export exactly its root façade/,
  );
});

test('the Apple domain facades preserve synchronous helpers without widening the root facade', () => {
  const sources = validSources();
  for (const specifier of [
    '@agent-device/platform-apple/app-resolution',
    '@agent-device/platform-apple/interactions',
    '@agent-device/platform-apple/install-artifact',
    '@agent-device/platform-apple/perf',
    '@agent-device/platform-apple/physical-device',
    '@agent-device/platform-apple/runner-owner',
    '@agent-device/platform-apple/simctl',
    '@agent-device/platform-apple/simulator',
    '@agent-device/platform-apple/tool-provider',
  ]) {
    sources.set('src/platform-runtime-domain-facade.ts', `import '${specifier}';`);
    assert.deepEqual(checkPlatformPackagePolicy(sources, declarations()), []);
    sources.delete('src/platform-runtime-domain-facade.ts');
  }

  const widened = declarations();
  const apple = widened.find((pkg) => pkg.family === 'apple')!;
  widened[widened.indexOf(apple)] = {
    ...apple,
    exportedSubpaths: [...apple.exportedSubpaths, '@agent-device/platform-apple/internal'],
  };
  assert.match(
    messages(validSources(), widened).join('\n'),
    /platform-apple must export exactly its root façade/,
  );
});

test('the runner mechanics facet is exempt from ambient-host and raw-process rules the right way around', () => {
  // Production runner mechanics may own files/sockets (fs/net/os) directly...
  const sources = validSources();
  sources.set(
    'packages/platform-apple/src/runner/runner-lease.ts',
    ["import fs from 'node:fs';", "import os from 'node:os';", 'export const x = fs && os;'].join(
      '\n',
    ),
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations()), []);

  // ...but spawning stays banned: process execution goes through the host port.
  sources.set(
    'packages/platform-apple/src/runner/runner-artifact.ts',
    "import { spawn } from 'node:child_process';",
  );
  assert.match(messages(sources).join('\n'), /raw process primitives/);

  // Type-only naming of ChildProcess (the host port) and test-file fakes stay allowed.
  const allowed = validSources();
  allowed.set(
    'packages/platform-apple/src/runner/host.ts',
    "import type { ChildProcess } from 'node:child_process';",
  );
  allowed.set(
    'packages/platform-apple/src/runner/__tests__/runner-xctestrun.test.ts',
    "import { execFileSync } from 'node:child_process';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(allowed, declarations()), []);
});

test('platform packages may import the xml vocabulary package', () => {
  const sources = validSources();
  sources.set(
    'packages/platform-apple/src/runner/runner-usbmux.ts',
    "import { parseXml } from '@agent-device/xml';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations()), []);
});

test('the Android mechanics facet is the named consumer seam and adb host wiring is root-only', () => {
  const mechanicsImport =
    "import { resolveAndroidAdbExecutor } from '@agent-device/platform-android/mechanics';";
  const hostImport =
    "import { bindAndroidAdbHost } from '@agent-device/platform-android/adb-host';";
  const allowed = validSources();
  allowed.set('src/core/interactors/android.ts', mechanicsImport);
  allowed.set('src/sdk/android-adb.ts', mechanicsImport);
  allowed.set('src/daemon/handlers/session.test.ts', mechanicsImport);
  allowed.set('src/platform-runtime-android-adb-host.ts', hostImport);
  assert.deepEqual(
    messages(allowed).filter((message) => message.includes('may import')),
    [],
  );

  const denied = validSources();
  denied.set('src/daemon/handlers/session.ts', mechanicsImport);
  assert.match(
    messages(denied).join('\n'),
    /only src\/platform-runtime\.ts or its governed request-provider composition submodule may import '@agent-device\/platform-android\/mechanics'/,
  );

  const deniedHost = validSources();
  deniedHost.set('src/daemon/handlers/session.ts', hostImport);
  assert.match(
    messages(deniedHost).join('\n'),
    /only src\/platform-runtime\.ts or its governed request-provider composition submodule may import '@agent-device\/platform-android\/adb-host'/,
  );

  const androidMechanics = declarations();
  assert.deepEqual(messages(validSources(), androidMechanics), []);

  const androidWidened = androidMechanics.map((declaration) =>
    declaration.family === 'android'
      ? {
          ...declaration,
          exportedSubpaths: [...declaration.exportedSubpaths, `${declaration.name}/internal`],
        }
      : declaration,
  );
  assert.match(
    messages(validSources(), androidWidened).join('\n'),
    /platform-android must export exactly its root façade/,
  );
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
  // Raw-process cases plant in a PRODUCTION file: the ban is about mechanics
  // spawning at runtime, so test files (which fake process primitives) and
  // type-only imports (the runner host port names ChildProcess) are exempt.
  const planted = [
    ["import type { DaemonRequest } from '../../../src/daemon/types.ts';", 'probe.test.ts'],
    ["export { x } from '../../../src/core/x.ts';", 'probe.test.ts'],
    ["void import('@agent-device/platform-android');", 'probe.test.ts'],
    ["import { spawn } from 'node:child_process';", 'probe.ts'],
    ["import { execSync } from 'child_process';", 'probe.ts'],
  ] as const;
  for (const [statement, fileName] of planted) {
    const sources = validSources();
    sources.set(`packages/platform-apple/src/${fileName}`, statement);
    assert.ok(
      messages(sources).some((message) =>
        /may not reach root|may not import sibling|raw process primitives/.test(message),
      ),
      statement,
    );
  }
});

test('platform packages may use capture-kit but no unrelated workspace implementation package', () => {
  const allowed = validSources();
  allowed.set(
    'packages/platform-apple/src/probe.test.ts',
    "import { createAppLogLiveHandle } from '@agent-device/capture-kit';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(allowed, declarations()), []);

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
      /may import workspace code only from capture-kit, host-kit, provision-kit, contracts, kernel, or xml/,
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
      "import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';",
      "import { createAndroidObservationHost } from './platform-runtime-android-observation-host.ts';",
      "import { createPlatformRuntimeHost } from './platform-runtime-operation-host.ts';",
      "import { hostCommandRunner } from './platform-runtime-host/command.ts';",
      "import { createComposedDeviceInventoryGateways } from './platform-runtime-device-inventory.ts';",
      'void hostCommandRunner;',
      'void createComposedPlatformRuntimeGateway;',
      'void createAndroidObservationHost;',
      'void createPlatformRuntimeHost;',
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

test('the src/platforms root holds only the shared __tests__ directory', () => {
  const clean = ['src/platforms/__tests__/install-source.test.ts'];
  assert.deepEqual(checkPlatformsRootShape(clean), []);
});

test('a moved Android family cannot leave production or test files under the old root', () => {
  const planted = [
    'src/platforms/android/adb.ts',
    'src/platforms/android/__tests__/snapshot.test.ts',
  ];
  const found = checkPlatformsRootShape(planted);
  assert.deepEqual(
    found.map(({ file, message }) => ({ file, message })),
    planted.map((file) => ({
      file,
      message:
        'the Android family has moved to packages/platform-android; remove the superseded src/platforms/android path',
    })),
  );
});

test('a new direct production file or sibling directory under src/platforms fails closed', () => {
  const planted = [
    'src/platforms/shared-helper.ts',
    'src/platforms/common/util.ts',
    'src/platforms/perf-utils.ts',
  ];
  const found = checkPlatformsRootShape(planted);
  assert.deepEqual(
    found.map(({ file }) => file),
    planted,
  );
  for (const violation of found) {
    assert.equal(violation.rule, 'platforms-root-shape');
    assert.match(violation.message, /substrate package/);
  }
});

test('platform packages may import the provision-kit substrate', () => {
  const sources = validSources();
  sources.set(
    'packages/platform-apple/src/install.ts',
    "import { resolveInstallSource } from '@agent-device/provision-kit/install-source';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations()), []);
});

test('a provision-kit import of a concrete platform package fails closed', () => {
  const sources = validSources();
  sources.set(
    'packages/provision-kit/src/backdoor.ts',
    "import { runtimeModule } from '@agent-device/platform-android';",
  );
  assert.match(
    checkPlatformPackagePolicy(sources, declarations())
      .map(({ message }) => message)
      .join('\n'),
    /may import '@agent-device\/platform-android'/,
  );
});
