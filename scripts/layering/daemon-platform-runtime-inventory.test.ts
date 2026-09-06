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

test('R74 accepts a classified edge with the exact recorded symbols', () => {
  const sources = {
    [DEVICE_READY_TARGET]: DEVICE_READY_STUB,
    'src/daemon/device-ready.ts':
      "import { ensureLocalPlatformDeviceReady } from '../platform-runtime-device-ready.ts';\n" +
      'void ensureLocalPlatformDeviceReady;\n',
  };
  assert.deepEqual(edgeViolations(sources, 'src/daemon/device-ready.ts'), []);
});

test('R74 reports every classified edge missing from the tree as stale, not the other way around', () => {
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

test('R74 rejects an unclassified edge with the pair and its line', () => {
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

test('R74 rejects new symbols on a classified edge', () => {
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

test('R74 matches a dynamic import by target with empty symbols', () => {
  const sources = {
    'src/platform-runtime-operation-host.ts':
      'export async function recoverLegacyAppLogMarkersAfterDaemonLock() { return {}; }\n',
    'src/daemon/server/daemon-runtime.ts':
      "const mod = await import('../../platform-runtime-operation-host.ts');\nvoid mod;\n",
  };
  assert.deepEqual(edgeViolations(sources, 'src/daemon/server/daemon-runtime.ts'), []);
});

test('R74 treats the import and re-export of one classified pair as one entry', () => {
  const sources = {
    'src/platform-runtime-open-target.ts':
      'export async function resolveSoleForegroundIosApp() { return undefined; }\n',
    'src/daemon/ios-app-session-hint.ts':
      "import { resolveSoleForegroundIosApp } from '../platform-runtime-open-target.ts';\n" +
      "export { resolveSoleForegroundIosApp } from '../platform-runtime-open-target.ts';\n" +
      'void resolveSoleForegroundIosApp;\n',
  };
  assert.deepEqual(edgeViolations(sources, 'src/daemon/ios-app-session-hint.ts'), []);
});

test('R74 ignores test-shaped and non-daemon importers', () => {
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

test('R74 ignores retired-zone targets, which R65 owns', () => {
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
