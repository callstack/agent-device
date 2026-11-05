import type Limrun from '@limrun/api';
import type { DeviceLease, LeaseLifecycleContext } from '@agent-device/contracts/device';
import { REMOTE_LEASE_IDLE_TTL_MS } from '@agent-device/contracts/lease-scope';
import { AppError } from '@agent-device/kernel/errors';
import { rejectRefusedProviderProfileFields } from '@agent-device/contracts/provider-profile-fields';
import { createLimrunAndroidSession, type LimrunAndroidSession } from './android.ts';
import { LIMRUN_SINGLE_ATTEMPT } from './client-options.ts';
import { buildLimrunDevice, LIMRUN_PROFILE_FIELDS } from './device.ts';
import { createLimrunIosSession, type LimrunIosSession } from './ios.ts';
import {
  assertLimrunUploadedAppAccess,
  resolveInstalledAppIdForAsset,
  resolveLimrunAppAsset,
  type LimrunAppAsset,
} from './app-catalog.ts';
import { createLimrunDeviceSession } from './device-session.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

/** A created instance outlives its lease's idle window, so Limrun's 3 minute default never ends it first. */
const LIMRUN_INACTIVITY_TIMEOUT = `${REMOTE_LEASE_IDLE_TTL_MS / 60_000}m`;

type LimrunInstance = {
  metadata: { id: string };
  status: {
    token: string;
    apiUrl?: string;
    adbWebSocketUrl?: string;
  };
};

type SessionAllocationParams = Readonly<{
  limrun: Limrun;
  lease: DeviceLease;
  metadata: Readonly<{
    displayName: string;
    labels: Readonly<Record<string, string>>;
  }>;
  region?: string;
  app?: LimrunAppAsset;
  dependencies: LimrunRuntimeDependencies;
}>;

export function rejectRefusedLimrunProfileFields(context?: LeaseLifecycleContext): void {
  rejectRefusedProviderProfileFields(context?.flags, LIMRUN_PROFILE_FIELDS);
}

export async function resolveRequestedLimrunAppAsset(
  limrun: Limrun,
  platform: 'android' | 'ios',
  context?: LeaseLifecycleContext,
): Promise<LimrunAppAsset | undefined> {
  const value = context?.initialApp;
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return undefined;
  assertLimrunUploadedAppAccess(context?.publicNetworkOnly);
  return await resolveLimrunAppAsset(limrun, platform, name, context?.signal);
}

export async function resolvePreinstalledAppId(
  session: LimrunAndroidSession | LimrunIosSession,
  asset: LimrunAppAsset,
): Promise<string> {
  const apps = await createLimrunDeviceSession(session).listApps('user-installed');
  const matchedAppId = resolveInstalledAppIdForAsset(asset.name, apps);
  if (matchedAppId) return matchedAppId;
  throw new AppError(
    'COMMAND_FAILED',
    `Limrun installed ${asset.name}, but its application identifier could not be resolved unambiguously.`,
    { asset: asset.name, installedApps: apps.map((app) => app.id) },
  );
}

export async function allocateLimrunIosSession(
  params: SessionAllocationParams,
  onRent: (instanceId: string) => void,
): Promise<LimrunIosSession> {
  const instance = (await params.limrun.iosInstances.create(
    {
      wait: true,
      metadata: params.metadata,
      spec: {
        inactivityTimeout: LIMRUN_INACTIVITY_TIMEOUT,
        ...(params.region ? { region: params.region } : {}),
        ...(params.app
          ? {
              initialAssets: [
                {
                  kind: 'App' as const,
                  source: 'AssetID' as const,
                  assetId: params.app.id,
                  launchMode: 'RelaunchIfRunning' as const,
                },
              ],
            }
          : {}),
      },
    },
    // Limrun may have created this instance even though its answer was lost, so the SDK must not POST
    // this call again: a second create would rent a second instance nobody is standing beside.
    LIMRUN_SINGLE_ATTEMPT,
  )) as LimrunInstance;
  const instanceId = instance.metadata.id;
  // Rented from this step: the caller's owner records the instance here, before any session is built on it,
  // so its disposal can always end it — including when the endpoint check or the session below fails.
  onRent(instanceId);
  if (!instance.status.apiUrl) {
    throw new AppError('COMMAND_FAILED', 'Limrun iOS instance did not expose apiUrl');
  }
  return await createLimrunIosSession(
    {
      lease: params.lease,
      instanceId,
      ownership: 'created',
      device: buildLimrunDevice('ios', params.lease, instanceId),
      apiUrl: instance.status.apiUrl,
      token: instance.status.token,
    },
    params.dependencies,
  );
}

export async function allocateLimrunAndroidSession(
  params: SessionAllocationParams,
  onRent: (instanceId: string) => void,
): Promise<LimrunAndroidSession> {
  const instance = (await params.limrun.androidInstances.create(
    {
      wait: true,
      metadata: params.metadata,
      spec: {
        inactivityTimeout: LIMRUN_INACTIVITY_TIMEOUT,
        ...(params.region ? { region: params.region } : {}),
        ...(params.app
          ? {
              initialAssets: [
                {
                  kind: 'App' as const,
                  source: 'AssetIDs' as const,
                  assetIds: [params.app.id],
                },
              ],
            }
          : {}),
      },
    },
    // Limrun may have created this instance even though its answer was lost, so the SDK must not POST
    // this call again: a second create would rent a second instance nobody is standing beside.
    LIMRUN_SINGLE_ATTEMPT,
  )) as LimrunInstance;
  const instanceId = instance.metadata.id;
  // Rented from this step: the caller's owner records the instance here, before any session is built on it,
  // so its disposal can always end it — including when an endpoint is missing or the session below fails.
  onRent(instanceId);
  if (!instance.status.apiUrl || !instance.status.adbWebSocketUrl) {
    throw new AppError(
      'COMMAND_FAILED',
      'Limrun Android instance did not expose API and ADB websocket endpoints',
    );
  }
  return await createLimrunAndroidSession(
    {
      lease: params.lease,
      instanceId,
      ownership: 'created',
      device: buildLimrunDevice('android', params.lease, instanceId),
      apiUrl: instance.status.apiUrl,
      token: instance.status.token,
      adbUrl: instance.status.adbWebSocketUrl,
    },
    params.dependencies,
  );
}
