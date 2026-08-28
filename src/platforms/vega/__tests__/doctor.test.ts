import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import { shouldPropagateDeviceInventoryProbeError } from '../../../request/device-inventory-context.ts';
import type { VegaToolProvider } from '../tool-provider.ts';
import { withVegaToolProvider } from '../tool-provider.ts';
import { vegaToolchainCheck } from '../doctor.ts';

function contextWith(local: () => Promise<readonly DeviceInfo[]>): HostDiagnosticsContext {
  return Object.freeze({
    stateDir: '/tmp/state',
    metroPort: 8081,
    shouldProbeMetro: false,
    isProviderDevice: () => false,
    emitProgress: () => {},
    listLocalDeviceInventory: local,
    shouldPropagateInventoryProbeError: shouldPropagateDeviceInventoryProbeError,
    transportOverrides: Object.freeze({}),
  });
}

test('Vega doctor reports CLI version and connected-device readiness through semantic provider', async () => {
  const check = await withVegaToolProvider(makeVegaProvider(), async () =>
    vegaToolchainCheck(contextWith(async () => [VEGA_VVD])),
  );

  assert.deepEqual(check, {
    id: 'toolchain',
    status: 'pass',
    summary: 'Vega toolchain: Vega CLI 1.3.2; VVD running.',
    hint: undefined,
    evidence: {
      vegaVersion: 'Vega CLI 1.3.2',
      deviceList: 'VirtualDevice',
    },
  });
});

test('Vega doctor does not report an unvalidated physical TV as supported readiness', async () => {
  const check: DoctorCheck = await withVegaToolProvider(makeVegaProvider(), async () =>
    vegaToolchainCheck(
      contextWith(async () => {
        throw new AppError(
          'DEVICE_NOT_FOUND',
          'Vega CLI found devices, but no supported Vega Virtual Device is running.',
          { listedSerials: ['G071R20720350DT6'] },
        );
      }),
    ),
  );

  assert.equal(check.summary, 'Vega toolchain: Vega CLI 1.3.2; no running VVD.');
  assert.equal(check.hint, 'Start the Vega Virtual Device and retry doctor.');
  assert.deepEqual(check.evidence, {
    vegaVersion: 'Vega CLI 1.3.2',
    deviceList: 'G071R20720350DT6',
  });
});

test('Vega doctor propagates canonical request cancellation', async () => {
  await assert.rejects(
    withVegaToolProvider(makeVegaProvider(), async () =>
      vegaToolchainCheck(
        contextWith(async () => {
          throw new AppError('COMMAND_FAILED', 'request canceled');
        }),
      ),
    ),
    (error: unknown) => error instanceof AppError && error.message === 'request canceled',
  );
});

test('Vega doctor propagates missing request inventory context', async () => {
  await assert.rejects(
    withVegaToolProvider(makeVegaProvider(), async () =>
      vegaToolchainCheck(
        contextWith(async () => {
          throw new AppError('COMMAND_FAILED', 'device inventory context unavailable', {
            reason: 'device_inventory_context_unavailable',
          });
        }),
      ),
    ),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'device_inventory_context_unavailable',
  );
});

test('Vega doctor preserves the missing-tool diagnostic without probing inventory', async () => {
  const provider: VegaToolProvider = {
    ...makeVegaProvider(),
    isAvailable: async () => false,
  };
  const check = await withVegaToolProvider(provider, async () =>
    vegaToolchainCheck(
      contextWith(async () => {
        throw new Error('inventory must not be probed');
      }),
    ),
  );

  assert.deepEqual(check, {
    id: 'toolchain',
    status: 'info',
    summary: 'Vega toolchain: Vega CLI not found.',
    hint: 'Install Vega Developer Tools or ensure ~/vega/bin/vega is executable.',
    command: 'vega --version',
  });
});

test('Vega doctor keeps version failures diagnostic when neutral inventory fails', async () => {
  const provider: VegaToolProvider = {
    ...makeVegaProvider(),
    version: async () => ({ exitCode: 1, stdout: '', stderr: 'version failed' }),
  };
  const check = await withVegaToolProvider(provider, async () =>
    vegaToolchainCheck(
      contextWith(async () => {
        throw new Error('inventory failed');
      }),
    ),
  );

  assert.deepEqual(check, {
    id: 'toolchain',
    status: 'info',
    summary: 'Vega toolchain: CLI found but version check failed.',
    hint: 'Start the Vega Virtual Device and retry doctor.',
    evidence: { vegaVersion: null, deviceList: null },
  });
});

const VEGA_VVD: DeviceInfo = {
  platform: 'vega',
  id: 'VirtualDevice',
  name: 'Vega Virtual Device (VirtualDevice)',
  kind: 'emulator',
  target: 'tv',
  booted: true,
};

function makeVegaProvider(): VegaToolProvider {
  return {
    isAvailable: async () => true,
    version: async () => ({ exitCode: 0, stdout: 'Vega CLI 1.3.2\n', stderr: '' }),
    listDevices: unexpected,
    checkConnected: unexpected,
    launchApp: unexpected,
    terminateApp: unexpected,
    pressRemote: unexpected,
  };
}

async function unexpected(): Promise<never> {
  throw new Error('unexpected Vega operation');
}
