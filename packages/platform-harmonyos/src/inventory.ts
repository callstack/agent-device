import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInventorySource } from '@agent-device/contracts/platform-module';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import { type HarmonyHdcRunner } from './hdc.ts';
import type { HarmonyToolbox } from './toolbox.ts';

const PROBE_TIMEOUT_MS = 10_000;

/**
 * HarmonyOS device discovery. It runs entirely over the plugin's own HDC route, so the toolchain
 * roots the plugin was configured with are already honored — the core prepares no HarmonyOS
 * toolchain and resolves no HDC for it. A machine without HDC fails in that route with the curated
 * missing-toolchain error, so discovery only answers for what a started HDC reported.
 */
export function createHarmonyInventory(toolbox: HarmonyToolbox): DeviceInventorySource {
  return {
    discover: async (request, scope) => await discoverHarmonyDevices(toolbox.hdc, request, scope),
  };
}

export function parseHarmonyTargetList(rawOutput: string): string[] {
  return rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== '[Empty]');
}

async function discoverHarmonyDevices(
  hdc: HarmonyHdcRunner,
  request: Readonly<DeviceInventoryRequest>,
  scope: PlatformRequestScope,
): Promise<readonly DeviceInfo[]> {
  const result = await hdc.launch(['list', 'targets'], {
    allowFailure: true,
    timeoutMs: PROBE_TIMEOUT_MS,
    signal: scope.signal,
  });
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'hdc list targets failed', {
      stderr: result.stderr,
      hint: 'Confirm the HarmonyOS emulator or device is running, then run hdc list targets.',
    });
  }
  const targets = parseHarmonyTargetList(result.stdout).filter(
    (target) => !request.serial || request.serial === target,
  );
  return await Promise.all(
    targets.map(async (target) => await probeHarmonyDevice(hdc, target, scope)),
  );
}

async function probeHarmonyDevice(
  hdc: HarmonyHdcRunner,
  target: string,
  scope: PlatformRequestScope,
): Promise<DeviceInfo> {
  const device = { id: target };
  const [nameResult, characteristicsResult] = await Promise.all([
    probe(hdc, device, ['param', 'get', 'const.product.name'], scope),
    probe(hdc, device, ['param', 'get', 'const.build.characteristics'], scope),
  ]);
  const name = nameResult.exitCode === 0 ? nameResult.stdout.trim() : '';
  const emulator = name.toLowerCase() === 'emulator';
  return {
    platform: 'harmonyos',
    id: target,
    name: name || target,
    kind: emulator ? 'emulator' : 'device',
    target: characteristicsResult.stdout.toLowerCase().includes('tv') ? 'tv' : 'mobile',
    booted: true,
  };
}

async function probe(
  hdc: HarmonyHdcRunner,
  device: { id: string },
  words: readonly string[],
  scope: PlatformRequestScope,
) {
  return await hdc.runShell(device, words, {
    allowFailure: true,
    timeoutMs: PROBE_TIMEOUT_MS,
    signal: scope.signal,
  });
}
