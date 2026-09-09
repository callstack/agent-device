import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImportEdges, type LayeringViolation } from './model.ts';
import {
  checkDaemonPlatformRuntimeInventory,
  DAEMON_PLATFORM_RUNTIME_EDGES,
  DAEMON_PLATFORM_RUNTIME_RULE,
  isRootPlatformRuntimeTarget,
} from './daemon-platform-runtime-inventory.ts';

const DEVICE_READY_TARGET = 'src/platform-runtime-device-ready.ts';
const DEVICE_READY_STUB =
  'export async function ensureLocalPlatformDeviceReady(device: unknown) { return false; }\n';

function violations(sources: Record<string, string>): LayeringViolation[] {
  return checkDaemonPlatformRuntimeInventory(resolveImportEdges(new Map(Object.entries(sources))));
}

function edgeViolations(sources: Record<string, string>, file: string): LayeringViolation[] {
  return violations(sources).filter((violation) => violation.file === file);
}

test('R76 accepts a classified edge with the exact recorded symbols', () => {
  const sources = {
    [DEVICE_READY_TARGET]: DEVICE_READY_STUB,
    'src/daemon/device-ready.ts':
      "import { ensureLocalPlatformDeviceReady } from '../platform-runtime-device-ready.ts';\n" +
      'void ensureLocalPlatformDeviceReady;\n',
  };
  assert.deepEqual(edgeViolations(sources, 'src/daemon/device-ready.ts'), []);
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
    assert.match(found[0]!.message, /unclassified daemon-to-root|classified symbols drifted/);
  });
}

test('R76 reports every classified edge missing from the tree as stale, not the other way around', () => {
  const sources = {
    [DEVICE_READY_TARGET]: DEVICE_READY_STUB,
    'src/daemon/device-ready.ts':
      "import { ensureLocalPlatformDeviceReady } from '../platform-runtime-device-ready.ts';\n" +
      'void ensureLocalPlatformDeviceReady;\n',
  };
  const stale = violations(sources).filter(
    (violation) => violation.file === 'scripts/layering/daemon-platform-runtime-inventory.ts',
  );
  assert.equal(stale.length, DAEMON_PLATFORM_RUNTIME_EDGES.length - 1);
  assert.ok(stale.every((violation) => violation.message.includes('stale classified edge')));
  const deviceReadyStale = stale.find((violation) =>
    violation.message.includes(DEVICE_READY_TARGET),
  );
  assert.equal(deviceReadyStale, undefined);
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
  assert.match(found[0]!.message, /unclassified daemon-to-root platform-runtime coupling/);
  assert.match(
    found[0]!.message,
    /src\/daemon\/fixture\.ts -> src\/platform-runtime-android-tool-host\.ts/,
  );
});

test('R76 rejects new symbols on a classified edge', () => {
  const sources = {
    [DEVICE_READY_TARGET]: DEVICE_READY_STUB + 'export function extraReadiness() {}\n',
    'src/daemon/device-ready.ts':
      "import { ensureLocalPlatformDeviceReady, extraReadiness } from '../platform-runtime-device-ready.ts';\n" +
      'void [ensureLocalPlatformDeviceReady, extraReadiness];\n',
  };
  const found = edgeViolations(sources, 'src/daemon/device-ready.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /classified symbols drifted/);
  assert.match(found[0]!.message, /ensureLocalPlatformDeviceReady, extraReadiness/);
});

test('R76 rejects a reintroduced Android-mechanics import on the selector-dispatch edge', () => {
  const sources = {
    'src/platform-runtime-open-target.ts':
      'export async function resolveSessionAppBundleIdForTarget() { return undefined; }\n' +
      'export async function resolveAndroidPackageForOpen() { return undefined; }\n',
    'src/daemon/handlers/session-selector-dispatch.ts':
      "import { resolveAndroidPackageForOpen, resolveSessionAppBundleIdForTarget } from '../../platform-runtime-open-target.ts';\n" +
      'void [resolveAndroidPackageForOpen, resolveSessionAppBundleIdForTarget];\n',
  };
  const found = edgeViolations(sources, 'src/daemon/handlers/session-selector-dispatch.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /classified symbols drifted/);
  assert.match(
    found[0]!.message,
    /resolveAndroidPackageForOpen, resolveSessionAppBundleIdForTarget/,
  );
});

test('R76 matches a destructured dynamic import by target with the recorded bindings', () => {
  const sources = {
    'src/platform-runtime-daemon-lifecycle.ts':
      'export const platformDaemonLifecycleOwners = {};\n',
    'src/daemon/server/daemon-runtime.ts':
      "const { platformDaemonLifecycleOwners } = await import('../../platform-runtime-daemon-lifecycle.ts');\n" +
      'void platformDaemonLifecycleOwners;\n',
  };
  assert.deepEqual(edgeViolations(sources, 'src/daemon/server/daemon-runtime.ts'), []);
});

test('R76 rejects an expanded destructured dynamic import on a classified edge', () => {
  const sources = {
    'src/platform-runtime-daemon-lifecycle.ts':
      'export const platformDaemonLifecycleOwners = {};\n' +
      'export const extraLifecycleParticipant = {};\n',
    'src/daemon/server/daemon-runtime.ts':
      "const { platformDaemonLifecycleOwners, extraLifecycleParticipant } = await import('../../platform-runtime-daemon-lifecycle.ts');\n" +
      'void [platformDaemonLifecycleOwners, extraLifecycleParticipant];\n',
  };
  const found = edgeViolations(sources, 'src/daemon/server/daemon-runtime.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /classified symbols drifted/);
  assert.match(found[0]!.message, /extraLifecycleParticipant, platformDaemonLifecycleOwners/);
});

test('R76 rejects a rest binding next to a recorded dynamic-import binding', () => {
  const sources = {
    'src/platform-runtime-daemon-lifecycle.ts':
      'export const platformDaemonLifecycleOwners = {};\n' +
      'export const sweepLifecycleParticipants = {};\n',
    'src/daemon/server/daemon-runtime.ts':
      "const { platformDaemonLifecycleOwners, ...lifecycleModule } = await import('../../platform-runtime-daemon-lifecycle.ts');\n" +
      'void [platformDaemonLifecycleOwners, lifecycleModule];\n',
  };
  const found = edgeViolations(sources, 'src/daemon/server/daemon-runtime.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /unnameable dynamic-import binding/);
  assert.match(
    found[0]!.message,
    /src\/daemon\/server\/daemon-runtime\.ts -> src\/platform-runtime-daemon-lifecycle\.ts/,
  );
});

test('R76 rejects a computed destructure key on a classified dynamic import', () => {
  const sources = {
    'src/platform-runtime-daemon-lifecycle.ts':
      'export const platformDaemonLifecycleOwners = {};\n',
    'src/daemon/server/daemon-runtime.ts':
      "const ownersName = 'platformDaemonLifecycleOwners';\n" +
      'const { [ownersName]: owners } = await import("../../platform-runtime-daemon-lifecycle.ts");\n' +
      'void owners;\n',
  };
  const found = edgeViolations(sources, 'src/daemon/server/daemon-runtime.ts');
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /unnameable dynamic-import binding/);
});

test('R76 rejects a namespace-form dynamic import that hides the recorded bindings', () => {
  const sources = {
    'src/platform-runtime-daemon-lifecycle.ts':
      'export const platformDaemonLifecycleOwners = {};\n',
    'src/daemon/server/daemon-runtime.ts':
      "const mod = await import('../../platform-runtime-daemon-lifecycle.ts');\nvoid mod;\n",
  };
  const found = edgeViolations(sources, 'src/daemon/server/daemon-runtime.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /open-ended dynamic import/);
});

test('R76 rejects a namespace import alongside the recorded named binding on the same pair', () => {
  const sources = {
    'src/platform-runtime-daemon-lifecycle.ts':
      'export const platformDaemonLifecycleOwners = {};\n',
    'src/daemon/server/daemon-runtime.ts':
      "const { platformDaemonLifecycleOwners } = await import('../../platform-runtime-daemon-lifecycle.ts');\n" +
      "const lifecycleModule = await import('../../platform-runtime-daemon-lifecycle.ts');\n" +
      'void [platformDaemonLifecycleOwners, lifecycleModule];\n',
  };
  const found = edgeViolations(sources, 'src/daemon/server/daemon-runtime.ts');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, DAEMON_PLATFORM_RUNTIME_RULE);
  assert.match(found[0]!.message, /open-ended dynamic import/);
  assert.match(
    found[0]!.message,
    /src\/daemon\/server\/daemon-runtime\.ts -> src\/platform-runtime-daemon-lifecycle\.ts/,
  );
});

test('R76 treats the import and re-export of one classified pair as one entry', () => {
  const sources = {
    [DEVICE_READY_TARGET]: DEVICE_READY_STUB,
    'src/daemon/device-ready.ts':
      "import { ensureLocalPlatformDeviceReady } from '../platform-runtime-device-ready.ts';\n" +
      "export { ensureLocalPlatformDeviceReady } from '../platform-runtime-device-ready.ts';\n" +
      'void ensureLocalPlatformDeviceReady;\n',
  };
  assert.deepEqual(edgeViolations(sources, 'src/daemon/device-ready.ts'), []);
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
