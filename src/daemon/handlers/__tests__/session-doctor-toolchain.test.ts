import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { VegaToolProvider } from '../../../platforms/vega/tool-provider.ts';
import { withVegaToolProvider } from '../../../platforms/vega/tool-provider.ts';
import { appendToolchainChecks } from '../session-doctor-toolchain.ts';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import { withTestDeviceInventory } from '../../../__tests__/test-utils/device-inventory-gateways.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});

import { runCmd } from '../../../utils/exec.ts';

const mockRunCmd = vi.mocked(runCmd);

beforeEach(() => {
  mockRunCmd.mockReset();
});

test('HarmonyOS doctor reports the HDC version', async () => {
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: 'HDC 3.2.0d\n', stderr: '' } as never);
  const checks: DoctorCheck[] = [];
  await appendToolchainChecks(checks, 'harmonyos');

  assert.deepEqual(checks, [
    {
      id: 'toolchain',
      status: 'pass',
      summary: 'HarmonyOS toolchain: HDC 3.2.0d.',
      evidence: { hdcVersion: 'HDC 3.2.0d' },
    },
  ]);
  assert.deepEqual(mockRunCmd.mock.calls[0]?.slice(0, 2), ['hdc', ['-v']]);
});

test('Vega doctor reports CLI version and connected-device readiness through semantic provider', async () => {
  const provider = makeVegaProvider();
  const checks = await withTestDeviceInventory(
    { local: async () => [VEGA_VVD] },
    async () =>
      await withVegaToolProvider(provider, async () => {
        const result: DoctorCheck[] = [];
        await appendToolchainChecks(result, 'vega');
        return result;
      }),
  );

  assert.deepEqual(checks, [
    {
      id: 'toolchain',
      status: 'pass',
      summary: 'Vega toolchain: Vega CLI 1.3.2; VVD running.',
      hint: undefined,
      evidence: {
        vegaVersion: 'Vega CLI 1.3.2',
        deviceList: 'VirtualDevice',
      },
    },
  ]);
});

test('Vega doctor does not report an unvalidated physical TV as supported readiness', async () => {
  const provider = makeVegaProvider();
  const checks = await withTestDeviceInventory(
    {
      local: async () =>
        Promise.reject(
          new AppError(
            'DEVICE_NOT_FOUND',
            'Vega CLI found devices, but no supported Vega Virtual Device is running.',
            { listedSerials: ['G071R20720350DT6'] },
          ),
        ),
    },
    async () =>
      await withVegaToolProvider(provider, async () => {
        const result: DoctorCheck[] = [];
        await appendToolchainChecks(result, 'vega');
        return result;
      }),
  );

  assert.equal(checks[0]?.summary, 'Vega toolchain: Vega CLI 1.3.2; no running VVD.');
  assert.equal(checks[0]?.hint, 'Start the Vega Virtual Device and retry doctor.');
  assert.deepEqual(checks[0]?.evidence, {
    vegaVersion: 'Vega CLI 1.3.2',
    deviceList: 'G071R20720350DT6',
  });
});

test('Vega doctor propagates canonical request cancellation', async () => {
  const provider = makeVegaProvider();

  await assert.rejects(
    withTestDeviceInventory(
      {
        local: async () => Promise.reject(new AppError('COMMAND_FAILED', 'request canceled')),
      },
      async () =>
        await withVegaToolProvider(provider, async () => {
          await appendToolchainChecks([], 'vega');
        }),
    ),
    (error: unknown) => error instanceof AppError && error.message === 'request canceled',
  );
});

test('Vega doctor propagates missing request inventory context', async () => {
  const provider = makeVegaProvider();
  await assert.rejects(
    withVegaToolProvider(provider, async () => {
      await appendToolchainChecks([], 'vega');
    }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'device_inventory_context_unavailable',
  );
});

test('Vega doctor preserves the missing-tool diagnostic without probing inventory', async () => {
  const provider: VegaToolProvider = {
    ...makeVegaProvider(),
    isAvailable: async () => false,
  };
  const checks = await withVegaToolProvider(provider, async () => {
    const result: DoctorCheck[] = [];
    await appendToolchainChecks(result, 'vega');
    return result;
  });

  assert.deepEqual(checks, [
    {
      id: 'toolchain',
      status: 'info',
      summary: 'Vega toolchain: Vega CLI not found.',
      hint: 'Install Vega Developer Tools or ensure ~/vega/bin/vega is executable.',
      command: 'vega --version',
    },
  ]);
});

test('Vega doctor keeps version failures diagnostic when neutral inventory fails', async () => {
  const provider: VegaToolProvider = {
    ...makeVegaProvider(),
    version: async () => ({ exitCode: 1, stdout: '', stderr: 'version failed' }),
  };
  const checks = await withTestDeviceInventory(
    { local: async () => Promise.reject(new Error('inventory failed')) },
    async () =>
      await withVegaToolProvider(provider, async () => {
        const result: DoctorCheck[] = [];
        await appendToolchainChecks(result, 'vega');
        return result;
      }),
  );

  assert.deepEqual(checks, [
    {
      id: 'toolchain',
      status: 'info',
      summary: 'Vega toolchain: CLI found but version check failed.',
      hint: 'Start the Vega Virtual Device and retry doctor.',
      evidence: { vegaVersion: null, deviceList: null },
    },
  ]);
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
