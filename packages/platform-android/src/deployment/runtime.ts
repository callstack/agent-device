import type {
  AppDeploymentInput,
  AppDeploymentResult,
  AppDeploymentRuntimeOperations,
  AppUninstallInput,
  AppUninstallResult,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
  MaterializedAppSource,
  PushNotificationInput,
} from '@agent-device/contracts/app-deployment-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { ensureAndroidReady } from '../readiness/runtime.ts';
import { classifyAndroidAppTarget } from '../open-target.ts';
import {
  inferAndroidAppName,
  installAndroidArtifact,
  pushAndroidNotification,
  uninstallAndroidPackage,
} from './native.ts';

const available = Object.freeze({ available: true } as const);

export function androidAppDeploymentFacts(device: DeviceInfo): Readonly<{
  deployApp: RuntimeOperationFact;
  materializeAppSource: RuntimeOperationFact;
  deployMaterializedApp: RuntimeOperationFact;
  sendPushNotification: RuntimeOperationFact;
  uninstallApp: RuntimeOperationFact;
}> {
  const fact = androidDeployFact(device);
  return Object.freeze({
    deployApp: fact,
    materializeAppSource: fact,
    deployMaterializedApp: fact,
    sendPushNotification: fact,
    uninstallApp: fact,
  });
}

export function createAndroidAppDeploymentOperations(params: {
  host: PlatformRuntimeHost;
  device: DeviceInfo;
  signal: AbortSignal;
}): Partial<AppDeploymentRuntimeOperations> {
  const { host, device, signal } = params;
  const facts = androidAppDeploymentFacts(device);
  if (!facts.deployApp.available) return Object.freeze({});
  return Object.freeze({
    deployApp: async (input: AppDeploymentInput) =>
      await deployAndroidApp(host, device, input, signal),
    materializeAppSource: async (input: MaterializeAppSourceInput) =>
      await host.androidDeployment.prepareArtifact(input, { signal }),
    deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
      await deployPreparedAndroidApp(host, device, input, signal),
    sendPushNotification: async (input: PushNotificationInput) =>
      await pushAndroidNotification(host, device, input, signal),
    uninstallApp: async (input: AppUninstallInput) =>
      await uninstallAndroidApp(host, device, input, signal),
  });
}

async function uninstallAndroidApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: AppUninstallInput,
  signal: AbortSignal,
): Promise<AppUninstallResult> {
  const ready =
    device.booted === true
      ? device
      : await ensureAndroidReady(host, device, { headless: false }, signal);
  return await host.androidDeployment.withInvalidatedAppResolutionCache(ready, async () => {
    let packageName: string;
    try {
      packageName = await host.androidDeployment.resolveAppPackage(ready, input.app, {
        installedOnly: true,
      });
    } catch (error) {
      const notInstalled = error instanceof AppError && error.code === 'APP_NOT_INSTALLED';
      if (notInstalled && classifyAndroidAppTarget(input.app) === 'package') {
        return { wasInstalled: false };
      }
      throw error;
    }
    await uninstallAndroidPackage(host, ready, packageName, signal);
    return { wasInstalled: true, packageName };
  });
}

async function deployAndroidApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: AppDeploymentInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  if (input.replaceExisting) {
    // Reinstall resolves its fuzzy target during uninstall. Keep the old whole-operation
    // cache boundary here in the Android deployment owner: clear before boot/resolve/uninstall
    // and after materialization/install, including partial failures.
    return await host.androidDeployment.withInvalidatedAppResolutionCache(device, async () => {
      let artifact: MaterializedAppSource | undefined;
      try {
        if (device.booted !== true) {
          await ensureAndroidReady(host, device, { headless: false }, signal);
        }
        const packageName = await host.androidDeployment.resolveAppPackage(device, input.app);
        await uninstallAndroidPackage(host, device, packageName, signal);
        artifact = await host.androidDeployment.prepareArtifact(
          { source: { kind: 'path', path: input.appPath } },
          { resolveIdentity: false, signal },
        );
        await installAndroidArtifact(host, device, artifact.installablePath, undefined, signal);
        return { packageName, launchTarget: packageName };
      } finally {
        await artifact?.cleanup();
      }
    });
  }

  // Existing install semantics wait for a selected Android target before taking the
  // before-install package inventory. Keep that platform rule here, rather than
  // reviving a daemon readiness adapter.
  let artifact: MaterializedAppSource | undefined;
  try {
    if (device.booted !== true) {
      await ensureAndroidReady(host, device, { headless: false }, signal);
    }
    artifact = await host.androidDeployment.prepareArtifact(
      { source: { kind: 'path', path: input.appPath } },
      { resolveIdentity: true, signal },
    );
    const packageName = await installAndroidArtifact(
      host,
      device,
      artifact.installablePath,
      artifact.packageName,
      signal,
    );
    // Plain install has historically succeeded even when the device cannot report the
    // installed package identity. Source installation is stricter because its response
    // contract promises an identity after materialization.
    if (!packageName) return {};
    return {
      packageName,
      appName: inferAndroidAppName(packageName),
      launchTarget: packageName,
    };
  } finally {
    await artifact?.cleanup();
  }
}

async function deployPreparedAndroidApp(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: DeployMaterializedAppInput,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  const packageName = await installAndroidArtifact(
    host,
    device,
    input.artifact.installablePath,
    input.artifact.packageName,
    signal,
  );
  if (!packageName) {
    throw new AppError(
      'COMMAND_FAILED',
      'Installed Android app identity could not be resolved from the artifact or device state',
    );
  }
  return {
    packageName,
    appName: inferAndroidAppName(packageName),
    launchTarget: packageName,
  };
}

function androidDeployFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind === 'emulator' || device.kind === 'device') return available;
  return Object.freeze({ available: false, reason: 'unsupported-device-kind' } as const);
}
