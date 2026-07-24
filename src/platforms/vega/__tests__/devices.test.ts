import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '../../../kernel/errors.ts';
import { listVegaDevices, parseVegaDeviceList } from '../devices.ts';
import { createLocalVegaToolProvider, withVegaToolProvider } from '../tool-provider.ts';

test('parseVegaDeviceList normalizes VVD entries and excludes unvalidated physical TVs', () => {
  const devices = parseVegaDeviceList(`
Found the following devices:
G071R20720350DT6 : A1ZZ32RVTQ796E
VirtualDevice : tv - aarch64 - VegaOS - workstation
`);

  assert.deepEqual(devices, [
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

test('parseVegaDeviceList accepts the VirtualDevice identifier and de-duplicates serials', () => {
  const devices = parseVegaDeviceList(`
VirtualDevice device
VirtualDevice : tv - aarch64 - VegaOS - workstation
VirtualDevice : tv - aarch64 - VegaOS - workstation
`);

  assert.deepEqual(devices, [
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

test('listVegaDevices invokes VDA through Vega with a bounded discovery call', async () => {
  const calls: Array<{ args: string[]; allowFailure?: boolean; timeoutMs?: number }> = [];
  const provider = createLocalVegaToolProvider({
    whichCommand: async (cmd) => cmd === 'vega',
    runCommand: async (_cmd, args, options) => {
      calls.push({ args, allowFailure: options?.allowFailure, timeoutMs: options?.timeoutMs });
      return {
        exitCode: 0,
        stdout: 'VirtualDevice : tv - aarch64 - VegaOS - workstation\n',
        stderr: '',
      };
    },
  });

  const devices = await withVegaToolProvider(provider, async () => await listVegaDevices());

  assert.equal(devices[0]?.id, 'VirtualDevice');
  assert.deepEqual(calls, [
    {
      args: ['device', 'list'],
      allowFailure: true,
      timeoutMs: 10_000,
    },
  ]);
});

test('listVegaDevices reports a typed tool-missing error', async () => {
  const provider = createLocalVegaToolProvider({
    whichCommand: async () => false,
    runCommand: async () => {
      throw new Error('unexpected command');
    },
  });

  await assert.rejects(
    withVegaToolProvider(provider, async () => await listVegaDevices()),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'TOOL_MISSING' &&
      error.details?.hint === 'Install Vega Developer Tools, source ~/vega/env, and retry devices.',
  );
});

test('listVegaDevices preserves structured process failure details', async () => {
  const provider = createLocalVegaToolProvider({
    whichCommand: async () => true,
    runCommand: async () => ({
      exitCode: 17,
      stdout: '',
      stderr: 'VDA transport unavailable',
    }),
  });

  await assert.rejects(
    withVegaToolProvider(provider, async () => await listVegaDevices()),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.processExitError === true &&
      error.details?.exitCode === 17,
  );
});
