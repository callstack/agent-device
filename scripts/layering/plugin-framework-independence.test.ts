// R85: the plugin framework imports and declares no concrete provider package.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkPluginFrameworkIndependence,
  PLUGIN_FRAMEWORK_INDEPENDENCE_RULE,
} from './plugin-framework-independence.ts';
import { readTrackedPackageManifests } from './package-boundaries.ts';
import { listTrackedTypeScriptFiles } from './tracked-sources.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const PROVIDER_ENTRY = "'@agent-device/provider-webdriver/plugin'";

function manifests(plugins: Record<string, unknown> = {}): Map<string, string> {
  return new Map([
    [
      'packages/plugins/package.json',
      JSON.stringify({ name: '@agent-device/plugins', ...plugins }),
    ],
    [
      'packages/provider-webdriver/package.json',
      JSON.stringify({ name: '@agent-device/provider-webdriver' }),
    ],
    ['packages/provider-testmu/package.json', JSON.stringify({ name: '@agent-device/testmu' })],
    ['packages/kernel/package.json', JSON.stringify({ name: '@agent-device/kernel' })],
  ]);
}

function check(source: string, file = 'packages/plugins/src/load.ts') {
  return checkPluginFrameworkIndependence(manifests(), new Map([[file, source]]));
}

test('the real plugin framework declares and imports no provider package', () => {
  const sources = new Map(
    listTrackedTypeScriptFiles(repoRoot).map((file) => [
      file,
      fs.readFileSync(path.join(repoRoot, file), 'utf8'),
    ]),
  );
  assert.deepEqual(
    checkPluginFrameworkIndependence(readTrackedPackageManifests(repoRoot), sources),
    [],
  );
});

test('R85 rejects a static, type-only, dynamic, re-export, inline-type or mocked provider import', () => {
  for (const source of [
    `import { createCloudWebDriverRuntime } from ${PROVIDER_ENTRY};`,
    `import type { CloudWebDriverProviderOptions } from ${PROVIDER_ENTRY};`,
    `const { createCloudWebDriverRuntime } = await import(${PROVIDER_ENTRY});`,
    `export { createCloudWebDriverRuntime } from ${PROVIDER_ENTRY};`,
    `type Options = import(${PROVIDER_ENTRY}).CloudWebDriverProviderOptions;`,
    `vi.mock(${PROVIDER_ENTRY}, () => ({}));`,
    `vi.mock(${PROVIDER_ENTRY.replaceAll("'", '`')}, () => ({}));`,
    `vi['mock'](${PROVIDER_ENTRY}, () => ({}));`,
    `vi.doMock(${PROVIDER_ENTRY});`,
    `vi.unmock(${PROVIDER_ENTRY});`,
    `await vi.importActual(${PROVIDER_ENTRY});`,
    `await vi.importMock(${PROVIDER_ENTRY});`,
    `vi.mock(import(${PROVIDER_ENTRY}));`,
    `import plugin from '@agent-device/testmu';`,
    `import { vi as mocks } from 'vitest';\nmocks.mock(${PROVIDER_ENTRY});`,
    `import { vitest as mocks } from 'vitest';\nmocks.doMock(${PROVIDER_ENTRY});`,
    `import * as testing from 'vitest';\ntesting.vi.mock(${PROVIDER_ENTRY});`,
    `import * as testing from 'vitest';\ntesting['vitest']['importActual'](${PROVIDER_ENTRY});`,
  ]) {
    const [result, ...rest] = check(source);
    assert.equal(rest.length, 0, source);
    assert.equal(result?.rule, PLUGIN_FRAMEWORK_INDEPENDENCE_RULE, source);
    assert.equal(result?.file, 'packages/plugins/src/load.ts', source);
  }
});

test('R85 rejects a provider package listed in any dependency field of the plugins manifest', () => {
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const result = checkPluginFrameworkIndependence(
      manifests({ [field]: { '@agent-device/provider-webdriver': 'workspace:*' } }),
      new Map(),
    );
    assert.deepEqual(
      result.map(({ file }) => file),
      ['packages/plugins/package.json'],
      field,
    );
  }
});

test('R85 admits the foundations the framework builds on and imports elsewhere in the repo', () => {
  assert.deepEqual(check(`import { AppError } from '@agent-device/kernel/errors';`), []);
  assert.deepEqual(
    checkPluginFrameworkIndependence(
      manifests({ dependencies: { '@agent-device/kernel': 'workspace:*' } }),
      new Map([
        ['src/provider-plugin-policy.ts', `import('@agent-device/provider-webdriver/plugin');`],
      ]),
    ),
    [],
  );
});

test('R85 ignores a provider named only in a comment, a non-literal mock argument or another object', () => {
  for (const source of [
    `// vi.mock(${PROVIDER_ENTRY});`,
    'vi.mock(`@agent-device/provider-webdriver/${entry}`);',
    `other.mock(${PROVIDER_ENTRY});`,
    `import { vi as mocks } from 'not-vitest';\nmocks.mock(${PROVIDER_ENTRY});`,
    `import { expect as mocks } from 'vitest';\nmocks.mock(${PROVIDER_ENTRY});`,
    `import type { vi as mocks } from 'vitest';\nmocks.mock(${PROVIDER_ENTRY});`,
    `import * as testing from 'vitest';\ntesting.expect.mock(${PROVIDER_ENTRY});`,
    `import { vi as mocks } from 'vitest';\nfunction f(mocks) { mocks.mock(${PROVIDER_ENTRY}); }`,
  ]) {
    assert.deepEqual(check(source), [], source);
  }
});
