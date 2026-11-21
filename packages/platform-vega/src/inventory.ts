import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, requireCommandSuccess } from '@agent-device/kernel/errors';
import type { VegaCommandRunner } from './command-host.ts';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInventorySource } from '@agent-device/contracts/platform-module';

const DISCOVERY_TIMEOUT_MS = 10_000;
const VVD_SERIAL = 'VirtualDevice';

/**
 * Vega's inventory, answering from the plugin's own command route. The family asks the core for no
 * host: the CLI it resolves comes from the `PlatformHost` its `setup` received (#4862), so discovery
 * and every later command of a request agree on one executable and one environment.
 */
export function createVegaInventory(commands: VegaCommandRunner): DeviceInventorySource {
  return {
    discover: async (_request, scope) => await discoverVegaDevices(commands, scope),
  };
}

function parseVegaDeviceList(rawOutput: string): DeviceInfo[] {
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
  commands: VegaCommandRunner,
  scope: PlatformRequestScope,
): Promise<readonly DeviceInfo[]> {
  const executable = await commands.resolveExecutable();
  if (!executable) {
    throw new AppError('TOOL_MISSING', 'Vega CLI not found in PATH', {
      hint: 'Install Vega Developer Tools, source ~/vega/env, and retry devices.',
    });
  }
  const result = await commands.run(['device', 'list'], {
    allowFailure: true,
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    signal: scope.signal,
  });
  requireCommandSuccess(result, 'Failed to list Vega devices');
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
