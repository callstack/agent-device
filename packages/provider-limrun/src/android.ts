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
import type { AndroidAdbInvocation } from '@agent-device/platform-android/mechanics';
import type { LimrunInstanceOwnership } from './instance-access.ts';
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
  readonly ownership: LimrunInstanceOwnership;
  device: DeviceInfo;
  client: LimrunAndroidClient;
  /** Instance bearer token; the recording download the SDK would run inline is done by the host instead. */
  readonly token: string;
  adbTunnel?: LimrunAdbTunnel;
  adbSerial?: string;
  adbTunnelPromise?: Promise<string>;
  /**
   * Set once teardown has begun for this session, before it yields. The host ADB endpoint is
   * process-wide, so neither a caller that kept an interactor from this session nor a tunnel this session had
   * already started may leave one no owner can tear down any more.
   */
  adbTunnelRetired?: boolean;
  /**
   * The endpoint one teardown is ending, recorded so that teardown keeps its own way to reach the device
   * whose reverse mappings it is clearing. No other route reads it.
   */
  adbTeardownSerial?: string;
  readonly dependencies: Pick<LimrunRuntimeDependencies, 'android' | 'host'>;
};

export type LimrunAndroidSession = LimrunAndroidAdbSession & {
  adbProvider: LimrunAdbProvider;
};

export async function createLimrunAndroidSession(
  options: {
    lease: DeviceLease;
    instanceId: string;
    ownership: LimrunInstanceOwnership;
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
    ownership: options.ownership,
    device: options.device,
    client,
    token: options.token,
    dependencies,
  };
  const adbProvider: LimrunAdbProvider = {
    exec: async (args, execOptions) => await runLimrunAndroidAdb(session, args, execOptions),
    text: async (request) => {
      // Loaded on the text-entry path to keep this provider's declared import-time closure budget.
      const { createLimrunAndroidTextInjector } = await import('./android-text-entry.ts');
      await createLimrunAndroidTextInjector(client)(request);
    },
  };
  adbProvider.reverse = await dependencies.android.createPortReverse(adbProvider.exec, {
    noRebind: options.ownership === 'attached',
  });
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
    await session.dependencies.android.forceStopApp(
      async (adbArgs, adbOptions) => await runLimrunAndroidAdb(session, adbArgs, adbOptions),
      packageName,
      signal,
    );
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
  // Retire first, before yielding: the host ADB endpoint is process-wide, so from this step on no retained
  // interactor can raise a tunnel, and a tunnel already in flight ends where it lands.
  session.adbTunnelRetired = true;
  // Cleanup keeps the serial it finds, or the one the in-flight start publishes while this step waits on it:
  // a start answering into a retired session records its endpoint here first, because this cleanup is the only
  // route left that can reach it. That serial is this session's only access to the host once the endpoint is
  // retired, and retirement still lets this step through — it has to clear the reverse mappings off the device
  // it is about to disconnect.
  const started = await session.adbTunnelPromise?.catch(() => undefined);
  session.adbTunnelPromise = undefined;
  const serial = session.adbSerial ?? started;
  session.adbTeardownSerial = serial;
  try {
    if (serial) {
      await cleanupAndroidPortReverse(session);
      await session.dependencies.host
        .runAdb(session.dependencies.android.hostAdbInvocation(['disconnect', serial]), {
          allowFailure: true,
          timeoutMs: 10_000,
        })
        .catch(() => {});
    }
  } finally {
    session.adbTeardownSerial = undefined;
    closeLimrunAndroidAdbTunnel(session);
  }
}

/**
 * Ends the tunnel this session holds, once. A tunnel that answered only after its session was retired
 * lands here, because retirement alone cannot reach it; nothing else is left to end it.
 */
function closeLimrunAndroidAdbTunnel(session: LimrunAndroidSession): void {
  const tunnel = session.adbTunnel;
  if (tunnel === undefined) return;
  session.adbTunnel = undefined;
  session.adbSerial = undefined;
  tunnel.close();
}

async function cleanupAndroidPortReverse(session: LimrunAndroidSession): Promise<void> {
  const reverse = session.adbProvider.reverse;
  if (!reverse?.list) return;
  const mappings = await reverse.list().catch(() => []);
  const owners = new Set<string>();
  const unownedLocals: LimrunPortReverseEndpoint[] = [];
  const sharedDevice = session.ownership === 'attached';
  for (const mapping of mappings) {
    if (mapping.ownerId) owners.add(mapping.ownerId);
    else if (!sharedDevice) unownedLocals.push(mapping.local);
  }
  await Promise.allSettled([
    ...[...owners].map(async (ownerId) => await reverse.removeAllOwned(ownerId)),
    ...unownedLocals.map(async (local) => await reverse.remove(local)),
  ]);
}

async function runLimrunAndroidAdb(
  session: LimrunAndroidAdbSession,
  args: readonly string[],
  options?: LimrunAdbCommandOptions,
): Promise<LimrunAdbCommandResult> {
  const { invocation, result } = await executeLimrunAndroidAdb(session, args, options);
  return await requireSuccessfulLimrunAndroidAdb(
    invocation,
    result,
    options?.allowFailure,
    session.dependencies,
  );
}

/**
 * The tunnel serial is this provider's own addressing decision: it goes on the invocation's
 * target, so the command array the Android cluster handed over reaches the host unchanged.
 */
async function executeLimrunAndroidAdb(
  session: LimrunAndroidAdbSession,
  args: readonly string[],
  options?: LimrunAdbCommandOptions,
): Promise<{ invocation: AndroidAdbInvocation; result: LimrunAdbCommandResult }> {
  const serial = await ensurePersistentAndroidAdbSerial(session);
  const invocation = session.dependencies.android.deviceAdbInvocation(serial, args);
  const result = await session.dependencies.host.runAdb(invocation, {
    allowFailure: options?.allowFailure,
    binaryStdout: options?.binaryStdout,
    stdin: options?.stdin,
    timeoutMs: options?.timeoutMs ?? 30_000,
    signal: options?.signal,
  });
  return { invocation, result };
}

async function requireSuccessfulLimrunAndroidAdb(
  invocation: AndroidAdbInvocation,
  result: LimrunAdbCommandResult,
  allowFailure: boolean | undefined,
  dependencies: Pick<LimrunRuntimeDependencies, 'android'>,
): Promise<LimrunAdbCommandResult> {
  if (result.exitCode !== 0 && allowFailure !== true) {
    throw await dependencies.android.adbError(
      'Limrun Android ADB command failed',
      result,
      invocation,
    );
  }
  return result;
}

async function ensurePersistentAndroidAdbSerial(session: LimrunAndroidAdbSession): Promise<string> {
  // The teardown's own read comes first, and is the only one retirement lets through: clearing an endpoint's
  // reverse mappings means asking the device this cleanup is about to disconnect what was mapped on it.
  const teardownSerial = session.adbTeardownSerial;
  if (teardownSerial !== undefined) return teardownSerial;
  // The retired check comes before the serial fast path: a session whose cleanup answered while an
  // earlier command was still in flight holds a serial nothing owns any more.
  if (session.adbTunnelRetired) throw alreadyCleanedUp(session);
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
  // Nothing between this call's start and the publication below lets a second tunnel be raised, so a session
  // retired while this tunnel was being raised records it all the same: its cleanup is the one route that can
  // still reach it, and it is awaiting this promise. Refusal alone would leave the endpoint on the host with
  // nobody left to disconnect it.
  session.adbTunnel = tunnel;
  session.adbSerial = serial;
  if (session.adbTunnelRetired) throw alreadyCleanedUp(session);
  return serial;
}

function alreadyCleanedUp(session: LimrunAndroidAdbSession): AppError {
  return new AppError(
    'SESSION_NOT_FOUND',
    `Limrun ADB tunnel for instance '${session.instanceId}' was already cleaned up`,
    {
      reason: 'limrun_adb_tunnel_cleaned_up',
      hint: `Lease '${session.lease.leaseId}' is closed. Reopen the lease instead of driving this interactor.`,
    },
  );
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
