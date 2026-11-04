import { resolveAppleToolProvider } from '../core/tool-provider.ts';
import type {
  AppDeploymentInput,
  AppDeploymentInstaller,
  AppDeploymentResult,
  AppDeploymentRuntimeOperations,
  AppUninstallInput,
  AppUninstallResult,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
  PushNotificationInput,
} from '@agent-device/contracts/app-deployment-runtime';
import type {
  AppleToolRequest,
  HostCommandResult,
} from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { isMissingAppErrorOutput } from '../core/physical-device-apps.ts';
import { IOS_APP_UNINSTALL_TIMEOUT_MS, IOS_DEVICE_INSTALL_TIMEOUT_MS } from '../core/config.ts';
import { IOS_DEVICECTL_DEFAULT_HINT, resolveIosDevicectlHint } from '../core/devicectl.ts';
import { ensureAppleReady } from '../readiness/runtime.ts';
import { scopeSimctlArgsForDevice } from '../core/simctl.ts';

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
  uninstallApp: RuntimeOperationFact;
}> {
  const deploy = appleDeployFact(device);
  return Object.freeze({
    deployApp: deploy,
    materializeAppSource: deploy,
    deployMaterializedApp: deploy,
    sendPushNotification: applePushFact(device),
    uninstallApp: deploy,
  });
}

export function createAppleAppDeploymentOperations(params: {
  host: PlatformRuntimeHost;
  device: DeviceInfo;
  signal: AbortSignal;
  install?: AppDeploymentInstaller;
}): Partial<AppDeploymentRuntimeOperations> {
  const { host, device, signal } = params;
  const install = params.install;
  const facts = appleAppDeploymentFacts(device);
  return Object.freeze({
    ...(facts.deployApp.available
      ? {
          deployApp: async (input: AppDeploymentInput) =>
            await deployAppleApp(host, device, input, signal, install),
          materializeAppSource: async (input: MaterializeAppSourceInput) =>
            await host.appleDeployment.prepareArtifact(input, { signal }),
          deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
            await deployPreparedAppleApp(host, device, input, signal, install),
          uninstallApp: async (input: AppUninstallInput) =>
            await uninstallResolvedAppleApp(host, device, input, signal),
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
  install?: AppDeploymentInstaller,
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
        if (install) await install(artifact, signal);
        else await installAppleApp(host, device, artifact.installablePath, signal);
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
    return await deployPreparedAppleApp(host, device, { artifact }, signal, install);
  } finally {
    await artifact.cleanup();
  }
}

async function uninstallResolvedAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: AppUninstallInput,
  signal: AbortSignal,
): Promise<AppUninstallResult> {
  return await host.appleDeployment.withInvalidatedAppResolutionCache(device, async () => {
    await ensureAppleReady(host, device, signal);
    let bundleId: string;
    try {
      bundleId = await host.appleDeployment.resolveAppBundleId(device, input.app, {
        installedOnly: true,
      });
    } catch (error) {
      const notInstalled = error instanceof AppError && error.code === 'APP_NOT_INSTALLED';
      if (notInstalled && input.app.trim().includes('.')) return { wasInstalled: false };
      throw error;
    }
    await uninstallAppleApp(host, device, bundleId, signal);
    return { wasInstalled: true, bundleId };
  });
}

async function deployPreparedAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: DeployMaterializedAppInput,
  signal: AbortSignal,
  install?: AppDeploymentInstaller,
): Promise<AppDeploymentResult> {
  let result: AppDeploymentResult = {};
  if (install) result = await install(input.artifact, signal);
  else await installAppleApp(host, device, input.artifact.installablePath, signal);
  const bundleId = result.bundleId ?? input.artifact.bundleId;
  const appName = result.appName ?? input.artifact.appName;
  const launchTarget = result.launchTarget ?? bundleId;
  return {
    ...result,
    ...(bundleId ? { bundleId } : {}),
    ...(appName ? { appName } : {}),
    ...(launchTarget ? { launchTarget } : {}),
  };
}

async function installAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  installablePath: string,
  signal: AbortSignal,
): Promise<void> {
  await ensureAppleReady(host, device, signal);
  await runAppleTool(
    host,
    device.kind === 'simulator'
      ? {
          tool: 'simctl',
          args: scopeSimctlArgsForDevice(device, ['install', device.id, installablePath]),
          timeoutMs: IOS_DEVICE_INSTALL_TIMEOUT_MS,
        }
      : {
          tool: 'devicectl',
          args: ['device', 'install', 'app', '--device', device.id, installablePath],
          timeoutMs: IOS_DEVICE_INSTALL_TIMEOUT_MS,
        },
    signal,
    'Apple app install failed',
  );
}

async function uninstallAppleApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  bundleId: string,
  signal: AbortSignal,
): Promise<void> {
  await ensureAppleReady(host, device, signal);
  await runAppleTool(
    host,
    device.kind === 'simulator'
      ? {
          tool: 'simctl',
          args: scopeSimctlArgsForDevice(device, ['uninstall', device.id, bundleId]),
          timeoutMs: IOS_APP_UNINSTALL_TIMEOUT_MS,
        }
      : {
          tool: 'devicectl',
          args: ['device', 'uninstall', 'app', '--device', device.id, bundleId],
          timeoutMs: IOS_APP_UNINSTALL_TIMEOUT_MS,
        },
    signal,
    `Apple app uninstall failed for ${bundleId}`,
    {
      tolerate: (result) =>
        isMissingAppErrorOutput(`${result.stdout}\n${result.stderr}`.toLowerCase()),
    },
  );
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
    const staged = await resolveAppleToolProvider().simulatorFiles.stageFile(payload.path, signal);
    try {
      await runAppleTool(
        host,
        {
          tool: 'simctl',
          args: scopeSimctlArgsForDevice(device, ['push', device.id, input.appId, staged.path]),
        },
        signal,
        'Apple push notification failed',
      );
    } finally {
      await staged[Symbol.asyncDispose]();
    }
  } finally {
    await payload[Symbol.asyncDispose]();
  }
}

/**
 * The one request path this module uses to run a tolerated Apple tool call: it forces
 * `allowFailure`, then guards the result itself through `requireExecSuccess` so a non-zero
 * exit always throws the same COMMAND_FAILED shape as every other exec call site, with the
 * caller's curated message. A devicectl failure gets the same Developer Mode,
 * developer-disk-image, and pairing hints the other devicectl call sites attach. `tolerate`
 * lets a caller accept a specific non-zero result (uninstall's "already missing" case)
 * without losing that guard for every other outcome.
 */
async function runAppleTool(
  host: PlatformRuntimeHost,
  request: AppleToolRequest,
  signal: AbortSignal,
  message: string,
  options?: Readonly<{ tolerate?: (result: HostCommandResult) => boolean }>,
): Promise<HostCommandResult> {
  const result = await host.appleTools.run({ ...request, allowFailure: true }, signal);
  if (options?.tolerate?.(result)) return result;
  return requireExecSuccess(result, message, (failed) => ({
    cmd: 'xcrun',
    args: [request.tool, ...request.args],
    ...(request.tool === 'devicectl'
      ? {
          hint: resolveIosDevicectlHint(failed.stdout, failed.stderr) ?? IOS_DEVICECTL_DEFAULT_HINT,
        }
      : {}),
  }));
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
