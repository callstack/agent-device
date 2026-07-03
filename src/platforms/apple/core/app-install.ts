import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { IOS_DEVICE_INSTALL_TIMEOUT_MS, IOS_DEVICECTL_TIMEOUT_MS } from './config.ts';
import { runIosDevicectl } from './devicectl.ts';
import { prepareIosInstallArtifact } from './install-artifact.ts';
import { ensureBootedSimulator } from './simulator.ts';
import { runXcrun } from './tool-provider.ts';
import {
  invalidateIosAppResolutionCache,
  maybeResolveIosDevicectlHint,
  resolveIosApp,
} from './app-resolution.ts';
import { isMissingAppErrorOutput, runSimctl } from './apps-simctl.ts';

type InstallIosAppOptions = {
  appIdentifierHint?: string;
};

async function uninstallIosApp(device: DeviceInfo, app: string): Promise<{ bundleId: string }> {
  return await invalidateIosAppResolutionCache(device, async () => {
    const bundleId = await resolveIosApp(device, app);
    if (device.kind !== 'simulator') {
      const args = ['devicectl', 'device', 'uninstall', 'app', '--device', device.id, bundleId];
      const result = await runXcrun(args, {
        allowFailure: true,
        timeoutMs: IOS_DEVICECTL_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        const stdout = String(result.stdout ?? '');
        const stderr = String(result.stderr ?? '');
        const output = `${stdout}\n${stderr}`.toLowerCase();
        if (!isMissingAppErrorOutput(output)) {
          throw new AppError('COMMAND_FAILED', `Failed to uninstall iOS app ${bundleId}`, {
            cmd: 'xcrun',
            args,
            exitCode: result.exitCode,
            stdout,
            stderr,
            deviceId: device.id,
            hint: maybeResolveIosDevicectlHint(stdout, stderr),
          });
        }
      }
      return { bundleId };
    }

    await ensureBootedSimulator(device);

    const result = await runSimctl(device, ['uninstall', device.id, bundleId], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (!isMissingAppErrorOutput(output)) {
        throw new AppError('COMMAND_FAILED', `simctl uninstall failed for ${bundleId}`, {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
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
