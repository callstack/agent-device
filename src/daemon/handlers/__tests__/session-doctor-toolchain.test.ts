import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VegaToolProvider } from '../../../platforms/vega/tool-provider.ts';
import { withVegaToolProvider } from '../../../platforms/vega/tool-provider.ts';
import { appendToolchainChecks } from '../session-doctor-toolchain.ts';
import type { DoctorCheck } from '../session-doctor-types.ts';

test('Vega doctor reports CLI version and connected-device readiness through semantic provider', async () => {
  const provider: VegaToolProvider = {
    isAvailable: async () => true,
    version: async () => ({ exitCode: 0, stdout: 'Vega CLI 1.3.2\n', stderr: '' }),
    listDevices: async () => ({
      exitCode: 0,
      stdout: 'VirtualDevice : tv - aarch64 - VegaOS\n',
      stderr: '',
    }),
    checkConnected: unexpected,
    launchApp: unexpected,
    terminateApp: unexpected,
    pressRemote: unexpected,
  };
  const checks = await withVegaToolProvider(provider, async () => {
    const result: DoctorCheck[] = [];
    await appendToolchainChecks(result, 'vega');
    return result;
  });

  assert.deepEqual(checks, [
    {
      id: 'toolchain',
      status: 'pass',
      summary: 'Vega toolchain: Vega CLI 1.3.2; device connected.',
      hint: undefined,
      evidence: {
        vegaVersion: 'Vega CLI 1.3.2',
        deviceList: 'VirtualDevice : tv - aarch64 - VegaOS',
      },
    },
  ]);
});

async function unexpected(): Promise<never> {
  throw new Error('unexpected Vega operation');
}
