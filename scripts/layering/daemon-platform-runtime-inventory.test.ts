import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImportEdges, type LayeringViolation } from './model.ts';
import {
  checkDaemonPlatformRuntimeInventory,
  DAEMON_PLATFORM_RUNTIME_RULE,
  isRootPlatformRuntimeTarget,
} from './daemon-platform-runtime-inventory.ts';

// The pair these fixtures plant is the direct-iOS selector query: the last edge the #2278
// inventory carried, retired by #3430. Under the ban it is a violation like any other.
const RETIRED_TARGET = 'src/platform-runtime-apple-resources.ts';
const RETIRED_STUB = 'export const queryAppleRuntimeSelector = () => ({});\n';
const RETIRED_IMPORTER = 'packages/daemon/src/core/direct-ios-selector.ts';

function violations(sources: Record<string, string>): LayeringViolation[] {
  return checkDaemonPlatformRuntimeInventory(resolveImportEdges(new Map(Object.entries(sources))));
}

function edgeViolations(sources: Record<string, string>, file: string): LayeringViolation[] {
  return violations(sources).filter((violation) => violation.file === file);
}

test('R76 rejects the direct-iOS selector edge the retired inventory classified', () => {
  const sources = {
    [RETIRED_TARGET]: RETIRED_STUB,
    [RETIRED_IMPORTER]:
      "import { queryAppleRuntimeSelector } from '../../../../src/platform-runtime-apple-resources.ts';\n" +
      'void queryAppleRuntimeSelector;\n',
  };
  const found = edgeViolations(sources, RETIRED_IMPORTER);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /daemon coupling to root platform mechanics is banned/);
  assert.match(
    found[0]!.message,
    /packages\/daemon\/src\/core\/direct-ios-selector\.ts -> src\/platform-runtime-apple-resources\.ts/,
  );
});

for (const [file, target, symbol] of [
  ['request-recording-health', 'apple-resources', 'inspectAppleRunnerSession'],
  ['session-device-resolution', 'apple-resources', 'inspectAppleRunnerSession'],
  ['ios-app-session-hint', 'open-target', 'resolveSoleForegroundIosApp'],
]) {
  test(`R76 rejects retired observation mechanics in ${file}`, () => {
    const importer = `packages/daemon/src/${file}.ts`;
    const sources = {
      [`src/platform-runtime-${target}.ts`]: `export function ${symbol}() {}\n`,
      [importer]: `import { ${symbol} } from '../../../src/platform-runtime-${target}.ts';\nvoid ${symbol};\n`,
    };
    const found = edgeViolations(sources, importer);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
    assert.match(found[0]!.message, /daemon coupling to root platform mechanics is banned/);
  });
}

test('R76 rejects an edge with the pair and its line', () => {
  const sources = {
    'src/platform-runtime-android-tool-host.ts': 'export function createAndroidToolHost() {}\n',
    'packages/daemon/src/fixture.ts':
      "import { createAndroidToolHost } from '../../../src/platform-runtime-android-tool-host.ts';\n" +
      'void createAndroidToolHost;\n',
  };
  const found = edgeViolations(sources, 'packages/daemon/src/fixture.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.equal(found[0]!.line, 1);
  assert.match(found[0]!.message, /daemon coupling to root platform mechanics is banned/);
  assert.match(
    found[0]!.message,
    /packages\/daemon\/src\/fixture\.ts -> src\/platform-runtime-android-tool-host\.ts/,
  );
});

test('R76 reports an import and re-export of one pair as a single violation', () => {
  const sources = {
    [RETIRED_TARGET]: RETIRED_STUB,
    [RETIRED_IMPORTER]:
      "import { queryAppleRuntimeSelector } from '../../../../src/platform-runtime-apple-resources.ts';\n" +
      "export { queryAppleRuntimeSelector } from '../../../../src/platform-runtime-apple-resources.ts';\n" +
      'void queryAppleRuntimeSelector;\n',
  };
  assert.equal(edgeViolations(sources, RETIRED_IMPORTER).length, 1);
});

test('R76 rejects a destructured dynamic import of the root platform-runtime family', () => {
  const sources = {
    [RETIRED_TARGET]: RETIRED_STUB,
    [RETIRED_IMPORTER]:
      "const { queryAppleRuntimeSelector } = await import('../../../../src/platform-runtime-apple-resources.ts');\n" +
      'void queryAppleRuntimeSelector;\n',
  };
  assert.equal(edgeViolations(sources, RETIRED_IMPORTER).length, 1);
});

test('R76 rejects a dynamic namespace import of a root platform-runtime module', () => {
  const sources = {
    [RETIRED_TARGET]: RETIRED_STUB,
    [RETIRED_IMPORTER]:
      "const appleResources = await import('../../../../src/platform-runtime-apple-resources.ts');\n" +
      'void appleResources;\n',
  };
  const found = edgeViolations(sources, RETIRED_IMPORTER);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(
    found[0]!.message,
    /packages\/daemon\/src\/core\/direct-ios-selector\.ts -> src\/platform-runtime-apple-resources\.ts/,
  );
});

test('R76 ignores test-shaped and non-daemon importers', () => {
  const sources = {
    'src/platform-runtime-android-tool-host.ts': 'export function createAndroidToolHost() {}\n',
    'packages/daemon/src/__tests__/fixture.test.ts':
      "import { createAndroidToolHost } from '../../../src/platform-runtime-android-tool-host.ts';\n" +
      'void createAndroidToolHost;\n',
    'src/cli.ts':
      "import { createAndroidToolHost } from './platform-runtime-android-tool-host.ts';\n" +
      'void createAndroidToolHost;\n',
  };
  assert.deepEqual(violations(sources), []);
});

test('R76 ignores retired-zone targets, which R65 owns', () => {
  const sources = {
    'src/platforms/android.ts': 'export const legacy = 1;\n',
    'packages/daemon/src/fixture.ts':
      'import { legacy } from "../../../src/platforms/android.ts";\nvoid legacy;\n',
  };
  assert.deepEqual(edgeViolations(sources, 'packages/daemon/src/fixture.ts'), []);
});

test('the root composition family is src/platform-runtime.ts plus src/platform-runtime-*.ts only', () => {
  assert.equal(isRootPlatformRuntimeTarget('src/platform-runtime.ts'), true);
  assert.equal(isRootPlatformRuntimeTarget('src/platform-runtime-android.ts'), true);
  assert.equal(isRootPlatformRuntimeTarget('src/platform-runtime-gateway.ts'), true);
  assert.equal(isRootPlatformRuntimeTarget('src/platform-runtime-android.tsx'), false);
  assert.equal(isRootPlatformRuntimeTarget('src/platform-runtime.ts.bak'), false);
  assert.equal(isRootPlatformRuntimeTarget('src/platforms/runtime.ts'), false);
  assert.equal(isRootPlatformRuntimeTarget('packages/daemon/src/platform-runtime.ts'), false);
});

const ROOT_PLATFORM_STUB = 'export const gateway = 1;\nvoid gateway;\n';
test('R76 catches a daemon import of a root hub that reaches the platform family', () => {
  const sources = {
    'src/platform-runtime.ts': ROOT_PLATFORM_STUB,
    'src/hub-runtime.ts':
      "import { gateway } from './platform-runtime.ts';\nvoid gateway;\n" +
      'export function hubFact() {}\n',
    'packages/daemon/src/fixture.ts':
      "import { hubFact } from '../../../src/hub-runtime.ts';\nvoid hubFact;\n",
  };
  const found = edgeViolations(sources, 'packages/daemon/src/fixture.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /packages\/daemon\/src\/fixture\.ts -> src\/hub-runtime\.ts/);
});

test('R76 does not turn an intra-daemon hop into a hub edge', () => {
  const sources = {
    'src/platform-runtime.ts': ROOT_PLATFORM_STUB,
    'packages/daemon/src/dispatch.ts':
      "import { gateway } from '../../../src/platform-runtime.ts';\nvoid gateway;\nexport function dispatch() {}\n",
    'packages/daemon/src/handler.ts': "import { dispatch } from './dispatch.ts';\nvoid dispatch;\n",
  };
  assert.deepEqual(edgeViolations(sources, 'packages/daemon/src/handler.ts'), []);
  assert.equal(
    violations(sources).filter((violation) => violation.file === 'packages/daemon/src/dispatch.ts')
      .length,
    1,
  );
});
