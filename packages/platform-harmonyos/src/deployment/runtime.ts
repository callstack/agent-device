import type {
  AppDeploymentInput,
  AppDeploymentResult,
  AppDeploymentRuntimeOperations,
  AppUninstallInput,
  AppUninstallResult,
} from '@agent-device/contracts/app-deployment-runtime';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  parseHarmonyBundleList,
  parseHarmonyLaunchTarget,
  resolveHarmonyArchiveBundleName,
} from '../app-lifecycle.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import type { HarmonyToolbox } from '../toolbox.ts';
import type { HarmonyHdcRunner } from '../hdc.ts';
import type { HarmonyCommandResult } from '../command-host.ts';

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
  uninstallApp: RuntimeOperationFact;
}> {
  const deploy =
    device.kind === 'emulator' || device.kind === 'device' ? available : unsupportedKind;
  return Object.freeze({
    deployApp: deploy,
    materializeAppSource: unsupportedLeaf,
    deployMaterializedApp: unsupportedLeaf,
    sendPushNotification: unsupportedLeaf,
    uninstallApp: deploy,
  });
}

export function createHarmonyAppDeploymentOperations(params: {
  toolbox: HarmonyToolbox;
  device: DeviceInfo;
  signal: AbortSignal;
}): Partial<AppDeploymentRuntimeOperations> {
  const facts = harmonyAppDeploymentFacts(params.device);
  const { toolbox, device, signal } = params;
  return Object.freeze({
    ...(facts.deployApp.available
      ? {
          deployApp: async (input: AppDeploymentInput) =>
            await deployHarmonyApp(toolbox, device, input, signal),
        }
      : {}),
    ...(facts.uninstallApp.available
      ? {
          uninstallApp: async (input: AppUninstallInput) =>
            await uninstallHarmonyApp(toolbox.hdc, device, input, signal),
        }
      : {}),
  });
}

async function uninstallHarmonyApp(
  hdc: HarmonyHdcRunner,
  device: DeviceInfo,
  input: AppUninstallInput,
  signal: AbortSignal,
): Promise<AppUninstallResult> {
  const bundleId = input.app.trim();
  if (!bundleId) {
    throw new AppError('INVALID_ARGS', 'Uninstall requires a HarmonyOS bundle name', {
      hint: 'Pass the bundle name reported by bm dump, such as com.example.app.',
    });
  }
  if (!(await readBundleInventory(hdc, device, signal)).includes(bundleId)) {
    return { wasInstalled: false };
  }
  const uninstall = await hdc.runShell(device, ['bm', 'uninstall', '-n', bundleId], { signal });
  const remaining = await readBundleInventory(hdc, device, signal);
  if (remaining.includes(bundleId)) {
    // bm prints its verdict into stdout at exit code 0, so only an inventory that no
    // longer lists the bundle proves the removal.
    // exec-guard-allow: reachable at exit 0 — bm's own verdict prose is the detail, and
    // processExitError would mislabel an answered tool call as a process failure.
    throw new AppError('COMMAND_FAILED', `${bundleId} is still installed after bm uninstall`, {
      exitCode: uninstall.exitCode,
      stdout: uninstall.stdout,
      stderr: uninstall.stderr,
      hint: 'Read the bm uninstall output above for the bm reason; system and shared bundles refuse removal.',
    });
  }
  return { wasInstalled: true, packageName: bundleId };
}

/**
 * The one bundle-state interpreter for the uninstall route: the Bundle Manager's own
 * inventory (`bm dump -a`) read through the shared `parseHarmonyBundleList`. A non-empty
 * list proves the transport answered and answers membership; a failed exit or an empty
 * read refuses instead of counting as absence, because a real device always lists its
 * system bundles.
 */
async function readBundleInventory(
  hdc: HarmonyHdcRunner,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<string[]> {
  const inventory = await hdc.runShell(device, ['bm', 'dump', '-a'], {
    allowFailure: true,
    timeoutMs: 15_000,
    signal,
  });
  if (inventory.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Could not read the installed bundle inventory',
      commandFailureDetails(inventory),
    );
  }
  const bundles = parseHarmonyBundleList(inventory.stdout);
  if (bundles.length === 0) {
    // bm prints its failures into stdout at exit code 0, so an unparseable answer is an
    // unknown read, never a proof of absence.
    // exec-guard-allow: reachable at exit 0 — the bm prose answers why the read failed,
    // and processExitError would mislabel an answered tool call as a process failure.
    throw new AppError('COMMAND_FAILED', 'Could not read the installed bundle inventory', {
      exitCode: inventory.exitCode,
      stdout: inventory.stdout,
      stderr: inventory.stderr,
      hint: 'Confirm the device connection, then check bm dump -a output on the device.',
    });
  }
  return bundles;
}

async function deployHarmonyApp(
  toolbox: HarmonyToolbox,
  device: DeviceInfo,
  input: AppDeploymentInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  const bundleId =
    (await resolveHarmonyArchiveBundleName(toolbox.commands, input.appPath, signal)) ??
    input.app.trim();
  if (!bundleId) {
    throw new AppError('INVALID_ARGS', 'Could not determine the bundle name from the HAP archive', {
      hint: 'Pass the HarmonyOS bundle name before the HAP path, or provide a valid HAP containing module.json.',
    });
  }
  await toolbox.hdc.run(device, ['install', '-r', input.appPath], {
    timeoutMs: 180_000,
    signal,
  });
  if (input.replaceExisting) {
    // HDC returns after transfer; physical devices can still be replacing the running bundle.
    await sleep(1_000, undefined, { signal });
    await openHarmonyApp(toolbox.hdc, device, bundleId, signal);
  }
  return { packageName: bundleId, launchTarget: bundleId };
}

async function openHarmonyApp(
  hdc: HarmonyHdcRunner,
  device: DeviceInfo,
  bundleId: string,
  signal: AbortSignal,
): Promise<void> {
  const dump = await hdc.runShell(device, ['bm', 'dump', '-n', bundleId], { signal });
  const target = parseHarmonyLaunchTarget(dump.stdout);
  if (!target) {
    throw new AppError(
      'COMMAND_FAILED',
      `Could not determine a launchable ability for ${bundleId}`,
      {
        hint: 'Check that the HarmonyOS bundle exposes a main ability.',
      },
    );
  }
  await hdc.runShell(
    device,
    [
      'aa',
      'start',
      '-b',
      bundleId,
      ...(target.module ? ['-m', target.module] : []),
      '-a',
      target.ability,
    ],
    { signal },
  );
}

/**
 * The host-kit's exec failure details, shaped for the host command result this plugin's runs answer
 * with: `processExitError` is what makes `normalizeError` append the stderr excerpt. The plugin
 * keeps the flag rather than the host kit's helper, because importing the host kit's command module
 * at runtime would give the bundle a second, unscoped command scope.
 */
function commandFailureDetails(result: HarmonyCommandResult): Readonly<Record<string, unknown>> {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    processExitError: true,
  };
}
