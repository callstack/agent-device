import { assertCommandPlatformExecution, inventoryUse } from '@agent-device/contracts/platform';
import { describe, expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';
import { deriveDaemonCommandDescriptors } from '../derive.ts';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '../../../utils/exec.ts';

describe('command platform execution cutover', () => {
  test('declares exactly one internal execution shape per command', () => {
    for (const descriptor of commandDescriptors) {
      expect(() => assertCommandPlatformExecution(descriptor.platformExecution)).not.toThrow();
    }
    expect(commandDescriptors.find(({ name }) => name === 'devices')?.platformExecution).toEqual({
      kind: 'inventory',
      use: inventoryUse,
    });
  });

  test.each([
    {},
    { kind: 'legacy', use: inventoryUse },
    { kind: 'inventory' },
    { kind: 'inventory', use: inventoryUse, legacy: true },
    { kind: 'device-runtime', use: { required: [], preferred: [] }, inventory: true },
    { kind: 'device-runtime', use: { required: ['capture', 'capture'], preferred: [] } },
    { kind: 'device-runtime', use: { required: ['capture'], preferred: ['capture'] } },
  ])('rejects neither/both/widened declarations: %j', (value) => {
    expect(() => assertCommandPlatformExecution(value)).toThrow(/exactly one/);
  });

  test('keeps the internal cutover discriminant out of daemon/public projections', () => {
    const devices = deriveDaemonCommandDescriptors(commandDescriptors).find(
      ({ command }) => command === 'devices',
    );
    expect(devices).toBeDefined();
    expect(devices).not.toHaveProperty('platformExecution');
  });

  test('joins the devices descriptor to one gateway handler and no legacy route', () => {
    const devices = commandDescriptors.find(({ name }) => name === 'devices');
    const routeScan = scanCommittedProductionDeviceRoutes();

    expect(
      atomicInventoryRouteViolations({
        descriptorKind: devices?.platformExecution.kind,
        gatewayHandlerCalls: routeScan.gatewayHandlerCalls,
        legacyRoutes: routeScan.legacyRoutes,
      }),
    ).toEqual([]);
  });

  test('the committed production scan catches a planted legacy route', () => {
    const routeScan = scanCommittedProductionDeviceRoutes([
      {
        path: 'src/platforms/planted/devices.ts',
        source: 'export async function listLinuxDevices() { return []; }',
      },
    ]);

    expect(
      atomicInventoryRouteViolations({
        descriptorKind: 'inventory',
        gatewayHandlerCalls: routeScan.gatewayHandlerCalls,
        legacyRoutes: routeScan.legacyRoutes,
      }),
    ).toContain('devices must have no legacy inventory route');
  });

  test('the command-atomic join rejects a planted neither-route case', () => {
    expect(
      atomicInventoryRouteViolations({
        descriptorKind: 'legacy',
        gatewayHandlerCalls: 0,
        legacyRoutes: 0,
      }),
    ).toContain('devices must have exactly one gateway-owned handler path');
  });
});

function atomicInventoryRouteViolations(input: {
  descriptorKind: string | undefined;
  gatewayHandlerCalls: number;
  legacyRoutes: number;
}): string[] {
  const violations: string[] = [];
  if (input.descriptorKind !== 'inventory') {
    violations.push('devices must declare inventory execution');
  }
  if (input.gatewayHandlerCalls !== 1) {
    violations.push('devices must have exactly one gateway-owned handler path');
  }
  if (input.legacyRoutes !== 0) {
    violations.push('devices must have no legacy inventory route');
  }
  return violations;
}

type ProductionSource = Readonly<{ path: string; source: string }>;

function scanCommittedProductionDeviceRoutes(
  plantedSources: readonly ProductionSource[] = [],
): Readonly<{ gatewayHandlerCalls: number; legacyRoutes: number }> {
  const sources = [...readTrackedProductionSources(), ...plantedSources];
  const handlerPath = 'src/daemon/handlers/session-inventory.ts';
  return {
    gatewayHandlerCalls: sources
      .filter(({ path: sourcePath }) => sourcePath === handlerPath)
      .reduce((count, { source }) => count + matches(source, /await listDeviceInventory\(/g), 0),
    legacyRoutes: sources.reduce(
      (count, productionSource) => count + legacyInventoryRoutes(productionSource),
      0,
    ),
  };
}

function readTrackedProductionSources(): ProductionSource[] {
  const files = runCmdSync(
    'git',
    ['ls-files', 'src/*.ts', 'src/**/*.ts', 'packages/*/src/*.ts', 'packages/*/src/**/*.ts'],
    { cwd: process.cwd() },
  )
    .stdout.split('\n')
    .filter(isProductionTypeScriptFile)
    .filter((relativePath) => fs.existsSync(path.join(process.cwd(), relativePath)));
  return files.map((relativePath) => ({
    path: relativePath,
    source: fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8'),
  }));
}

function isProductionTypeScriptFile(relativePath: string): boolean {
  return (
    relativePath.endsWith('.ts') &&
    !/(?:^|\/)__tests__\//.test(relativePath) &&
    !/\.test\.ts$/.test(relativePath)
  );
}

function legacyInventoryRoutes({ path: sourcePath, source }: ProductionSource): number {
  return (
    Number(isLegacyInventoryModulePath(sourcePath)) +
    matches(
      source,
      /\b(?:discoverDevices|list(?:Apple|Android|Harmony(?:Os)?|Macos|Vega|Linux|Web)Devices)\b/g,
    ) +
    matches(source, /(?:core\/platform-inventory|platforms\/.+\/devices(?:\.ts)?)/g)
  );
}

function isLegacyInventoryModulePath(relativePath: string): boolean {
  return (
    relativePath === 'src/core/platform-inventory.ts' ||
    /^src\/platforms\/.+\/devices\.ts$/.test(relativePath)
  );
}

function matches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}
