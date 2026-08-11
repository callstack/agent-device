import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appStateLegacySessionHandlerViolations,
  appLogSessionStateOwnershipViolations,
  devicesGatewayBindingViolations,
  sourceExecutedUsingDeclarationViolations,
} from './runtime-command-cutover-extensions.ts';

const HANDLER_FILE = 'src/daemon/handlers/session-inventory.ts';

function handlerSource(localName = 'listDeviceInventory'): string {
  return [
    `import { listDeviceInventory as ${localName} } from '../../core/dispatch-resolve.ts';`,
    `export async function handleDevices(request: Request) { return await ${localName}(request); }`,
  ].join('\n');
}

function sources(entries: readonly (readonly [string, string])[]): ReadonlyMap<string, string> {
  return new Map(entries);
}

function summaries(violations: readonly Readonly<{ file: string; message: string }>[]): string[] {
  return violations.map(({ file, message }) => `${file}: ${message}`);
}

test('devices keeps one gateway-owned handler route through an aliased import', () => {
  assert.deepEqual(
    devicesGatewayBindingViolations(sources([[HANDLER_FILE, handlerSource('discoverInventory')]])),
    [],
  );
});

test('devices rejects a missing handler module', () => {
  assert.match(
    summaries(devicesGatewayBindingViolations(sources([]))).join('\n'),
    /gateway-owned handler module is missing/,
  );
});

test('devices rejects a handler that imports but never calls the inventory gateway', () => {
  const handler = [
    "import { listDeviceInventory } from '../../core/dispatch-resolve.ts';",
    'export async function handleDevices() { return []; }',
  ].join('\n');

  assert.match(
    summaries(devicesGatewayBindingViolations(sources([[HANDLER_FILE, handler]]))).join('\n'),
    /must call its imported listDeviceInventory binding/,
  );
});

test('devices rejects a handler that never imports the inventory gateway', () => {
  assert.match(
    summaries(
      devicesGatewayBindingViolations(
        sources([[HANDLER_FILE, 'export const handleDevices = () => [];']]),
      ),
    ).join('\n'),
    /must import listDeviceInventory from the neutral inventory owner/,
  );
});

test('devices does not accept a call through a binding that shadows the imported alias', () => {
  const handler = [
    "import { listDeviceInventory as discoverInventory } from '../../core/dispatch-resolve.ts';",
    'export async function decoy(discoverInventory: (request: Request) => Promise<unknown>) {',
    '  return await discoverInventory({});',
    '}',
  ].join('\n');

  assert.match(
    summaries(devicesGatewayBindingViolations(sources([[HANDLER_FILE, handler]]))).join('\n'),
    /shadows its imported listDeviceInventory binding/,
  );
});

test('session state scan catches planted app-log record construction outside its owner', () => {
  assert.deepEqual(
    summaries(
      appLogSessionStateOwnershipViolations(
        sources([
          [
            'src/daemon/handlers/planted.ts',
            `sessionStore.set(name, { ...session, appLog: resource, appLogFailure: undefined });`,
          ],
          [
            'src/daemon/request-platform-providers.ts',
            `
          type Scope = { appLog: { provider?: AppLogProvider } };
          const scope = { appLog: { provider } };
        `,
          ],
          [
            'src/daemon/app-log-session-resource.ts',
            `sessionStore.set(name, { ...session, appLog: resource });`,
          ],
          [
            'src/daemon/session-teardown.ts',
            `teardownSessionResources({ appLog: 'run' }); teardownSessionResources({ appLog: 'already-settled' });`,
          ],
          [
            'src/daemon/handlers/invalid-teardown.ts',
            `teardownSessionResources({ appLog: 'skip' });`,
          ],
        ]),
      ),
    ),
    [
      'src/daemon/handlers/planted.ts: session appLog record constructed outside its owner',
      'src/daemon/handlers/planted.ts: session appLogFailure record constructed outside its owner',
      'src/daemon/request-platform-providers.ts: session appLog record constructed outside its owner',
      'src/daemon/handlers/invalid-teardown.ts: session appLog record constructed outside its owner',
    ],
  );
});

test('source-executed syntax scan rejects using declarations but ignores prose', () => {
  assert.deepEqual(
    summaries(
      sourceExecutedUsingDeclarationViolations(
        sources([
          [
            'packages/platform-apple/src/logs/planted.ts',
            `
          // await using oldHandle = acquire();
          const migrationNote = 'using replacement = acquire()';
          async function run() { await using handle = acquire(); }
          function runSync() { using cleanup = acquireSync(); }
        `,
          ],
        ]),
      ),
    ),
    [
      'packages/platform-apple/src/logs/planted.ts: source-executed TypeScript uses unsupported await using declaration',
      'packages/platform-apple/src/logs/planted.ts: source-executed TypeScript uses unsupported using declaration',
    ],
  );
});

test('appstate handler rejects legacy platform imports and calls', () => {
  const handler = [
    "import { getAndroidAppState } from '../../platforms/android/app-lifecycle.ts';",
    "import { getHarmonyAppState } from '../../platforms/harmonyos/app-lifecycle.ts';",
    'export async function handleSessionStateCommands() {',
    '  await getAndroidAppState();',
    '  return await getHarmonyAppState();',
    '}',
  ].join('\n');

  assert.deepEqual(
    summaries(
      appStateLegacySessionHandlerViolations(
        sources([['src/daemon/handlers/session-state.ts', handler]]),
      ),
    ),
    [
      'src/daemon/handlers/session-state.ts: appstate handler imports a legacy platform app-state module',
      'src/daemon/handlers/session-state.ts: appstate handler imports a legacy platform app-state module',
      'src/daemon/handlers/session-state.ts: appstate handler calls a legacy platform app-state backend',
      'src/daemon/handlers/session-state.ts: appstate handler calls a legacy platform app-state backend',
    ],
  );
});

test('appstate handler is green after legacy dispatch is removed', () => {
  assert.deepEqual(
    appStateLegacySessionHandlerViolations(
      sources([
        ['src/daemon/handlers/session-state.ts', 'export const handler = () => undefined;'],
      ]),
    ),
    [],
  );
});
