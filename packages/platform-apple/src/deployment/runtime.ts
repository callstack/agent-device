import type {
  AppDeploymentInput,
  AppDeploymentResult,
  AppDeploymentRuntimeOperations,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
  PushNotificationInput,
} from '@agent-device/contracts/app-deployment-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { ensureAppleReady } from '../readiness/runtime.ts';
import { simctlArgs } from '../simulator-state.ts';

const available = Object.freeze({ available: true } as const);
const coreDeviceRequired = Object.freeze({
  available: false,
  reason: 'unsupported-device-backend',
  hint: 'This command requires a CoreDevice-backed physical iOS device. The selected XCTest backend supports open, close, interactions, snapshots, and screenshots.',
} as const);
const simulatorOnly = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Push notifications are supported on Apple simulators only.',
} as const);
const unsupportedLeaf = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const unsupportedKind = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
} as const);

export function appleAppDeploymentFacts(device: DeviceInfo): Readonly<{
  deployApp: RuntimeOperationFact;
  materializeAppSource: RuntimeOperationFact;
  deployMaterializedApp: RuntimeOperationFact;
  sendPushNotification: RuntimeOperationFact;
}> {
  const deploy = appleDeployFact(device);
  return Object.freeze({
    deployApp: deploy,
    materializeAppSource: deploy,
    deployMaterializedApp: deploy,
    sendPushNotification: applePushFact(device),
  });
}

export function createAppleAppDeploymentOperations(params: {
  host: PlatformRuntimeHost;
  device: DeviceInfo;
  signal: AbortSignal;
}): Partial<AppDeploymentRuntimeOperations> {
  const { host, device, signal } = params;
  const facts = appleAppDeploymentFacts(device);
  return Object.freeze({
    ...(facts.deployApp.available
      ? {
          deployApp: async (input: AppDeploymentInput) =>
            await deployAppleApp(host, device, input, signal),
          materializeAppSource: async (input: MaterializeAppSourceInput) =>
            await host.appleDeployment.prepareArtifact(input, { signal }),
          deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
            await deployPreparedAppleApp(host, device, input, signal),
        }
      : {}),
    ...(facts.sendPushNotification.available
      ? {
          sendPushNotification: async (input: PushNotificationInput) => {
            await pushAppleNotification(host, device, input, signal);
            return {};
          },
        }
      : {}),
  });
}

async function deployAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: AppDeploymentInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  // Preserve reinstall's established partial-failure boundary: the old route resolved and
  // removed the selected app before it materialized the replacement artifact. That ordering is
  // observable when artifact preparation fails, so it belongs to the platform deployment facet.
  if (input.replaceExisting) {
    return await host.appleDeployment.withInvalidatedAppResolutionCache(device, async () => {
      const bundleId = await host.appleDeployment.resolveAppBundleId(device, input.app);
      await uninstallAppleApp(host, device, bundleId, signal);
      const artifact = await host.appleDeployment.prepareArtifact(
        { source: { kind: 'path', path: input.appPath } },
        { appIdentifierHint: input.app, signal },
      );
      try {
        await installAppleApp(host, device, artifact.installablePath, signal);
        return { bundleId, launchTarget: bundleId };
      } finally {
        await artifact.cleanup();
      }
    });
  }

  const artifact = await host.appleDeployment.prepareArtifact(
    { source: { kind: 'path', path: input.appPath } },
    { appIdentifierHint: input.app, signal },
  );
  try {
    return await deployPreparedAppleApp(host, device, { artifact }, signal);
  } finally {
    await artifact.cleanup();
  }
}

async function deployPreparedAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: DeployMaterializedAppInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  await installAppleApp(host, device, input.artifact.installablePath, signal);
  return {
    ...(input.artifact.bundleId ? { bundleId: input.artifact.bundleId } : {}),
    ...(input.artifact.appName ? { appName: input.artifact.appName } : {}),
    ...(input.artifact.bundleId ? { launchTarget: input.artifact.bundleId } : {}),
  };
}

async function installAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  installablePath: string,
  signal: AbortSignal,
): Promise<void> {
  await ensureAppleReady(host, device, signal);
  const result = await host.appleTools.run(
    device.kind === 'simulator'
      ? { tool: 'simctl', args: simctlArgs(device, ['install', device.id, installablePath]) }
      : {
          tool: 'devicectl',
          args: ['device', 'install', 'app', '--device', device.id, installablePath],
          timeoutMs: 120_000,
        },
    signal,
  );
  assertAppleToolSuccess(result, 'Apple app install failed');
}

async function uninstallAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  bundleId: string,
  signal: AbortSignal,
): Promise<void> {
  await ensureAppleReady(host, device, signal);
  const result = await host.appleTools.run(
    device.kind === 'simulator'
      ? {
          tool: 'simctl',
          args: simctlArgs(device, ['uninstall', device.id, bundleId]),
          allowFailure: true,
        }
      : {
          tool: 'devicectl',
          args: ['device', 'uninstall', 'app', '--device', device.id, bundleId],
          allowFailure: true,
        },
    signal,
  );
  if (result.exitCode === 0 || isMissingAppOutput(`${result.stdout}\n${result.stderr}`)) return;
  assertAppleToolSuccess(result, `Apple app uninstall failed for ${bundleId}`);
}

async function pushAppleNotification(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: PushNotificationInput,
  signal: AbortSignal,
): Promise<void> {
  if (device.kind !== 'simulator') {
    throw new AppError('UNSUPPORTED_OPERATION', 'Apple push notifications require a simulator');
  }
  await ensureAppleReady(host, device, signal);
  const payload = await host.temporaryFiles.create({
    prefix: 'agent-device-ios-push-',
    suffix: '.apns',
  });
  try {
    await payload.writeText(`${JSON.stringify(input.payload)}\n`);
    const result = await host.appleTools.run(
      {
        tool: 'simctl',
        args: simctlArgs(device, ['push', device.id, input.appId, payload.path]),
      },
      signal,
    );
    assertAppleToolSuccess(result, 'Apple push notification failed');
  } finally {
    await payload[Symbol.asyncDispose]();
  }
}

function isMissingAppOutput(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes('not installed') ||
    normalized.includes('not found') ||
    normalized.includes('no such file')
  );
}

function assertAppleToolSuccess(
  result: Readonly<{ stdout: string; stderr: string; exitCode: number | null }>,
  message: string,
): void {
  if (result.exitCode === 0) return;
  throw new AppError('COMMAND_FAILED', message, {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
}

function appleDeployFact(device: DeviceInfo): RuntimeOperationFact {
  if (!isSupportedAppleDeploymentLeaf(device)) return unsupportedLeaf;
  if (device.kind !== 'simulator' && device.kind !== 'device') return unsupportedKind;
  if (device.kind === 'device' && device.iosPhysicalDeviceBackend === 'xctest') {
    return coreDeviceRequired;
  }
  return available;
}

function applePushFact(device: DeviceInfo): RuntimeOperationFact {
  if (!isSupportedAppleDeploymentLeaf(device)) return unsupportedLeaf;
  return device.kind === 'simulator' ? available : simulatorOnly;
}

function isSupportedAppleDeploymentLeaf(device: DeviceInfo): boolean {
  return isIosFamily(device) && device.appleOs !== 'watchos';
}
