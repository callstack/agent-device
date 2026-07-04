import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { execFailureDetails } from '../../../utils/exec.ts';
import { IOS_DEVICE_INSTALL_TIMEOUT_MS } from './config.ts';
import { runIosDevicectl } from './devicectl.ts';
import { prepareIosInstallArtifact } from './install-artifact.ts';
import { ensureBootedSimulator } from './simulator.ts';
import { invalidateIosAppResolutionCache, resolveIosApp } from './app-resolution.ts';
import { isMissingAppErrorOutput, runSimctl } from './apps-simctl.ts';

type InstallIosAppOptions = {
  appIdentifierHint?: string;
};

async function uninstallIosApp(device: DeviceInfo, app: string): Promise<{ bundleId: string }> {
  return await invalidateIosAppResolutionCache(device, async () => {
    const bundleId = await resolveIosApp(device, app);
    if (device.kind !== 'simulator') {
      await runIosDevicectl(
        ['device', 'uninstall', 'app', '--device', device.id, bundleId],
        { action: `uninstall iOS app ${bundleId}`, deviceId: device.id },
        {
          tolerateOutput: (stdout, stderr) =>
            isMissingAppErrorOutput(`${stdout}\n${stderr}`.toLowerCase()),
        },
      );
      return { bundleId };
    }

    await ensureBootedSimulator(device);

    const result = await runSimctl(device, ['uninstall', device.id, bundleId], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (!isMissingAppErrorOutput(output)) {
        throw new AppError(
          'COMMAND_FAILED',
          `simctl uninstall failed for ${bundleId}`,
          execFailureDetails(result),
        );
      }
    }

    return { bundleId };
  });
}

export async function installIosApp(
  device: DeviceInfo,
  appPath: string,
  options?: InstallIosAppOptions,
): Promise<{
  archivePath?: string;
  installablePath: string;
  bundleId?: string;
  appName?: string;
  launchTarget?: string;
}> {
  const prepared = await prepareIosInstallArtifact({ kind: 'path', path: appPath }, options);
  try {
    await installIosInstallablePath(device, prepared.installablePath);
    return {
      archivePath: prepared.archivePath,
      installablePath: prepared.installablePath,
      bundleId: prepared.bundleId,
      appName: prepared.appName,
      launchTarget: prepared.bundleId,
    };
  } finally {
    await prepared.cleanup();
  }
}

export async function reinstallIosApp(
  device: DeviceInfo,
  app: string,
  appPath: string,
): Promise<{ bundleId: string }> {
  return await invalidateIosAppResolutionCache(device, async () => {
    const { bundleId } = await uninstallIosApp(device, app);
    await installIosApp(device, appPath, { appIdentifierHint: app });
    return { bundleId };
  });
}

export async function installIosInstallablePath(
  device: DeviceInfo,
  installablePath: string,
): Promise<void> {
  await invalidateIosAppResolutionCache(device, async () => {
    if (device.kind !== 'simulator') {
      await runIosDevicectl(
        ['device', 'install', 'app', '--device', device.id, installablePath],
        {
          action: 'install iOS app',
          deviceId: device.id,
        },
        {
          timeoutMs: IOS_DEVICE_INSTALL_TIMEOUT_MS,
        },
      );
      return;
    }

    await ensureBootedSimulator(device);
    await runSimctl(device, ['install', device.id, installablePath]);
  });
}
