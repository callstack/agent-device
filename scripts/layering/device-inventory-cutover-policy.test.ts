import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDeviceInventoryCutover } from './device-inventory-cutover-policy.ts';

const HANDLER_FILE = 'src/daemon/handlers/session-inventory.ts';

function handlerSource(localName = 'listDeviceInventory'): string {
  return [
    `import { listDeviceInventory as ${localName} } from '../../core/dispatch-resolve.ts';`,
    `export async function handleDevices(request: Request) { return await ${localName}(request); }`,
  ].join('\n');
}

function sources(
  handler = handlerSource(),
  extra: readonly (readonly [string, string])[] = [],
): ReadonlyMap<string, string> {
  return new Map([[HANDLER_FILE, handler], ...extra]);
}

function messages(input: ReadonlyMap<string, string>): string {
  return checkDeviceInventoryCutover(input)
    .map(({ message }) => message)
    .join('\n');
}

test('devices keeps one gateway-owned handler route through an aliased import', () => {
  assert.deepEqual(checkDeviceInventoryCutover(sources(handlerSource('discoverInventory'))), []);
});

test('devices rejects a handler that imports but never calls the inventory gateway', () => {
  const handler = [
    "import { listDeviceInventory } from '../../core/dispatch-resolve.ts';",
    'export async function handleDevices() { return []; }',
  ].join('\n');

  assert.match(messages(sources(handler)), /must call its imported listDeviceInventory binding/);
});

test('devices does not accept a call through a binding that shadows the imported alias', () => {
  const handler = [
    "import { listDeviceInventory as discoverInventory } from '../../core/dispatch-resolve.ts';",
    'export async function decoy(discoverInventory: (request: Request) => Promise<unknown>) {',
    '  return await discoverInventory({});',
    '}',
  ].join('\n');

  assert.match(messages(sources(handler)), /shadows its imported listDeviceInventory binding/);
});

test('devices rejects an exact legacy inventory module path', () => {
  assert.match(
    messages(
      sources(handlerSource(), [
        ['src/platforms/apple/devices.ts', 'export const staleInventoryRoute = true;'],
      ]),
    ),
    /legacy device inventory module path remains/,
  );
});

test('devices rejects executable legacy imports and identifiers', () => {
  const legacy = [
    "import { listAppleDevices } from './platforms/apple/devices.ts';",
    'export async function discover() { return await listAppleDevices(); }',
  ].join('\n');
  const found = messages(sources(handlerSource(), [['src/legacy-inventory.ts', legacy]]));

  assert.match(found, /imports legacy device inventory module/);
  assert.match(found, /legacy device inventory identifier 'listAppleDevices' remains/);
});

test('devices rejects dynamic imports and re-exports of legacy inventory modules', () => {
  for (const route of [
    "export const legacy = import('./platforms/apple/devices.ts');",
    "export { staleInventory } from './core/platform-inventory.ts';",
  ]) {
    assert.match(
      messages(sources(handlerSource(), [['src/legacy-inventory.ts', route]])),
      /imports legacy device inventory module/,
    );
  }
});

test('devices ignores comments, strings, and similarly named non-route modules', () => {
  const prose = [
    "const note = 'listAppleDevices from core/platform-inventory';",
    '// discoverDevices used to live in platforms/apple/devices.ts',
    'export const cacheKey = note;',
  ].join('\n');

  assert.deepEqual(
    checkDeviceInventoryCutover(
      sources(handlerSource('discoverInventory'), [
        ['src/platforms/apple/devices-cache.ts', prose],
      ]),
    ),
    [],
  );
});
