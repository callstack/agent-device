import path from 'node:path';
import type Limrun from '@limrun/api';
import {
  createInstanceClient as createAndroidInstanceClient,
  type InstanceClient as LimrunAndroidClient,
} from '@limrun/api/instance-client';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type {
  DeviceLease,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderPortReverseOptions,
} from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  LimrunAdbCommandOptions,
  LimrunAdbCommandResult,
  LimrunAdbProvider,
  LimrunPortReverseEndpoint,
  LimrunRuntimeDependencies,
} from './runtime-dependencies.ts';
import { normalizeOptionalString } from './strings.ts';
import {
  awaitLimrunDeploymentOperation,
  type LimrunRequestOperationDrain,
} from './request-cancellation.ts';

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
  readonly dependencies: Pick<LimrunRuntimeDependencies, 'android' | 'host'>;
};

export type LimrunAndroidSession = LimrunAndroidAdbSession & {
  adbProvider: LimrunAdbProvider;
};

export async function createLimrunAndroidSession(
  options: {
    lease: DeviceLease;
    instanceId: string;
    device: DeviceInfo;
    apiUrl: string;
    adbUrl: string;
    token: string;
  },
  dependencies: Pick<LimrunRuntimeDependencies, 'android' | 'host'>,
): Promise<LimrunAndroidSession> {
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
    dependencies,
  };
  const adbProvider: LimrunAdbProvider = {
    exec: async (args, execOptions) => await runLimrunAndroidAdb(session, args, execOptions),
    text: async (request) => {
      await client.setText(request.target, request.text);
    },
  };
  adbProvider.reverse = await dependencies.android.createPortReverse(adbProvider.exec);
  return Object.assign(session, { adbProvider });
}

export function createLimrunAndroidInteractor(session: LimrunAndroidSession): Interactor {
  return session.dependencies.android.createInteractor(session.device, session.adbProvider);
}

export async function installLimrunAndroidApp(
  limrun: Limrun,
  session: LimrunAndroidSession,
  installablePath: string,
  options?: ProviderDeviceInstallOptions,
  signal?: AbortSignal,
  operationDrain?: LimrunRequestOperationDrain,
): Promise<ProviderDeviceInstallResult> {
  signal?.throwIfAborted();
  const packageName = normalizeOptionalString(options?.packageNameHint);
  if (options?.relaunch && packageName) {
    await runLimrunAndroidAdb(session, ['shell', 'am', 'force-stop', packageName], {
      allowFailure: true,
      signal,
    });
  }
  const asset = await awaitLimrunDeploymentOperation(
    operationDrain,
    limrun.assets.getOrUpload(
      {
        path: installablePath,
        name: buildAndroidAssetName(packageName, installablePath),
      },
      { signal },
    ),
    signal,
  );
  await awaitLimrunDeploymentOperation(
    operationDrain,
    session.client.sendAsset(asset.signedDownloadUrl),
    signal,
  );
  signal?.throwIfAborted();
  const appName = packageName
    ? await session.dependencies.android.inferAppName(packageName)
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
    await session.dependencies.host
      .runAdb(['disconnect', serial], {
        allowFailure: true,
        timeoutMs: 10_000,
      })
      .catch(() => {});
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
  const unownedLocals: LimrunPortReverseEndpoint[] = [];
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
  options?: LimrunAdbCommandOptions,
): Promise<LimrunAdbCommandResult> {
  const { adbArgs, result } = await executeLimrunAndroidAdb(session, args, options);
  return await requireSuccessfulLimrunAndroidAdb(
    adbArgs,
    result,
    options?.allowFailure,
    session.dependencies,
  );
}

async function executeLimrunAndroidAdb(
  session: LimrunAndroidAdbSession,
  args: string[],
  options?: LimrunAdbCommandOptions,
): Promise<{ adbArgs: string[]; result: LimrunAdbCommandResult }> {
  const serial = await ensurePersistentAndroidAdbSerial(session);
  const adbArgs = ['-s', serial, ...args];
  const result = await session.dependencies.host.runAdb(adbArgs, {
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
  result: LimrunAdbCommandResult,
  allowFailure: boolean | undefined,
  dependencies: Pick<LimrunRuntimeDependencies, 'android'>,
): Promise<LimrunAdbCommandResult> {
  if (result.exitCode !== 0 && allowFailure !== true) {
    throw await dependencies.android.adbError('Limrun Android ADB command failed', result, {
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

function tcpEndpoint(port: number): LimrunPortReverseEndpoint {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError('INVALID_ARGS', `Invalid Android tcp reverse port: ${port}`);
  }
  return `tcp:${port}`;
}

function buildAndroidAssetName(packageName: string | undefined, artifactPath: string): string {
  const extension = path.extname(artifactPath) || '.apk';
  const prefix = packageName?.replaceAll(/[^a-zA-Z0-9_.-]+/g, '-') || 'android-app';
  return `${prefix}${extension}`;
}
