import path from 'node:path';
import type Limrun from '@limrun/api';
import {
  createInstanceClient as createAndroidInstanceClient,
  type InstanceClient as LimrunAndroidClient,
} from '@limrun/api/instance-client';
import { createAndroidInteractor } from '../../core/interactors/android.ts';
import type { Interactor } from '../../core/interactor-types.ts';
import type { DeviceLease } from '../../daemon/lease-registry.ts';
import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import {
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
  type AndroidAdbProvider,
  type AndroidPortReverseEndpoint,
} from '../../platforms/android/adb-executor.ts';
import type {
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderPortReverseOptions,
} from '../../provider-device-runtime.ts';
import { runCmd } from '../../utils/exec.ts';
import { normalizeOptionalString } from './strings.ts';

type LimrunAdbTunnel = Awaited<ReturnType<LimrunAndroidClient['startAdbTunnel']>>;

type LimrunAndroidAdbSession = {
  platform: 'android';
  lease: DeviceLease;
  instanceId: string;
  device: DeviceInfo;
  client: LimrunAndroidClient;
  adbTunnel?: LimrunAdbTunnel;
  adbSerial?: string;
  adbTunnelPromise?: Promise<string>;
};

export type LimrunAndroidSession = LimrunAndroidAdbSession & {
  adbProvider: AndroidAdbProvider;
};

export async function createLimrunAndroidSession(options: {
  lease: DeviceLease;
  instanceId: string;
  device: DeviceInfo;
  apiUrl: string;
  adbUrl: string;
  token: string;
}): Promise<LimrunAndroidSession> {
  const client = await createAndroidInstanceClient({
    apiUrl: options.apiUrl,
    adbUrl: options.adbUrl,
    token: options.token,
    logLevel: 'warn',
  });
  const session: LimrunAndroidAdbSession = {
    platform: 'android',
    lease: options.lease,
    instanceId: options.instanceId,
    device: options.device,
    client,
  };
  const adbProvider: AndroidAdbProvider = {
    exec: async (args, execOptions) => await runLimrunAndroidAdb(session, args, execOptions),
    text: async (request) => {
      await client.setText(request.target, request.text);
    },
  };
  const { createAndroidPortReverseManager } =
    await import('../../platforms/android/adb-executor.ts');
  adbProvider.reverse = createAndroidPortReverseManager(adbProvider);
  return Object.assign(session, { adbProvider });
}

export function createLimrunAndroidInteractor(session: LimrunAndroidSession): Interactor {
  return createAndroidInteractor(session.device, session.adbProvider);
}

export async function installLimrunAndroidApp(
  limrun: Limrun,
  session: LimrunAndroidSession,
  installablePath: string,
  options?: ProviderDeviceInstallOptions,
): Promise<ProviderDeviceInstallResult> {
  const packageName = normalizeOptionalString(options?.packageNameHint);
  if (options?.relaunch && packageName) {
    await runLimrunAndroidAdb(session, ['shell', 'am', 'force-stop', packageName], {
      allowFailure: true,
    });
  }
  const asset = await limrun.assets.getOrUpload({
    path: installablePath,
    name: buildAndroidAssetName(packageName, installablePath),
  });
  await session.client.sendAsset(asset.signedDownloadUrl);
  const appName = packageName
    ? (await import('../../platforms/android/app-lifecycle.ts')).inferAndroidAppName(packageName)
    : undefined;
  return {
    ...(packageName ? { packageName, launchTarget: packageName } : {}),
    ...(appName ? { appName } : {}),
  };
}

export async function configureLimrunAndroidPortReverse(
  session: LimrunAndroidSession,
  options: ProviderPortReverseOptions,
): Promise<void> {
  await session.adbProvider.reverse?.ensure({
    local: tcpEndpoint(options.devicePort),
    remote: tcpEndpoint(options.hostPort),
    ownerId: options.name,
  });
}

export async function cleanupLimrunAndroidAdbTunnel(session: LimrunAndroidSession): Promise<void> {
  await session.adbTunnelPromise?.catch(() => {});
  const serial = session.adbSerial;
  if (serial) {
    await cleanupAndroidPortReverse(session);
    await runCmd('adb', ['disconnect', serial], {
      allowFailure: true,
      timeoutMs: 10_000,
    }).catch(() => {});
  }
  session.adbTunnel?.close();
  session.adbTunnel = undefined;
  session.adbSerial = undefined;
  session.adbTunnelPromise = undefined;
}

async function cleanupAndroidPortReverse(session: LimrunAndroidSession): Promise<void> {
  const reverse = session.adbProvider.reverse;
  if (!reverse?.list) return;
  const mappings = await reverse.list().catch(() => []);
  const owners = new Set<string>();
  const unownedLocals: AndroidPortReverseEndpoint[] = [];
  for (const mapping of mappings) {
    if (mapping.ownerId) owners.add(mapping.ownerId);
    else unownedLocals.push(mapping.local);
  }
  await Promise.allSettled([
    ...[...owners].map(async (ownerId) => await reverse.removeAllOwned(ownerId)),
    ...unownedLocals.map(async (local) => await reverse.remove(local)),
  ]);
}

async function runLimrunAndroidAdb(
  session: LimrunAndroidAdbSession,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<AndroidAdbExecutorResult> {
  const { adbArgs, result } = await executeLimrunAndroidAdb(session, args, options);
  return await requireSuccessfulLimrunAndroidAdb(adbArgs, result, options?.allowFailure);
}

async function executeLimrunAndroidAdb(
  session: LimrunAndroidAdbSession,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<{ adbArgs: string[]; result: AndroidAdbExecutorResult }> {
  const serial = await ensurePersistentAndroidAdbSerial(session);
  const adbArgs = ['-s', serial, ...args];
  const result = await runCmd('adb', adbArgs, {
    allowFailure: options?.allowFailure,
    binaryStdout: options?.binaryStdout,
    stdin: options?.stdin,
    timeoutMs: options?.timeoutMs ?? 30_000,
    signal: options?.signal,
  });
  return { adbArgs, result };
}

async function requireSuccessfulLimrunAndroidAdb(
  adbArgs: string[],
  result: AndroidAdbExecutorResult,
  allowFailure: boolean | undefined,
): Promise<AndroidAdbExecutorResult> {
  if (result.exitCode !== 0 && allowFailure !== true) {
    const { androidAdbResultError } = await import('../../platforms/android/adb-executor.ts');
    throw androidAdbResultError('Limrun Android ADB command failed', result, {
      command: ['adb', ...adbArgs].join(' '),
    });
  }
  return result;
}

async function ensurePersistentAndroidAdbSerial(session: LimrunAndroidAdbSession): Promise<string> {
  if (session.adbSerial) return session.adbSerial;
  const pending = session.adbTunnelPromise ?? startAndroidAdbTunnel(session);
  session.adbTunnelPromise = pending;
  try {
    return await pending;
  } catch (error) {
    if (session.adbTunnelPromise === pending) session.adbTunnelPromise = undefined;
    throw error;
  }
}

async function startAndroidAdbTunnel(session: LimrunAndroidAdbSession): Promise<string> {
  const tunnel = await session.client.startAdbTunnel();
  const serial = `${tunnel.address.address}:${tunnel.address.port}`;
  session.adbTunnel = tunnel;
  session.adbSerial = serial;
  return serial;
}

function tcpEndpoint(port: number): AndroidPortReverseEndpoint {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError('INVALID_ARGS', `Invalid Android tcp reverse port: ${port}`);
  }
  return `tcp:${port}`;
}

function buildAndroidAssetName(packageName: string | undefined, artifactPath: string): string {
  const extension = path.extname(artifactPath) || '.apk';
  const prefix = packageName?.replace(/[^a-zA-Z0-9_.-]+/g, '-') || 'android-app';
  return `${prefix}${extension}`;
}
