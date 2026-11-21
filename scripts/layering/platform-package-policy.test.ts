import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  CANONICAL_PLATFORM_FAMILIES,
  checkPlatformPackagePolicy,
  checkRetiredPlatformsZone,
} from './platform-package-policy.ts';
import {
  MANAGED_FAMILIES,
  composition,
  declarations,
  facade,
  hostKitFindings,
  isManagedFamily,
  policyOptions,
  validSources,
} from './platform-package-policy.fixtures.ts';
import { classifyZone } from './model.ts';

function messages(sources: ReadonlyMap<string, string>, packages = declarations()): string[] {
  return checkPlatformPackagePolicy(sources, packages, policyOptions()).map(
    (violation) => violation.message,
  );
}

test('the inventory substrate has six private lazy packages and one exact composition root', () => {
  assert.deepEqual(checkPlatformPackagePolicy(validSources(), declarations(), policyOptions()), []);
});

test('retired platform family implementations are rejected from src/platforms', () => {
  const violations = checkRetiredPlatformsZone([
    'src/platforms/apple/core/apps.ts',
    'src/platforms/harmonyos/app-lifecycle.ts',
    'src/platforms/linux/snapshot.ts',
    'src/platforms/vega/interactor.ts',
    'src/platforms/web/provider.ts',
  ]);

  assert.deepEqual(
    violations.map(({ file, rule }) => ({ file, rule })),
    [
      { file: 'src/platforms/apple/core/apps.ts', rule: 'retired-platforms-zone' },
      { file: 'src/platforms/harmonyos/app-lifecycle.ts', rule: 'retired-platforms-zone' },
      { file: 'src/platforms/linux/snapshot.ts', rule: 'retired-platforms-zone' },
      { file: 'src/platforms/vega/interactor.ts', rule: 'retired-platforms-zone' },
      { file: 'src/platforms/web/provider.ts', rule: 'retired-platforms-zone' },
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
    ...policyOptions(),
    untrackedProductionFiles: ['packages/platform-apple/src/mechanics.ts'],
  });
  assert.match(found.map(({ message }) => message).join('\n'), /untracked production source/);
});

test('family packages are exact, private, and expose only their root facade', () => {
  const packages = declarations();
  packages[0] = { ...packages[0]!, private: false };
  packages[1] = { ...packages[1]!, name: '@agent-device/not-android' };
  packages[2] = { ...packages[2]!, managedClaim: { platform: 'linux', apiVersion: 3 } };
  packages[4] = {
    ...packages[4]!,
    exportedSubpaths: [packages[4]!.name, `${packages[4]!.name}/internal`],
  };
  packages.pop();

  const found = messages(validSources(), packages).join('\n');
  assert.match(found, /platform-apple must be private/);
  assert.match(found, /platform-android must be named '@agent-device\/platform-android'/);
  assert.match(
    found,
    /Managed platform must declare its family and export only @agent-device\/harmonyos\/agent-device/,
  );
  assert.match(
    found,
    /Managed platform must declare its family and export only @agent-device\/linux\/agent-device/,
  );
  assert.match(found, /missing canonical platform package.*platform-web/);
});

test('composition policy does not pin local platform-module identifier spelling', () => {
  const sources = validSources();
  sources.set(
    'src/platform-runtime.ts',
    composition().replaceAll('appleInventoryModule', 'selectedAppleModule'),
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations(), policyOptions()), []);
});

test('external consumers use root facades with static imports only at the interactor seam', () => {
  const staticImport = validSources();
  staticImport.set(
    'packages/daemon/src/not-the-root.ts',
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
    sources.set('packages/daemon/src/not-the-root.ts', statement);
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
    'packages/daemon/src/not-the-root.ts',
    "export { applePlatformMetadata } from '@agent-device/platform-apple';",
  );
  assert.match(
    messages(reExport).join('\n'),
    /production static imports of '@agent-device\/platform-apple' are limited to src\/platform-runtime\.ts and src\/core\/interactors\//,
  );

  const deep = validSources();
  deep.set(
    'packages/daemon/src/not-the-root.ts',
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
  assert.deepEqual(checkPlatformPackagePolicy(governed, declarations(), policyOptions()), []);
});

test('only the canonical composition root may import the private provider composition submodule', () => {
  const sources = validSources();
  sources.set(
    'src/platform-runtime.ts',
    composition() + "\nvoid import('./platform-runtime/request-providers.ts');",
  );
  sources.set('src/platform-runtime/request-providers.ts', 'export const providerScope = true;');
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations(), policyOptions()), []);

  sources.set(
    'packages/daemon/src/server/request-router.ts',
    "import { providerScope } from '../../../../src/platform-runtime/request-providers.ts';",
  );
  assert.match(
    messages(sources).join('\n'),
    /only src\/platform-runtime\.ts may import the private request-provider composition submodule/,
  );
});

test('the apple runner mechanics facet subpaths are the enumerated exception', () => {
  // The runner package entry is not a platform-apple subpath: platform-apple's composition and the
  // named root consumers (as a type or behind a deferred import) are its production importers.
  const sources = validSources();
  sources.set(
    'src/provider-device-runtime.ts',
    "import type { RunnerCommand } from '@agent-device/apple-runner';",
  );
  sources.set(
    'src/platform-runtime/request-providers.ts',
    "const { withAppleRunnerProvider } = await import('@agent-device/apple-runner');",
  );
  sources.set(
    'packages/platform-apple/src/core/runner-client.ts',
    "import { bindAppleRunnerHost } from '@agent-device/apple-runner';",
  );
  sources.set(
    'packages/daemon/src/execution/__tests__/selector-runtime.test.ts',
    "import { withAppleRunnerProvider } from '@agent-device/apple-runner';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations(), policyOptions()), []);

  // Any other production file, or a named root consumer that evaluates it, is refused.
  const refused = validSources();
  refused.set(
    'packages/daemon/src/execution/selector-runtime.ts',
    "import type { RunnerCommand } from '@agent-device/apple-runner';",
  );
  refused.set(
    'src/provider-device-runtime.ts',
    "import { withAppleRunnerProvider } from '@agent-device/apple-runner';",
  );
  const refusals = messages(refused);
  assert.equal(refusals.length, 2);
  assert.match(
    refusals.join('\n'),
    /only platform-apple's composition and the named root consumers may import/,
  );
  assert.match(refusals.join('\n'), /as a type or behind a deferred import/);

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

test('the runner test host is importable only from tests and __tests__ helpers', () => {
  const testHostSources = validSources();
  testHostSources.set(
    'packages/apple-runner/src/__tests__/host-setup.ts',
    "import { installAppleRunnerTestHost } from '../test-host.ts';",
  );
  testHostSources.set(
    'packages/apple-runner/src/runner-lifecycle.ts',
    "import { appleRunnerTestHost } from './test-host.ts';",
  );
  assert.match(
    messages(testHostSources).join('\n'),
    /apple-runner\/src\/test-host\.ts binds the runner test dispatcher/,
  );
  assert.equal(
    messages(testHostSources).filter((message) => message.includes('test dispatcher')).length,
    1,
  );
});

test('the Apple domain facades preserve synchronous helpers without widening the root facade', () => {
  const sources = validSources();
  for (const specifier of [
    '@agent-device/platform-apple/app-resolution',
    '@agent-device/platform-apple/install-artifact',
    '@agent-device/platform-apple/perf',
    '@agent-device/platform-apple/physical-device',
    '@agent-device/platform-apple/runner-owner',
    '@agent-device/platform-apple/simctl',
    '@agent-device/platform-apple/snapshot-source',
    '@agent-device/platform-apple/simulator',
    '@agent-device/platform-apple/tool-provider',
  ]) {
    sources.set('src/platform-runtime-domain-facade.ts', `import '${specifier}';`);
    assert.deepEqual(checkPlatformPackagePolicy(sources, declarations(), policyOptions()), []);
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
    'packages/apple-runner/src/runner-lease.ts',
    ["import fs from 'node:fs';", "import os from 'node:os';", 'export const x = fs && os;'].join(
      '\n',
    ),
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations(), policyOptions()), []);

  // ...but spawning stays banned: process execution goes through the host port.
  sources.set(
    'packages/apple-runner/src/runner-artifact.ts',
    "import { spawn } from 'node:child_process';",
  );
  assert.match(messages(sources).join('\n'), /raw process primitives/);

  // Type-only naming of ChildProcess (the host port) and test-file fakes stay allowed.
  const allowed = validSources();
  allowed.set(
    'packages/apple-runner/src/host.ts',
    "import type { ChildProcess } from 'node:child_process';",
  );
  allowed.set(
    'packages/apple-runner/src/__tests__/runner-xctestrun.test.ts',
    "import { execFileSync } from 'node:child_process';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(allowed, declarations(), policyOptions()), []);
});

test('platform packages may import the xml vocabulary package', () => {
  const sources = validSources();
  sources.set(
    'packages/apple-runner/src/runner-usbmux.ts',
    "import { parseXml } from '@agent-device/xml';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations(), policyOptions()), []);
});

test('the Android mechanics facet is the named consumer seam and adb host wiring is limited to the root binding and daemon composition', () => {
  const mechanicsImport =
    "import { resolveAndroidAdbExecutor } from '@agent-device/platform-android/mechanics';";
  const hostImport =
    "import { bindAndroidAdbHost } from '@agent-device/platform-android/adb-host';";
  const allowed = validSources();
  allowed.set('src/core/interactors/android.ts', mechanicsImport);
  allowed.set('src/sdk/android-adb.ts', mechanicsImport);
  allowed.set('packages/daemon/src/sessions/handlers/__tests__/session.test.ts', mechanicsImport);
  allowed.set('src/platform-runtime-android-adb-host.ts', hostImport);
  allowed.set('src/daemon-composition.ts', hostImport);
  assert.deepEqual(
    messages(allowed).filter((message) => message.includes('may import')),
    [],
  );

  const denied = validSources();
  denied.set('packages/daemon/src/sessions/handlers/session.ts', mechanicsImport);
  assert.match(
    messages(denied).join('\n'),
    /only src\/platform-runtime\.ts or its governed request-provider composition submodule may import '@agent-device\/platform-android\/mechanics'/,
  );

  const deniedHost = validSources();
  deniedHost.set('packages/daemon/src/sessions/handlers/session.ts', hostImport);
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

test('R13 leaves the Android test-only fixture subpaths to R83 for every consumer', () => {
  const fixtureImport =
    "import { createAndroidSnapshotCapture } from '@agent-device/platform-android/snapshot-capture-fixtures';";
  const allowed = validSources();
  allowed.set('src/__tests__/android-ui-hierarchy.test.ts', fixtureImport);
  allowed.set(
    'packages/daemon/src/execution/__tests__/android-system-dialog-occlusion.test.ts',
    fixtureImport,
  );
  allowed.set('test/integration/provider-scenarios/android.test.ts', fixtureImport);
  assert.deepEqual(messages(allowed), []);

  // Production importers of a fixture are R83's to refuse (package-export-surface.test.ts);
  // R13 holds no second list of them.
  for (const file of [
    'packages/command-surface/src/replay/index.ts',
    'src/core/interactors/android.ts',
  ]) {
    const production = validSources();
    production.set(file, fixtureImport);
    assert.deepEqual(messages(production), [], file);
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
  // Raw-process cases plant in a PRODUCTION file: the ban is about mechanics
  // spawning at runtime, so test files (which fake process primitives) and
  // type-only imports (the runner host port names ChildProcess) are exempt.
  const planted = [
    [
      "import type { DaemonRequest } from '../../../packages/daemon/src/types.ts';",
      'probe.test.ts',
    ],
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
  assert.deepEqual(checkPlatformPackagePolicy(allowed, declarations(), policyOptions()), []);

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
      /may import workspace code only from capture-kit, gestures, host-kit, provision-kit, contracts, kernel, or xml/,
    );
  }
});

test('platform-web production source may use only the canonical positional-ref selectors subpath', () => {
  const allowed = validSources();
  allowed.set(
    'packages/platform-web/src/interactor.ts',
    "import { stripAtPrefix } from '@agent-device/selectors/interaction-positionals';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(allowed, declarations(), policyOptions()), []);

  for (const [file, specifier] of [
    ['packages/platform-web/src/interactor.ts', '@agent-device/selectors'],
    ['packages/platform-web/src/interactor.ts', '@agent-device/selectors/selector-pipeline'],
    ['packages/platform-apple/src/probe.ts', '@agent-device/selectors/interaction-positionals'],
    ['packages/platform-linux/src/probe.ts', '@agent-device/selectors/interaction-positionals'],
  ] as const) {
    const sources = validSources();
    sources.set(file, `import { forbidden } from '${specifier}';`);
    assert.match(
      messages(sources).join('\n'),
      /may import workspace code only from capture-kit, gestures, host-kit, provision-kit, contracts, kernel, or xml/,
      `${file} ${specifier}`,
    );
  }

  for (const statement of [
    "import { x } from '../../platform-apple/src/index.ts';",
    "import { x } from '@agent-device/platform-apple';",
    "import { x } from '../../../src/core/interactors.ts';",
  ]) {
    const sources = validSources();
    sources.set(
      'packages/platform-web/src/interactor.ts',
      `import { stripAtPrefix } from '@agent-device/selectors/interaction-positionals';\n${statement}`,
    );
    assert.notDeepEqual(messages(sources), [], statement);
  }
});

test('the web interactor subpath is loaded only by the builtin registry, dynamically', () => {
  const family = 'web';
  const allowed = validSources();
  allowed.set(
    'src/core/interactors/register-builtins.ts',
    `const load = () => import('@agent-device/platform-${family}/interactor');`,
  );
  assert.deepEqual(checkPlatformPackagePolicy(allowed, declarations(), policyOptions()), [], family);

  for (const [file, source] of [
    [
      'src/core/interactors/register-builtins.ts',
      `import { x } from '@agent-device/platform-${family}/interactor';`,
    ],
    ['src/core/interactors.ts', `void import('@agent-device/platform-${family}/interactor');`],
    ['packages/daemon/src/probe.ts', `void import('@agent-device/platform-${family}/interactor');`],
    [
      'src/core/interactors/register-builtins.ts',
      `void import('@agent-device/platform-${family}/snapshot');`,
    ],
    [
      'packages/platform-linux/src/probe.ts',
      `void import('@agent-device/platform-${family}/interactor');`,
    ],
  ] as const) {
    const sources = validSources();
    sources.set(file, source);
    assert.notDeepEqual(messages(sources), [], `${family} ${file} ${source}`);
  }

  // A built-in package that declares a subpath nobody enumerated is rejected: the only declared
  // exceptions are the Apple and Android facets, and a new seam has to be named here first.
  const undeclared = declarations().map((declaration) =>
    declaration.family === 'android'
      ? {
          ...declaration,
          exportedSubpaths: [
            ...declaration.exportedSubpaths,
            '@agent-device/platform-android/not-a-seam',
          ],
        }
      : declaration,
  );
  assert.match(
    messages(validSources(), undeclared).join('\n'),
    /platform-android must export exactly its root façade.*mechanics subpaths/,
  );
});

test('platform package tests may import test-kit, production source may not', () => {
  const tests = validSources();
  tests.set(
    'packages/platform-apple/src/probe.test.ts',
    "import { mkdtempForTest } from '@agent-device/test-kit';",
  );
  tests.set(
    'packages/platform-apple/src/recording/fixtures.ts',
    "import { mkdtempForTest } from '@agent-device/test-kit';",
  );
  tests.set(
    'packages/platform-apple/src/probe.spec.ts',
    "import { mkdtempForTest } from '@agent-device/test-kit';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(tests, declarations(), policyOptions()), []);

  const production = validSources();
  production.set(
    'packages/platform-apple/src/probe.ts',
    "import { mkdtempForTest } from '@agent-device/test-kit';",
  );
  assert.match(
    messages(production).join('\n'),
    /may import workspace code only from capture-kit, gestures, host-kit, provision-kit, contracts, kernel, or xml/,
  );
});

test('package-owned tests may import their own public facade', () => {
  const sources = validSources();
  sources.set(
    'packages/platform-apple/src/index.test.ts',
    "import { inventoryModule } from '@agent-device/platform-apple';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations(), policyOptions()), []);
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
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations(), policyOptions()), []);
});

test('composition policy does not infer host authority from function or class names', () => {
  const sources = validSources();
  sources.set(
    'src/platform-runtime.ts',
    `${composition()}\nclass AppleHelperManager {}\nnew AppleHelperManager();\nprobeAndroidSdk();`,
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations(), policyOptions()), []);
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
      "import { attachAppleInstalledAppProbe } from './platform-runtime-device-inventory.ts';",
      'void hostCommandRunner;',
      'void createComposedPlatformRuntimeGateway;',
      'void createAndroidObservationHost;',
      'void createPlatformRuntimeHost;',
      'void attachAppleInstalledAppProbe;',
      'export type Scope = PlatformRequestScope;',
    ].join('\n'),
  );
  assert.ok(!messages(sources).some((message) => /composition imports only/.test(message)));

  sources.set('src/platform-runtime.ts', `${composition()}\nimport { daemon } from './daemon.ts';`);
  assert.match(messages(sources).join('\n'), /composition imports only/);
});

test('Node resolves only each platform package root facade', () => {
  for (const family of CANONICAL_PLATFORM_FAMILIES) {
    if (isManagedFamily(family)) continue;
    const specifier = `@agent-device/platform-${family}`;
    assert.ok(import.meta.resolve(specifier).endsWith(`packages/platform-${family}/src/index.ts`));
    assert.throws(
      () => import.meta.resolve(`${specifier}/src/index.ts`),
      /ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath/,
    );
  }
});

test('only the plugin scope resolves the managed web entry', () => {
  assert.throws(() => import.meta.resolve('@agent-device/web/agent-device'), /Cannot find package/);
  const resolveWeb = createRequire(
    new URL('../../packages/platform-web/package.json', import.meta.url),
  );
  assert.match(
    resolveWeb.resolve('@agent-device/web/agent-device'),
    /platform-web[/\\]src[/\\]index\.ts$/,
  );
  assert.throws(() => resolveWeb.resolve('@agent-device/web'), /No "exports" main/);
});

test('only the plugin scope resolves the managed Vega entry', () => {
  assert.throws(
    () => import.meta.resolve('@agent-device/vega/agent-device'),
    /Cannot find package/,
  );
  const resolveVega = createRequire(
    new URL('../../packages/platform-vega/package.json', import.meta.url),
  );
  assert.match(
    resolveVega.resolve('@agent-device/vega/agent-device'),
    /platform-vega[/\\]src[/\\]index\.ts$/,
  );
  assert.throws(() => resolveVega.resolve('@agent-device/vega'), /No "exports" main/);
});

test('only the plugin scope resolves the managed HarmonyOS entry', () => {
  assert.throws(
    () => import.meta.resolve('@agent-device/harmonyos/agent-device'),
    /Cannot find package/,
  );
  const resolveHarmony = createRequire(
    new URL('../../packages/platform-harmonyos/package.json', import.meta.url),
  );
  assert.match(
    resolveHarmony.resolve('@agent-device/harmonyos/agent-device'),
    /platform-harmonyos[/\\]src[/\\]index\.ts$/,
  );
  assert.throws(() => resolveHarmony.resolve('@agent-device/harmonyos'), /No "exports" main/);
});

test('the retired src/platforms zone rejects every production, test, and fixture file', () => {
  const planted = [
    'src/platforms/__tests__/install-source.test.ts',
    'src/platforms/__fixtures__/snapshot.json',
    'src/platforms/helper.mjs',
  ];
  const found = checkRetiredPlatformsZone(planted);
  assert.deepEqual(
    found.map(({ file, rule }) => ({ file, rule })),
    planted.map((file) => ({ file, rule: 'retired-platforms-zone' })),
  );
});

test('a moved Android family cannot leave production or test files under the old root', () => {
  const planted = [
    'src/platforms/android/adb.ts',
    'src/platforms/android/__tests__/snapshot.test.ts',
  ];
  const found = checkRetiredPlatformsZone(planted);
  assert.deepEqual(
    found.map(({ file, message }) => ({ file, message })),
    planted.map((file) => ({
      file,
      message:
        'src/platforms is retired; family code belongs in its platform package, shared mechanics in an owning substrate package, and cross-family tests in their root or package test owner',
    })),
  );
});

test('a new direct production file or sibling directory under src/platforms fails closed', () => {
  const planted = [
    'src/platforms/shared-helper.ts',
    'src/platforms/common/util.ts',
    'src/platforms/perf-utils.ts',
  ];
  const found = checkRetiredPlatformsZone(planted);
  assert.deepEqual(
    found.map(({ file }) => file),
    planted,
  );
  for (const violation of found) {
    assert.equal(violation.rule, 'retired-platforms-zone');
    assert.match(violation.message, /src\/platforms is retired/);
  }
});

test('platform packages may import the provision-kit substrate', () => {
  const sources = validSources();
  sources.set(
    'packages/platform-apple/src/install.ts',
    "import { resolveInstallSource } from '@agent-device/provision-kit/install-source';",
  );
  assert.deepEqual(checkPlatformPackagePolicy(sources, declarations(), policyOptions()), []);
});

test('a provision-kit import of a concrete platform package fails closed', () => {
  const sources = validSources();
  sources.set(
    'packages/provision-kit/src/backdoor.ts',
    "import { runtimeModule } from '@agent-device/platform-android';",
  );
  assert.match(
    checkPlatformPackagePolicy(sources, declarations(), policyOptions())
      .map(({ message }) => message)
      .join('\n'),
    /may import '@agent-device\/platform-android'/,
  );
});

test('managed platform code enters core only through the registry', () => {
  const file = 'src/platform-runtime/consumer.ts';
  const violations = checkPlatformPackagePolicy(
    new Map([
      ['src/platform-runtime.ts', ''],
      [file, "void import('@agent-device/web/agent-device')"],
    ]),
    declarations(),
  );
  assert.ok(
    violations.some(
      (finding) =>
        finding.file === file && finding.message.includes('only through the plugin registry'),
    ),
  );
});

// A managed plugin ships its own copy of host-kit, so the daemon's command scope and request
// diagnostic store never enter it: a runtime import of either runs outside the request the plugin was
// asked to serve. The plugin binds to the host its `setup` receives instead. No managed package
// carries an entry: every one of them is on the host.
for (const family of ['web', 'vega', 'harmonyos'] as const) {
  test(`a managed platform package may not reach the host-kit command or diagnostics scope (${family})`, () => {
    const file = `packages/platform-${family}/src/new-surface.ts`;
    for (const specifier of [
      '@agent-device/host-kit/command',
      '@agent-device/host-kit/diagnostics',
    ]) {
      const found = messages(
        new Map([
          ...validSources(),
          [file, `import { runCmd } from '${specifier}';\nvoid runCmd;`],
        ]),
      );
      assert.ok(
        found.some(
          (message) =>
            message.includes(`@agent-device/${family} may not import the host-kit`) &&
            message.includes('PlatformHost given to setup'),
        ),
        `${family} must not spawn or trace through its own host-kit copy: ${specifier}`,
      );
    }
  });
}

test('a type-only host-kit import stays legal in a managed platform package', () => {
  const sources = new Map([
    ...validSources(),
    [
      'packages/platform-harmonyos/src/new-surface.ts',
      "import type { HostCommandResult } from '@agent-device/host-kit/command';\nexport type R = HostCommandResult;",
    ],
  ]);
  assert.deepEqual(
    checkPlatformPackagePolicy(sources, declarations(), policyOptions()).filter((violation) =>
      violation.message.includes('host-kit'),
    ),
    [],
  );
});

// The same rule covers the scopes the hand-kept list never enumerated, with no second list: the file
// scope's lock mechanics are refused for the same reason the process scope's probes are, because the
// host-kit graph shows they reach `internal/exec.ts` through the bundled copy.
for (const family of ['web', 'vega', 'harmonyos'] as const) {
  test(`a managed platform package may not take the process lock through its own host-kit copy (${family})`, () => {
    const found = hostKitFindings(
      family,
      "import { acquireProcessLock, withProcessLock } from '@agent-device/host-kit/file';\nvoid acquireProcessLock; void withProcessLock;",
    );
    assert.match(
      found,
      new RegExp(
        String.raw`@agent-device/${family} may not import the host-kit '@agent-device/host-kit/file' scope at runtime \(acquireProcessLock, withProcessLock\): .*PlatformHost given to setup`,
      ),
    );
  });
}

// One name's verdict follows its own declaration: the liveness classifier reaches the exec layer and
// is refused, while the pid arithmetic declared beside it in the same module graph does not.
test('the host-kit process scope is judged name by name, not per subpath', () => {
  const refused = hostKitFindings(
    'web',
    "import { classifyOwnerLivenessFromObservation } from '@agent-device/host-kit/process';\nvoid classifyOwnerLivenessFromObservation;",
  );
  assert.match(
    refused,
    /host-kit\/process' scope at runtime \(classifyOwnerLivenessFromObservation\)/,
  );
  const allowed = hostKitFindings(
    'web',
    "import { uniquePositivePids } from '@agent-device/host-kit/process';\nvoid uniquePositivePids;",
  );
  assert.equal(allowed, '');
});

// Nothing about an export's name is consulted, so a new export that starts loading the exec layer is
// caught without anyone editing a list: the same import turns from allowed to refused on the edit.
test('the exec reachability of a host-kit export is derived, not declared', () => {
  const entryPath = 'packages/host-kit/src/alpha.ts';
  const helperPath = 'packages/host-kit/src/internal/alpha-helper.ts';
  const execPath = 'packages/host-kit/src/internal/exec.ts';
  const importSource = "import { pureProbe } from '@agent-device/host-kit/alpha';\nvoid pureProbe;";
  const scan = (helperSource: string) => {
    const sources = new Map([
      [entryPath, "export { pureProbe } from './internal/alpha-helper.ts';"],
      [helperPath, helperSource],
      [execPath, 'export function runCmd(): void {}\n'],
      ['packages/platform-web/src/new-surface.ts', importSource],
    ]);
    return checkPlatformPackagePolicy(sources, declarations(), { hostKitSources: sources }).filter(
      (violation) => violation.message.includes('may not import the host-kit'),
    );
  };

  assert.deepEqual(scan('export function pureProbe(): number {\n  return 1;\n}\n'), []);

  // The same export name, now declared by a module that loads the exec layer.
  const flagged = scan(
    "import { runCmd } from './exec.ts';\nexport function pureProbe(): void {\n  runCmd();\n}\n",
  );
  assert.equal(flagged.length, 1);
  assert.match(
    flagged[0]!.message,
    /host-kit\/alpha' scope at runtime \(pureProbe\): .*PlatformHost given to setup/,
  );
});

// A root the derivation walks has to be in the scan: a move of either would otherwise answer
// "no export reaches the exec layer" for every managed plugin at once.
test('a missing exec-root source makes the derivation fail closed', () => {
  const sources = new Map([
    ['packages/host-kit/src/alpha.ts', 'export function pureProbe(): number {\n  return 1;\n}\n'],
  ]);
  const found = checkPlatformPackagePolicy(sources, declarations(), { hostKitSources: sources });
  assert.match(
    found.map(({ message }) => message).join('\n'),
    /stale module: packages\/host-kit\/src\/internal\/exec\.ts is not a tracked source/,
  );
});

// `host-kit/process` is policed export by export: an export that spawns a process tool escapes the
// request's exec trace from a bundled plugin, and one that reads only this process's globals cannot.
// `PlatformHost.processes` answers the first kind on the core's own copy. An edge naming no export
// could reach any of them, so a namespace import is refused rather than assumed harmless. Every case
// is asserted for every managed family: all three are on the host by the same rule.
const PROCESS_SCOPE_CASES = [
  [
    'may not run a process tool through its own host-kit copy',
    "import { listHostProcesses, readProcessIdentities } from '@agent-device/host-kit/process';\nvoid listHostProcesses; void readProcessIdentities;",
    String.raw`@agent-device/%FAMILY% may not import the host-kit '@agent-device/host-kit/process' scope at runtime \(listHostProcesses, readProcessIdentities\): .*PlatformHost given to setup`,
  ],
  [
    'keeps the process exports that read no process tool',
    "import { expandProcessTree, hostPlatform, isProcessAlive } from '@agent-device/host-kit/process';\nvoid expandProcessTree; void hostPlatform; void isProcessAlive;",
    '^$',
  ],
  [
    'may not namespace-import the process scope',
    "import * as hostProcess from '@agent-device/host-kit/process';\nvoid hostProcess;",
    String.raw`@agent-device/%FAMILY% may not import the host-kit '@agent-device/host-kit/process' scope at runtime \(.*readProcessIdentities.*\)`,
  ],
] as const;

for (const family of MANAGED_FAMILIES) {
  for (const [label, source, refusal] of PROCESS_SCOPE_CASES) {
    test(`a managed platform package ${label} (${family})`, () => {
      const named = new RegExp(refusal.replaceAll('%FAMILY%', family));
      assert.match(hostKitFindings(family, source), named);
    });
  }
}
