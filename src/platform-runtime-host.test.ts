import { expect, test, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { createPlatformDeviceInventoryGateways } from './platform-runtime.ts';
import {
  vegaPlatformCompositionFixture,
  vegaSelectionFixture,
} from './platform-runtime-vega-provider.fixtures.ts';

const toolchains = vi.hoisted(() => ({
  appleEvaluations: 0,
  appleAvailabilityChecks: [] as string[],
  appleRuns: [] as Array<{ args: string[]; signal?: AbortSignal }>,
}));

vi.mock('@agent-device/platform-apple/tool-provider', () => {
  toolchains.appleEvaluations += 1;
  return {
    resolveAppleToolProvider: () => ({
      whichCommand: async (command: string) => {
        toolchains.appleAvailabilityChecks.push(command);
        return true;
      },
    }),
    runXcrun: async (args: string[], options: { signal?: AbortSignal }) => {
      toolchains.appleRuns.push({ args, signal: options.signal });
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
});

import { createDeviceInventoryHost } from './platform-runtime-host.ts';

test('inventory host loads scoped Apple mechanics only on first Apple tool use', async () => {
  const host = createDeviceInventoryHost(createLiveTestHostEnvironment());
  const signal = new AbortController().signal;

  expect(toolchains.appleEvaluations).toBe(0);
  await expect(host.appleTools.isXcrunAvailable(signal)).resolves.toBe(true);
  expect(toolchains.appleEvaluations).toBe(1);
  expect(toolchains.appleAvailabilityChecks).toEqual(['xcrun']);

  await expect(
    host.appleTools.run(
      { tool: 'devicectl', args: ['list', 'devices'], allowFailure: true, timeoutMs: 42 },
      signal,
    ),
  ).resolves.toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
  expect(toolchains.appleEvaluations).toBe(1);
  expect(toolchains.appleRuns).toEqual([{ args: ['devicectl', 'list', 'devices'], signal }]);
});

test.skipIf(process.platform === 'win32')(
  'inventory command lookup uses the supplied host PATH',
  async () => {
    const directory = mkdtempForTestSync('inventory-host-command-path-');
    const executable = path.join(directory, 'inventory-host-only-probe');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);

    await expect(
      createDeviceInventoryHost({ env: { PATH: directory }, cwd: directory }).commands.which(
        'inventory-host-only-probe',
      ),
    ).resolves.toBe('inventory-host-only-probe');
    await expect(
      createDeviceInventoryHost({ env: { PATH: '' }, cwd: directory }).commands.which(
        'inventory-host-only-probe',
      ),
    ).resolves.toBeUndefined();
  },
);

test('vega inventory resolves the CLI from the host home, not the process home', async () => {
  // The rule: every Vega executable lookup in one runtime resolves from that runtime host's
  // PATH and home. This host's HOME differs from the process HOME and names a default-install
  // vega the process home does not have, so `devices --platform vega` must list the device
  // instead of TOOL_MISSING (#3794). The plugin reads them through the PlatformHost its `setup`
  // received, so the fixture hands the same environment to `setup` and nothing to `loadInventory`.
  const scratch = mkdtempForTestSync('vega-inventory-host-home-');
  const hostHome = path.join(scratch, 'host-home');
  mkdirSync(path.join(hostHome, 'vega', 'bin'), { recursive: true });
  const vega = path.join(hostHome, 'vega', 'bin', 'vega');
  writeFileSync(vega, '#!/bin/sh\necho "VirtualDevice : running"\n');
  chmodSync(vega, 0o755);

  const scope: PlatformRequestScope = Object.freeze({
    signal: new AbortController().signal,
    diagnostics: Object.freeze({ emit: () => {} }),
    progress: Object.freeze({ report: () => {} }),
  });

  // Vega is a platform plugin, so the scenario supplies it: the assertion is about which home
  // the plugin's inventory reads, not about the builtin family set.
  const selection = vegaSelectionFixture({
    env: { PATH: path.join(scratch, 'empty-path'), HOME: hostHome },
    cwd: scratch,
  });
  const inventory = await selection.active!.inventoryModule.loadInventory();
  const devices = await inventory.discover({ platform: 'vega', target: 'tv' }, scope);

  expect(devices).toEqual([
    {
      platform: 'vega',
      id: 'VirtualDevice',
      name: 'Vega Virtual Device (VirtualDevice)',
      kind: 'emulator',
      target: 'tv',
      booted: true,
    },
  ]);
});

test('a host env with no home still inventories every family through the gateways', async () => {
  // The rule: a host that names no home turns off only the default paths derived from the home,
  // never the whole host (#3794 review). Before, createDeviceInventoryHost refused with
  // COMMAND_FAILED host_home_unbound, and one refusal broke inventory for every family because
  // the gateways load the one host for all of them. Reverting the refusal makes both assertions
  // below red: the Apple host-Mac route fails with COMMAND_FAILED, and Vega fails with
  // COMMAND_FAILED instead of the honest TOOL_MISSING its PATH-only answer yields.
  const gateways = await createPlatformDeviceInventoryGateways(
    {
      env: {},
      cwd: process.cwd(),
    },
    undefined,
    // Vega is a platform plugin, so the scenario supplies it: the assertion covers what its
    // inventory answers when the host env names no home, not the builtin family set.
    vegaPlatformCompositionFixture({ env: {}, cwd: process.cwd() }),
  );
  const scope: PlatformRequestScope = Object.freeze({
    signal: new AbortController().signal,
    diagnostics: Object.freeze({ emit: () => {} }),
    progress: Object.freeze({ report: () => {} }),
  });

  const macDevices = await gateways.localOnly.discover(
    { platform: 'apple', target: 'desktop' },
    scope,
  );
  expect(macDevices).toEqual([
    expect.objectContaining({ platform: 'apple', id: 'host-macos-local' }),
  ]);

  await expect(gateways.localOnly.discover({ platform: 'vega' }, scope)).rejects.toMatchObject({
    code: 'TOOL_MISSING',
  });
});
