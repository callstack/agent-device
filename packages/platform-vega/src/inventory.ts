import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  DeviceInventoryHostFor,
  HostCommandResult,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInventorySource } from '@agent-device/contracts/platform-module';

const DISCOVERY_TIMEOUT_MS = 10_000;
const VVD_SERIAL = 'VirtualDevice';

export function createVegaInventory(host: DeviceInventoryHostFor<'vega'>): DeviceInventorySource {
  return {
    discover: async (_request, scope) => await discoverVegaDevices(host, scope),
  };
}

export function parseVegaDeviceList(rawOutput: string): DeviceInfo[] {
  if (!parseListedVegaSerials(rawOutput).some(isVegaVirtualDevice)) return [];
  return [
    {
      platform: 'vega',
      id: VVD_SERIAL,
      name: `Vega Virtual Device (${VVD_SERIAL})`,
      kind: 'emulator',
      target: 'tv',
      booted: true,
    },
  ];
}

async function discoverVegaDevices(
  host: DeviceInventoryHostFor<'vega'>,
  scope: PlatformRequestScope,
): Promise<readonly DeviceInfo[]> {
  const executable = await resolveVegaExecutable(host);
  if (!executable) {
    throw new AppError('TOOL_MISSING', 'Vega CLI not found in PATH', {
      hint: 'Install Vega Developer Tools, source ~/vega/env, and retry devices.',
    });
  }
  const result = await host.commands.run(
    {
      executable,
      args: ['device', 'list'],
      allowFailure: true,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    },
    scope.signal,
  );
  assertCommandSuccess(result);
  const devices = parseVegaDeviceList(result.stdout);
  const listedSerials = parseListedVegaSerials(result.stdout);
  if (devices.length === 0 && listedSerials.length > 0) {
    throw new AppError(
      'DEVICE_NOT_FOUND',
      'Vega CLI found devices, but no supported Vega Virtual Device is running.',
      {
        listedSerials,
        hint: 'Start the Vega Virtual Device, then retry with --platform vega --target tv.',
      },
    );
  }
  return devices;
}

async function resolveVegaExecutable(
  host: DeviceInventoryHostFor<'vega'>,
): Promise<string | undefined> {
  const resolved = await host.commands.which('vega');
  if (resolved) return resolved;
  const defaultInstall = path.join(host.homeDirectory, 'vega', 'bin', 'vega');
  return (await host.files.isExecutable(defaultInstall)) ? defaultInstall : undefined;
}

function assertCommandSuccess(result: HostCommandResult): void {
  if (result.exitCode === 0) return;
  throw new AppError('COMMAND_FAILED', 'Failed to list Vega devices', {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    processExitError: true,
  });
}

function isVegaVirtualDevice(serial: string): boolean {
  return serial.toLowerCase() === VVD_SERIAL.toLowerCase();
}

function parseListedVegaSerials(rawOutput: string): string[] {
  const serials = new Set<string>();
  for (const rawLine of rawOutput.split(/\r?\n/)) {
    const serial = /^\s*([^\s:]+)\s*:\s*\S/.exec(rawLine)?.[1]?.trim();
    if (serial) serials.add(serial);
  }
  return [...serials];
}
