import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { VegaToolProvider } from '../../../platforms/vega/tool-provider.ts';
import { withVegaToolProvider } from '../../../platforms/vega/tool-provider.ts';
import { appendToolchainChecks } from '../session-doctor-toolchain.ts';
import type { DoctorCheck } from '@agent-device/contracts/observability';

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
  const provider = makeVegaProvider('VirtualDevice : tv - aarch64 - VegaOS\n');
  const checks = await withVegaToolProvider(provider, async () => {
    const result: DoctorCheck[] = [];
    await appendToolchainChecks(result, 'vega');
    return result;
  });

  assert.deepEqual(checks, [
    {
      id: 'toolchain',
      status: 'pass',
      summary: 'Vega toolchain: Vega CLI 1.3.2; VVD running.',
      hint: undefined,
      evidence: {
        vegaVersion: 'Vega CLI 1.3.2',
        deviceList: 'VirtualDevice : tv - aarch64 - VegaOS',
      },
    },
  ]);
});

test('Vega doctor does not report an unvalidated physical TV as supported readiness', async () => {
  const provider = makeVegaProvider('G071R20720350DT6 : A1ZZ32RVTQ796E\n');
  const checks = await withVegaToolProvider(provider, async () => {
    const result: DoctorCheck[] = [];
    await appendToolchainChecks(result, 'vega');
    return result;
  });

  assert.equal(checks[0]?.summary, 'Vega toolchain: Vega CLI 1.3.2; no running VVD.');
  assert.equal(checks[0]?.hint, 'Start the Vega Virtual Device and retry doctor.');
});

function makeVegaProvider(deviceList: string): VegaToolProvider {
  return {
    isAvailable: async () => true,
    version: async () => ({ exitCode: 0, stdout: 'Vega CLI 1.3.2\n', stderr: '' }),
    listDevices: async () => ({ exitCode: 0, stdout: deviceList, stderr: '' }),
    checkConnected: unexpected,
    launchApp: unexpected,
    terminateApp: unexpected,
    pressRemote: unexpected,
  };
}

async function unexpected(): Promise<never> {
  throw new Error('unexpected Vega operation');
}
