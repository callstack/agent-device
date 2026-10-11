import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImportEdges, type LayeringViolation } from './model.ts';
import {
  checkDaemonPlatformRuntimeInventory,
  DAEMON_PLATFORM_RUNTIME_EDGES,
  DAEMON_PLATFORM_RUNTIME_RULE,
  isRootPlatformRuntimeTarget,
} from './daemon-platform-runtime-inventory.ts';

// The classified pair these fixtures plant is the direct-iOS selector query: the one edge the
// PR-6 composition extraction left between the daemon and the root platform-runtime family, and
// the shortest live one whose symbols the rule still classifies.
const CLASSIFIED_TARGET = 'src/platform-runtime-apple-resources.ts';
const CLASSIFIED_STUB = 'export const queryAppleRuntimeSelector = () => ({});\n';
const CLASSIFIED_IMPORTER = 'src/daemon/direct-ios-selector.ts';

function violations(sources: Record<string, string>): LayeringViolation[] {
  return checkDaemonPlatformRuntimeInventory(resolveImportEdges(new Map(Object.entries(sources))));
}

function edgeViolations(sources: Record<string, string>, file: string): LayeringViolation[] {
  return violations(sources).filter((violation) => violation.file === file);
}

test('R76 accepts a classified edge with the exact recorded symbols', () => {
  const sources = {
    [CLASSIFIED_TARGET]: CLASSIFIED_STUB,
    [CLASSIFIED_IMPORTER]:
      "import { queryAppleRuntimeSelector } from '../platform-runtime-apple-resources.ts';\n" +
      'void queryAppleRuntimeSelector;\n',
  };
  assert.deepEqual(edgeViolations(sources, CLASSIFIED_IMPORTER), []);
});

for (const [file, target, symbol] of [
  ['request-recording-health', 'apple-resources', 'inspectAppleRunnerSession'],
  ['session-device-resolution', 'apple-resources', 'inspectAppleRunnerSession'],
  ['ios-app-session-hint', 'open-target', 'resolveSoleForegroundIosApp'],
]) {
  test(`R76 rejects retired observation mechanics in ${file}`, () => {
    const importer = `src/daemon/${file}.ts`;
    const sources = {
      [`src/platform-runtime-${target}.ts`]: `export function ${symbol}() {}\n`,
      [importer]: `import { ${symbol} } from '../platform-runtime-${target}.ts';\nvoid ${symbol};\n`,
    };
    const found = edgeViolations(sources, importer);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
    assert.match(found[0]!.message, /unclassified daemon coupling|classified symbols drifted/);
  });
}

test('R76 reports every classified edge missing from the tree as stale, not the other way around', () => {
  const sources = {
    [CLASSIFIED_TARGET]: CLASSIFIED_STUB,
    [CLASSIFIED_IMPORTER]:
      "import { queryAppleRuntimeSelector } from '../platform-runtime-apple-resources.ts';\n" +
      'void queryAppleRuntimeSelector;\n',
  };
  const stale = violations(sources).filter(
    (violation) => violation.file === 'scripts/layering/daemon-platform-runtime-inventory.ts',
  );
  assert.equal(stale.length, DAEMON_PLATFORM_RUNTIME_EDGES.length - 1);
  assert.ok(stale.every((violation) => violation.message.includes('stale classified edge')));
  const classifiedStale = stale.find((violation) => violation.message.includes(CLASSIFIED_TARGET));
  assert.equal(classifiedStale, undefined);
});

test('R76 rejects an unclassified edge with the pair and its line', () => {
  const sources = {
    'src/platform-runtime-android-tool-host.ts': 'export function createAndroidToolHost() {}\n',
    'src/daemon/fixture.ts':
      "import { createAndroidToolHost } from '../platform-runtime-android-tool-host.ts';\n" +
      'void createAndroidToolHost;\n',
  };
  const found = edgeViolations(sources, 'src/daemon/fixture.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.equal(found[0]!.line, 1);
  assert.match(found[0]!.message, /unclassified daemon coupling to platform mechanics/);
  assert.match(
    found[0]!.message,
    /src\/daemon\/fixture\.ts -> src\/platform-runtime-android-tool-host\.ts/,
  );
});

test('R76 rejects new symbols on a classified edge', () => {
  const sources = {
    [CLASSIFIED_TARGET]: CLASSIFIED_STUB + 'export function extraGatewayKnob() {}\n',
    [CLASSIFIED_IMPORTER]:
      "import { queryAppleRuntimeSelector, extraGatewayKnob } from '../platform-runtime-apple-resources.ts';\n" +
      'void [queryAppleRuntimeSelector, extraGatewayKnob];\n',
  };
  const found = edgeViolations(sources, CLASSIFIED_IMPORTER);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /classified symbols drifted/);
  assert.match(found[0]!.message, /extraGatewayKnob, queryAppleRuntimeSelector/);
});

test('R76 rejects a selector fast path assembled from an expanded query edge', () => {
  const sources = {
    'src/platform-runtime-apple-resources.ts':
      'export const queryAppleRuntimeSelector = () => ({});\n' +
      'export const queryProviderRuntimeSelector = () => ({});\n',
    'src/daemon/direct-ios-selector.ts':
      "import {\n  queryAppleRuntimeSelector,\n  queryProviderRuntimeSelector,\n} from '../platform-runtime-apple-resources.ts';\n" +
      'void [queryAppleRuntimeSelector, queryProviderRuntimeSelector];\n',
  };
  const found = edgeViolations(sources, 'src/daemon/direct-ios-selector.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /classified symbols drifted/);
  assert.match(found[0]!.message, /queryAppleRuntimeSelector, queryProviderRuntimeSelector/);
});

test('R76 matches a destructured dynamic import by target with the recorded bindings', () => {
  const sources = {
    'src/platform-runtime-apple-resources.ts': 'export const queryAppleRuntimeSelector = {};\n',
    'src/daemon/direct-ios-selector.ts':
      "const { queryAppleRuntimeSelector } = await import('../platform-runtime-apple-resources.ts');\n" +
      'void queryAppleRuntimeSelector;\n',
  };
  assert.deepEqual(edgeViolations(sources, 'src/daemon/direct-ios-selector.ts'), []);
});

test('R76 rejects an expanded destructured dynamic import on a classified edge', () => {
  const sources = {
    'src/platform-runtime-apple-resources.ts':
      'export const queryAppleRuntimeSelector = {};\n' +
      'export const extraLifecycleParticipant = {};\n',
    'src/daemon/direct-ios-selector.ts':
      "const { queryAppleRuntimeSelector, extraLifecycleParticipant } = await import('../platform-runtime-apple-resources.ts');\n" +
      'void [queryAppleRuntimeSelector, extraLifecycleParticipant];\n',
  };
  const found = edgeViolations(sources, 'src/daemon/direct-ios-selector.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /classified symbols drifted/);
  assert.match(found[0]!.message, /extraLifecycleParticipant, queryAppleRuntimeSelector/);
});

test('R76 rejects a rest binding next to a recorded dynamic-import binding', () => {
  const sources = {
    'src/platform-runtime-apple-resources.ts':
      'export const queryAppleRuntimeSelector = {};\n' +
      'export const sweepLifecycleParticipants = {};\n',
    'src/daemon/direct-ios-selector.ts':
      "const { queryAppleRuntimeSelector, ...lifecycleModule } = await import('../platform-runtime-apple-resources.ts');\n" +
      'void [queryAppleRuntimeSelector, lifecycleModule];\n',
  };
  const found = edgeViolations(sources, 'src/daemon/direct-ios-selector.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /unnameable dynamic-import binding/);
  assert.match(
    found[0]!.message,
    /src\/daemon\/direct-ios-selector\.ts -> src\/platform-runtime-apple-resources\.ts/,
  );
});

test('R76 rejects a computed destructure key on a classified dynamic import', () => {
  const sources = {
    'src/platform-runtime-apple-resources.ts': 'export const queryAppleRuntimeSelector = {};\n',
    'src/daemon/direct-ios-selector.ts':
      "const ownersName = 'queryAppleRuntimeSelector';\n" +
      'const { [ownersName]: owners } = await import("../platform-runtime-apple-resources.ts");\n' +
      'void owners;\n',
  };
  const found = edgeViolations(sources, 'src/daemon/direct-ios-selector.ts');
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /unnameable dynamic-import binding/);
});

test('R76 rejects a namespace-form dynamic import that hides the recorded bindings', () => {
  const sources = {
    'src/platform-runtime-apple-resources.ts': 'export const queryAppleRuntimeSelector = {};\n',
    'src/daemon/direct-ios-selector.ts':
      "const mod = await import('../platform-runtime-apple-resources.ts');\nvoid mod;\n",
  };
  const found = edgeViolations(sources, 'src/daemon/direct-ios-selector.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /open-ended dynamic import/);
});

test('R76 rejects a namespace import alongside the recorded named binding on the same pair', () => {
  const sources = {
    'src/platform-runtime-apple-resources.ts': 'export const queryAppleRuntimeSelector = {};\n',
    'src/daemon/direct-ios-selector.ts':
      "const { queryAppleRuntimeSelector } = await import('../platform-runtime-apple-resources.ts');\n" +
      "const lifecycleModule = await import('../platform-runtime-apple-resources.ts');\n" +
      'void [queryAppleRuntimeSelector, lifecycleModule];\n',
  };
  const found = edgeViolations(sources, 'src/daemon/direct-ios-selector.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /open-ended dynamic import/);
  assert.match(
    found[0]!.message,
    /src\/daemon\/direct-ios-selector\.ts -> src\/platform-runtime-apple-resources\.ts/,
  );
});

test('R76 treats the import and re-export of one classified pair as one entry', () => {
  const sources = {
    [CLASSIFIED_TARGET]: CLASSIFIED_STUB,
    [CLASSIFIED_IMPORTER]:
      "import { queryAppleRuntimeSelector } from '../platform-runtime-apple-resources.ts';\n" +
      "export { queryAppleRuntimeSelector } from '../platform-runtime-apple-resources.ts';\n" +
      'void queryAppleRuntimeSelector;\n',
  };
  assert.deepEqual(edgeViolations(sources, CLASSIFIED_IMPORTER), []);
});

test('R76 ignores test-shaped and non-daemon importers', () => {
  const sources = {
    'src/platform-runtime-android-tool-host.ts': 'export function createAndroidToolHost() {}\n',
    'src/daemon/__tests__/fixture.test.ts':
      "import { createAndroidToolHost } from '../platform-runtime-android-tool-host.ts';\n" +
      'void createAndroidToolHost;\n',
    'src/cli.ts':
      "import { createAndroidToolHost } from './platform-runtime-android-tool-host.ts';\n" +
      'void createAndroidToolHost;\n',
  };
  assert.deepEqual(
    violations(sources).filter(
      (violation) => violation.file !== 'scripts/layering/daemon-platform-runtime-inventory.ts',
    ),
    [],
  );
});

test('R76 ignores retired-zone targets, which R65 owns', () => {
  const sources = {
    'src/platforms/android.ts': 'export const legacy = 1;\n',
    'src/daemon/fixture.ts': 'import { legacy } from "../platforms/android.ts";\nvoid legacy;\n',
  };
  assert.deepEqual(edgeViolations(sources, 'src/daemon/fixture.ts'), []);
});

test('the root composition family is src/platform-runtime.ts plus src/platform-runtime-*.ts only', () => {
  assert.equal(isRootPlatformRuntimeTarget('src/platform-runtime.ts'), true);
  assert.equal(isRootPlatformRuntimeTarget('src/platform-runtime-android.ts'), true);
  assert.equal(isRootPlatformRuntimeTarget('src/platform-runtime-gateway.ts'), true);
  assert.equal(isRootPlatformRuntimeTarget('src/platform-runtime-android.tsx'), false);
  assert.equal(isRootPlatformRuntimeTarget('src/platform-runtime.ts.bak'), false);
  assert.equal(isRootPlatformRuntimeTarget('src/platforms/runtime.ts'), false);
  assert.equal(isRootPlatformRuntimeTarget('src/daemon/platform-runtime.ts'), false);
});

const ROOT_PLATFORM_STUB = 'export const gateway = 1;\nvoid gateway;\n';
test('R76 catches a daemon import of a root hub that reaches the platform family', () => {
  const sources = {
    'src/platform-runtime.ts': ROOT_PLATFORM_STUB,
    'src/hub-runtime.ts':
      "import { gateway } from './platform-runtime.ts';\nvoid gateway;\n" +
      'export function hubFact() {}\n',
    'src/daemon/fixture.ts': "import { hubFact } from '../hub-runtime.ts';\nvoid hubFact;\n",
  };
  const found = edgeViolations(sources, 'src/daemon/fixture.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /src\/daemon\/fixture\.ts -> src\/hub-runtime\.ts/);
});

test('R76 does not turn an intra-daemon hop into a classified hub edge', () => {
  const sources = {
    'src/platform-runtime.ts': ROOT_PLATFORM_STUB,
    'src/daemon/dispatch.ts':
      "import { gateway } from '../platform-runtime.ts';\nvoid gateway;\nexport function dispatch() {}\n",
    'src/daemon/handler.ts': "import { dispatch } from './dispatch.ts';\nvoid dispatch;\n",
  };
  assert.deepEqual(edgeViolations(sources, 'src/daemon/handler.ts'), []);
});
