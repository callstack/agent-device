import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '../../utils/exec.ts';
import { ensureHdcAvailable, harmonyDeviceForTarget, runHarmonyHdc } from './hdc.ts';

const DEVICE_PROBE_TIMEOUT_MS = 10_000;

export function parseHarmonyTargetList(rawOutput: string): string[] {
  return rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== '[Empty]');
}

export async function listHarmonyDevices(options: { serial?: string } = {}): Promise<DeviceInfo[]> {
  await ensureHdcAvailable();
  const result = await runCmd('hdc', ['list', 'targets'], {
    allowFailure: true,
    timeoutMs: DEVICE_PROBE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'hdc list targets failed', {
      stderr: result.stderr,
      hint: 'Confirm the HarmonyOS emulator or device is running, then run hdc list targets.',
    });
  }

  const targets = parseHarmonyTargetList(result.stdout).filter(
    (target) => !options.serial || target === options.serial,
  );
  return await Promise.all(targets.map(async (target) => await probeHarmonyDevice(target)));
}

async function probeHarmonyDevice(target: string): Promise<DeviceInfo> {
  const probeDevice = { id: target };
  const [nameResult, characteristicsResult] = await Promise.all([
    runHarmonyHdc(probeDevice, ['shell', 'param', 'get', 'const.product.name'], {
      allowFailure: true,
      timeoutMs: DEVICE_PROBE_TIMEOUT_MS,
    }),
    runHarmonyHdc(probeDevice, ['shell', 'param', 'get', 'const.build.characteristics'], {
      allowFailure: true,
      timeoutMs: DEVICE_PROBE_TIMEOUT_MS,
    }),
  ]);
  const name = nameResult.exitCode === 0 ? nameResult.stdout.trim() : '';
  const characteristics = characteristicsResult.stdout.toLowerCase();
  const emulator = name.toLowerCase() === 'emulator';
  const device = harmonyDeviceForTarget(target, { name: name || target, emulator });
  return characteristics.includes('tv') ? { ...device, target: 'tv' } : device;
}
