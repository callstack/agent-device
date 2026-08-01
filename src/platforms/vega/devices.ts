import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { requireExecSuccess } from '../../utils/exec.ts';
import { resolveVegaToolProvider } from './tool-provider.ts';

const VEGA_DISCOVERY_TIMEOUT_MS = 10_000;
const VEGA_VVD_SERIAL = 'VirtualDevice';

export async function listVegaDevices(): Promise<DeviceInfo[]> {
  const provider = resolveVegaToolProvider();
  if (!(await provider.isAvailable())) {
    throw new AppError('TOOL_MISSING', 'Vega CLI not found in PATH', {
      hint: 'Install Vega Developer Tools, source ~/vega/env, and retry devices.',
    });
  }

  const result = requireExecSuccess(
    await provider.listDevices({
      allowFailure: true,
      timeoutMs: VEGA_DISCOVERY_TIMEOUT_MS,
    }),
    'Failed to list Vega devices',
  );
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

export function parseVegaDeviceList(rawOutput: string): DeviceInfo[] {
  if (!parseListedVegaSerials(rawOutput).some(isVegaVirtualDevice)) return [];
  return [
    {
      platform: 'vega',
      id: VEGA_VVD_SERIAL,
      name: `Vega Virtual Device (${VEGA_VVD_SERIAL})`,
      kind: 'emulator',
      target: 'tv',
      booted: true,
    },
  ];
}

function isVegaVirtualDevice(serial: string): boolean {
  return serial.toLowerCase() === VEGA_VVD_SERIAL.toLowerCase();
}

function parseListedVegaSerials(rawOutput: string): string[] {
  const serials = new Set<string>();
  for (const rawLine of rawOutput.split(/\r?\n/)) {
    const match = /^\s*([^\s:]+)\s*:\s*\S/.exec(rawLine);
    const serial = match?.[1]?.trim();
    if (serial) serials.add(serial);
  }
  return [...serials];
}
