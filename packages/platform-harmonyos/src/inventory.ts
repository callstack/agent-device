import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  DeviceInventoryHostFor,
  HostCommandResult,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInventorySource } from '@agent-device/contracts/platform-module';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import type { HarmonyInventoryConfig } from './inventory-config.ts';

const PROBE_TIMEOUT_MS = 10_000;

export function createHarmonyInventory(
  host: DeviceInventoryHostFor<'harmonyos'>,
  config: HarmonyInventoryConfig = {},
): DeviceInventorySource {
  return {
    discover: async (request, scope) => await discoverHarmonyDevices(host, config, request, scope),
  };
}

export function parseHarmonyTargetList(rawOutput: string): string[] {
  return rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== '[Empty]');
}

async function discoverHarmonyDevices(
  host: DeviceInventoryHostFor<'harmonyos'>,
  config: HarmonyInventoryConfig,
  request: Readonly<DeviceInventoryRequest>,
  scope: PlatformRequestScope,
): Promise<readonly DeviceInfo[]> {
  await host.toolchains.prepare('harmonyos');
  const hdc = await resolveHdc(host, configuredToolchainRoots(config));
  if (!hdc) {
    throw new AppError('TOOL_MISSING', 'hdc not found in PATH', {
      hint: 'Install HarmonyOS Command Line Tools, then add its sdk/default/openharmony/toolchains directory to PATH.',
    });
  }
  const result = await runHdc(host, hdc, ['list', 'targets'], scope);
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'hdc list targets failed', {
      stderr: result.stderr,
      hint: 'Confirm the HarmonyOS emulator or device is running, then run hdc list targets.',
    });
  }
  const targets = parseHarmonyTargetList(result.stdout).filter(
    (target) => !request.serial || request.serial === target,
  );
  const devices = await Promise.all(
    targets.map(async (target) => await probeHarmonyDevice(host, hdc, target, scope)),
  );
  return devices;
}

function configuredToolchainRoots(config: HarmonyInventoryConfig): readonly string[] {
  return [
    config.hdcSdkPath,
    config.devecoSdkHome && path.join(config.devecoSdkHome, 'default', 'openharmony', 'toolchains'),
    config.commandLineToolsHome &&
      path.join(config.commandLineToolsHome, 'sdk', 'default', 'openharmony', 'toolchains'),
  ].filter((root): root is string => root !== undefined);
}

async function resolveHdc(
  host: DeviceInventoryHostFor<'harmonyos'>,
  toolchainRoots: readonly string[],
): Promise<string | undefined> {
  for (const root of toolchainRoots) {
    const candidate = path.join(root, 'hdc');
    if (await host.files.isExecutable(candidate)) return candidate;
  }
  return await host.commands.which('hdc');
}

async function probeHarmonyDevice(
  host: DeviceInventoryHostFor<'harmonyos'>,
  hdc: string,
  target: string,
  scope: PlatformRequestScope,
): Promise<DeviceInfo> {
  const prefix = ['-t', target, 'shell', 'param', 'get'];
  const [nameResult, characteristicsResult] = await Promise.all([
    runHdc(host, hdc, [...prefix, 'const.product.name'], scope),
    runHdc(host, hdc, [...prefix, 'const.build.characteristics'], scope),
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

async function runHdc(
  host: DeviceInventoryHostFor<'harmonyos'>,
  executable: string,
  args: readonly string[],
  scope: PlatformRequestScope,
): Promise<HostCommandResult> {
  return await host.commands.run(
    {
      executable,
      args,
      allowFailure: true,
      timeoutMs: PROBE_TIMEOUT_MS,
    },
    scope.signal,
  );
}
