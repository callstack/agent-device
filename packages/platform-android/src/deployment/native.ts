import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { PushNotificationInput } from '@agent-device/contracts/app-deployment-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import path from 'node:path';

export async function installAndroidArtifact(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  installablePath: string,
  packageNameHint: string | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  const before = packageNameHint ? undefined : await listInstalledPackages(host, device, signal);
  if (path.extname(installablePath).toLowerCase() === '.aab') {
    await installAndroidBundle(host, device, installablePath, signal);
  } else {
    const result = await host.androidTools.installPackage(
      device,
      installablePath,
      { replace: true },
      signal,
    );
    assertCommandSuccess(result, 'adb install failed');
  }
  if (packageNameHint) return packageNameHint;
  const after = await listInstalledPackages(host, device, signal);
  const installed = [...after].filter((name) => !before?.has(name));
  return installed.length === 1 ? installed[0] : undefined;
}

export async function uninstallAndroidPackage(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  packageName: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await runAdb(host, device, ['uninstall', packageName], signal);
  if (result.exitCode === 0) return;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes('unknown package') || output.includes('not installed')) return;
  assertCommandSuccess(result, `adb uninstall failed for ${packageName}`);
}

export async function pushAndroidNotification(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: PushNotificationInput,
  signal: AbortSignal,
) {
  const payload = input.payload as { action?: unknown; receiver?: unknown; extras?: unknown };
  const action =
    typeof payload.action === 'string' && payload.action.trim()
      ? payload.action.trim()
      : `${input.appId}.TEST_PUSH`;
  const args = ['shell', 'am', 'broadcast', '-a', action, '-p', input.appId];
  if (typeof payload.receiver === 'string' && payload.receiver.trim()) {
    args.push('-n', payload.receiver.trim());
  }
  const extras = payload.extras ?? {};
  if (typeof extras !== 'object' || extras === null || Array.isArray(extras)) {
    throw new AppError('INVALID_ARGS', 'Android push payload extras must be an object');
  }
  let extrasCount = 0;
  for (const [key, value] of Object.entries(extras)) {
    if (!key) continue;
    appendBroadcastExtra(args, key, value);
    extrasCount += 1;
  }
  const result = await runAdb(host, device, args, signal);
  assertCommandSuccess(result, 'adb push broadcast failed');
  return { action, extrasCount };
}

export function inferAndroidAppName(packageName: string): string {
  const ignored = new Set([
    'com',
    'android',
    'google',
    'app',
    'apps',
    'service',
    'services',
    'mobile',
    'client',
  ]);
  const tokens = packageName
    .split(/[._-]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const chosen =
    [...tokens].reverse().find((token) => !ignored.has(token)) ?? tokens.at(-1) ?? packageName;
  return chosen.charAt(0).toUpperCase() + chosen.slice(1);
}

async function installAndroidBundle(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  bundlePath: string,
  signal: AbortSignal,
): Promise<void> {
  if (await host.androidTools.installBundle(device, bundlePath, 'universal', signal)) return;
  const bundletool = await host.commands.which('bundletool');
  const jar = host.androidDeployment.bundletoolJar;
  if (!bundletool && !jar) {
    throw new AppError(
      'TOOL_MISSING',
      'bundletool not found in PATH. Install bundletool or set AGENT_DEVICE_BUNDLETOOL_JAR.',
    );
  }
  const executable = bundletool ? 'bundletool' : 'java';
  const prefix = bundletool ? [] : ['-jar', jar!];
  const apks = await host.temporaryFiles.create({
    prefix: 'agent-device-aab-',
    suffix: '.apks',
  });
  const apksPath = apks.path;
  try {
    assertCommandSuccess(
      await host.commands.run(
        {
          executable,
          args: [
            ...prefix,
            'build-apks',
            '--bundle',
            bundlePath,
            '--output',
            apksPath,
            '--mode',
            'universal',
          ],
        },
        signal,
      ),
      'bundletool build-apks failed',
    );
    assertCommandSuccess(
      await host.commands.run(
        {
          executable,
          args: [...prefix, 'install-apks', '--apks', apksPath, '--device-id', device.id],
        },
        signal,
      ),
      'bundletool install-apks failed',
    );
  } finally {
    await apks[Symbol.asyncDispose]();
  }
}

async function listInstalledPackages(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<Set<string>> {
  const result = await runAdb(host, device, ['shell', 'pm', 'list', 'packages'], signal);
  assertCommandSuccess(result, 'adb package inventory failed');
  return new Set(
    result.stdout
      .split('\n')
      .map((line) => line.replace('package:', '').trim())
      .filter(Boolean),
  );
}

function appendBroadcastExtra(args: string[], key: string, value: unknown): void {
  if (typeof value === 'string') args.push('--es', key, value);
  else if (typeof value === 'boolean') args.push('--ez', key, String(value));
  else if (typeof value === 'number' && Number.isFinite(value)) {
    args.push(Number.isInteger(value) ? '--ei' : '--ef', key, String(value));
  } else {
    throw new AppError(
      'INVALID_ARGS',
      `Unsupported Android broadcast extra type for "${key}". Use string, boolean, or number.`,
    );
  }
}

async function runAdb(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs = 15_000,
) {
  return await host.androidTools.runAdb(device, args, { timeoutMs, allowFailure: true }, signal);
}

function assertCommandSuccess(
  result: Readonly<{ stdout: string; stderr: string; exitCode: number | null }>,
  message: string,
): void {
  if (result.exitCode === 0) return;
  const details = {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
  throw new AppError('COMMAND_FAILED', message, details);
}
