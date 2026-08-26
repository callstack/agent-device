import { AppError } from '@agent-device/kernel/errors';
import { requireAndroidAdbHost } from './adb-host.ts';
import { resolveAndroidAdbTransferProvider } from './adb-provider-scope.ts';
import {
  normalizeAndroidAdbInstallOptions,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorResult,
  type AndroidAdbInstallOptions,
  type AndroidAdbProvider,
  type AndroidAdbTransferOptions,
} from './adb-transport.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

// Pull/install transfer funnels: semantic provider methods when a provider ships them, with the
// legacy exec-shaped fallback otherwise. Both escape any active command-executor override so a
// tunnel-backed provider shelling out to adb cannot route back into itself.

type AndroidAdbTransferProviderOptions = {
  device?: DeviceInfo;
  provider?: AndroidAdbProvider | AndroidAdbExecutor;
};

export async function pullAndroidAdbFile(
  remotePath: string,
  localPath: string,
  options?: AndroidAdbTransferOptions & AndroidAdbTransferProviderOptions,
): Promise<AndroidAdbExecutorResult> {
  const { device, provider, ...transferOptions } = options ?? {};
  const resolved = resolveAndroidAdbTransferProvider(device, provider);
  const pull = resolved?.pull;
  const host = requireAndroidAdbHost();
  if (pull) {
    return await host.withoutAdbCommandExecutorOverride(
      async () => await pull(remotePath, localPath, transferOptions),
    );
  }
  const exec = resolved?.exec;
  if (!exec) {
    throw new AppError('COMMAND_FAILED', 'Android adb pull requires an adb provider');
  }
  return await host.withoutAdbCommandExecutorOverride(
    async () => await exec(['pull', remotePath, localPath], transferOptions),
  );
}

export async function installAndroidAdbPackage(
  apkPath: string,
  options?: AndroidAdbInstallOptions & AndroidAdbTransferProviderOptions,
): Promise<AndroidAdbExecutorResult> {
  const { device, provider, ...installOptions } = options ?? {};
  const resolved = resolveAndroidAdbTransferProvider(device, provider);
  const install = resolved?.install;
  const host = requireAndroidAdbHost();
  if (install) {
    return await host.withoutAdbCommandExecutorOverride(
      async () => await install(apkPath, installOptions),
    );
  }
  const exec = resolved?.exec;
  if (!exec) {
    throw new AppError('COMMAND_FAILED', 'Android adb install requires an adb provider');
  }
  const { installArgs, execOptions } = normalizeAndroidAdbInstallOptions(installOptions);
  return await host.withoutAdbCommandExecutorOverride(
    async () => await exec(['install', ...installArgs, apkPath], execOptions),
  );
}
