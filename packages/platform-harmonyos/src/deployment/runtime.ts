import type {
  AppDeploymentInput,
  AppDeploymentResult,
  AppDeploymentRuntimeOperations,
} from '@agent-device/contracts/app-deployment-runtime';
import type { HostCommandRunner } from '@agent-device/contracts/platform-runtime-host';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { setTimeout as sleep } from 'node:timers/promises';

const available = Object.freeze({ available: true } as const);
const unsupportedKind = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
} as const);
const unsupportedLeaf = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);

export function harmonyAppDeploymentFacts(device: DeviceInfo): Readonly<{
  deployApp: RuntimeOperationFact;
  materializeAppSource: RuntimeOperationFact;
  deployMaterializedApp: RuntimeOperationFact;
  sendPushNotification: RuntimeOperationFact;
}> {
  const deploy =
    device.kind === 'emulator' || device.kind === 'device' ? available : unsupportedKind;
  return Object.freeze({
    deployApp: deploy,
    materializeAppSource: unsupportedLeaf,
    deployMaterializedApp: unsupportedLeaf,
    sendPushNotification: unsupportedLeaf,
  });
}

export function createHarmonyAppDeploymentOperations(params: {
  commands: HostCommandRunner;
  device: DeviceInfo;
  signal: AbortSignal;
}): Partial<AppDeploymentRuntimeOperations> {
  const facts = harmonyAppDeploymentFacts(params.device);
  if (!facts.deployApp.available) return Object.freeze({});
  return Object.freeze({
    deployApp: async (input: AppDeploymentInput) =>
      await deployHarmonyApp(params.commands, params.device, input, params.signal),
  });
}

async function deployHarmonyApp(
  commands: HostCommandRunner,
  device: DeviceInfo,
  input: AppDeploymentInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  const bundleId = (await resolveBundleName(commands, input.appPath, signal)) ?? input.app.trim();
  if (!bundleId) {
    throw new AppError('INVALID_ARGS', 'Could not determine the bundle name from the HAP archive', {
      hint: 'Pass the HarmonyOS bundle name before the HAP path, or provide a valid HAP containing module.json.',
    });
  }
  await runHdc(commands, device, ['install', '-r', input.appPath], signal, 180_000);
  if (input.replaceExisting) {
    // HDC returns after transfer; physical devices can still be replacing the running bundle.
    await sleep(1_000, undefined, { signal });
    await openHarmonyApp(commands, device, bundleId, signal);
  }
  return { packageName: bundleId, launchTarget: bundleId };
}

async function resolveBundleName(
  commands: HostCommandRunner,
  archivePath: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await commands.run(
    {
      executable: 'unzip',
      args: ['-p', archivePath, 'module.json'],
      allowFailure: true,
      timeoutMs: 15_000,
    },
    signal,
  );
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) return undefined;
  try {
    const manifest = JSON.parse(result.stdout) as { app?: { bundleName?: string } };
    return manifest.app?.bundleName?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function openHarmonyApp(
  commands: HostCommandRunner,
  device: DeviceInfo,
  bundleId: string,
  signal: AbortSignal,
): Promise<void> {
  const dump = await runHdc(commands, device, ['shell', 'bm', 'dump', '-n', bundleId], signal);
  const target = parseLaunchTarget(dump.stdout);
  if (!target) {
    throw new AppError(
      'COMMAND_FAILED',
      `Could not determine a launchable ability for ${bundleId}`,
      {
        hint: 'Check that the HarmonyOS bundle exposes a main ability.',
      },
    );
  }
  await runHdc(
    commands,
    device,
    [
      'shell',
      'aa',
      'start',
      '-b',
      bundleId,
      ...(target.module ? ['-m', target.module] : []),
      '-a',
      target.ability,
    ],
    signal,
  );
}

function parseLaunchTarget(rawOutput: string): { ability: string; module?: string } | undefined {
  const jsonStart = rawOutput.indexOf('{');
  if (jsonStart === -1) return undefined;
  try {
    const dump = JSON.parse(rawOutput.slice(jsonStart)) as {
      hapModuleInfos?: Array<{ mainElementName?: string; moduleName?: string }>;
    };
    const module = dump.hapModuleInfos?.find((item) => item.mainElementName);
    return module?.mainElementName
      ? {
          ability: module.mainElementName,
          ...(module.moduleName ? { module: module.moduleName } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function runHdc(
  commands: HostCommandRunner,
  device: DeviceInfo,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs = 15_000,
) {
  return await commands.run(
    { executable: 'hdc', args: ['-t', device.id, ...args], timeoutMs },
    signal,
  );
}
