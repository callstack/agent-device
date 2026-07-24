import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { requireExecSuccess } from '../../utils/exec.ts';
import { resolveVegaToolProvider } from './tool-provider.ts';

export type VegaDeviceInfo = DeviceInfo & {
  platform: 'vega';
  kind: 'emulator' | 'device';
  target: 'tv';
  booted: true;
};

const VEGA_DISCOVERY_TIMEOUT_MS = 10_000;

export async function listVegaDevices(): Promise<VegaDeviceInfo[]> {
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
  return parseVegaDeviceList(result.stdout);
}

export function parseVegaDeviceList(rawOutput: string): VegaDeviceInfo[] {
  const devices = new Map<string, VegaDeviceInfo>();

  for (const rawLine of rawOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line ||
      /^no devices found$/i.test(line) ||
      /^found the following devices?:$/i.test(line)
    ) {
      continue;
    }

    const match = /^([^:]+?)\s*:\s*(.+)$/.exec(line);
    if (!match) continue;
    const serial = match[1]?.trim();
    const details = match[2]?.trim();
    if (!serial || !details) continue;

    const kind = isVegaVirtualDevice(serial) ? 'emulator' : 'device';
    devices.set(serial, {
      platform: 'vega',
      id: serial,
      name: resolveVegaDeviceName(serial, kind),
      kind,
      target: 'tv',
      booted: true,
    });
  }

  return [...devices.values()];
}

function isVegaVirtualDevice(serial: string): boolean {
  return serial.toLowerCase() === 'virtualdevice';
}

function resolveVegaDeviceName(serial: string, kind: VegaDeviceInfo['kind']): string {
  return kind === 'emulator' ? `Vega Virtual Device (${serial})` : `Vega TV (${serial})`;
}
