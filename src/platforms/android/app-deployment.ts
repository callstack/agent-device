import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveFileOverridePath, runCmd, whichCmd } from '@agent-device/host-kit/command';
import { waitForAndroidBoot } from './emulator-lifecycle.ts';
import { installAndroidAdbPackage, resolveAndroidAdbProvider } from './adb-executor.ts';
import { withAndroidAppResolutionCacheInvalidated } from './app-deployment-resolution.ts';

type AndroidDeploymentSignalOptions = Readonly<{ signal?: AbortSignal }>;

type BundletoolInvocation =
  | { cmd: 'bundletool'; prefixArgs: readonly string[] }
  | { cmd: 'java'; prefixArgs: readonly string[] };

let cachedBundletoolInvocation: { key: string; invocation: BundletoolInvocation } | null = null;

function bundletoolInvocationCacheKey(): string {
  return `${process.env.PATH ?? ''}::${process.env.AGENT_DEVICE_BUNDLETOOL_JAR ?? ''}`;
}

async function resolveBundletoolInvocation(): Promise<BundletoolInvocation> {
  const cacheKey = bundletoolInvocationCacheKey();
  if (cachedBundletoolInvocation?.key === cacheKey) {
    return cachedBundletoolInvocation.invocation;
  }

  if (await whichCmd('bundletool')) {
    const invocation = { cmd: 'bundletool', prefixArgs: [] } as const;
    cachedBundletoolInvocation = { key: cacheKey, invocation };
    return invocation;
  }

  const bundletoolJar = await resolveFileOverridePath(
    process.env.AGENT_DEVICE_BUNDLETOOL_JAR,
    'AGENT_DEVICE_BUNDLETOOL_JAR',
  );
  if (!bundletoolJar) {
    throw new AppError(
      'TOOL_MISSING',
      'bundletool not found in PATH. Install bundletool or set AGENT_DEVICE_BUNDLETOOL_JAR to a bundletool-all.jar path.',
    );
  }
  const invocation = { cmd: 'java', prefixArgs: ['-jar', bundletoolJar] } as const;
  cachedBundletoolInvocation = { key: cacheKey, invocation };
  return invocation;
}

async function runBundletool(args: string[], signal?: AbortSignal): Promise<void> {
  const invocation = await resolveBundletoolInvocation();
  await runCmd(invocation.cmd, [...invocation.prefixArgs, ...args], { signal });
}

function isAndroidAppBundlePath(appPath: string): boolean {
  return path.extname(appPath).toLowerCase() === '.aab';
}

async function installAndroidAppBundle(
  device: DeviceInfo,
  appPath: string,
  options: AndroidDeploymentSignalOptions = {},
): Promise<void> {
  const provider = resolveAndroidAdbProvider(device);
  const mode = 'universal';
  if (provider.installBundle) {
    await provider.installBundle(appPath, { mode, signal: options.signal });
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-aab-'));
  const apksPath = path.join(tempDir, 'bundle.apks');
  try {
    await runBundletool(
      ['build-apks', '--bundle', appPath, '--output', apksPath, '--mode', mode],
      options.signal,
    );
    await runBundletool(
      ['install-apks', '--apks', apksPath, '--device-id', device.id],
      options.signal,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function installAndroidAppFiles(
  device: DeviceInfo,
  appPath: string,
  options: AndroidDeploymentSignalOptions = {},
): Promise<void> {
  if (isAndroidAppBundlePath(appPath)) {
    await installAndroidAppBundle(device, appPath, options);
    return;
  }
  await installAndroidAdbPackage(appPath, {
    device,
    replace: true,
    signal: options.signal,
  });
}

/** Installs an APK/AAB behind one cache invalidation transaction. */
export async function installAndroidInstallablePath(
  device: DeviceInfo,
  installablePath: string,
  options: AndroidDeploymentSignalOptions = {},
): Promise<void> {
  await withAndroidAppResolutionCacheInvalidated(device, async () => {
    if (!device.booted) {
      await waitForAndroidBoot(device.id, undefined, options.signal);
    }
    await installAndroidAppFiles(device, installablePath, options);
  });
}
