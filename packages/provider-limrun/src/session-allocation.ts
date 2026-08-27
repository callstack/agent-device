import type Limrun from '@limrun/api';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { createLimrunAndroidSession, type LimrunAndroidSession } from './android.ts';
import { buildLimrunDevice } from './device.ts';
import { createLimrunIosSession, type LimrunIosSession } from './ios.ts';
import type { LimrunAppAsset } from './app-catalog.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

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

export async function allocateLimrunIosSession(
  params: SessionAllocationParams,
): Promise<LimrunIosSession> {
  const instance = (await params.limrun.iosInstances.create({
    wait: true,
    metadata: params.metadata,
    spec: {
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
  })) as LimrunInstance;
  try {
    if (!instance.status.apiUrl) {
      throw new AppError('COMMAND_FAILED', 'Limrun iOS instance did not expose apiUrl');
    }
    return await createLimrunIosSession(
      {
        lease: params.lease,
        instanceId: instance.metadata.id,
        device: buildLimrunDevice('ios', params.lease, instance.metadata.id),
        apiUrl: instance.status.apiUrl,
        token: instance.status.token,
      },
      params.dependencies,
    );
  } catch (error) {
    await params.limrun.iosInstances.delete(instance.metadata.id).catch(() => {});
    throw error;
  }
}

export async function allocateLimrunAndroidSession(
  params: SessionAllocationParams,
): Promise<LimrunAndroidSession> {
  const instance = (await params.limrun.androidInstances.create({
    wait: true,
    metadata: params.metadata,
    spec: {
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
  })) as LimrunInstance;
  try {
    if (!instance.status.apiUrl || !instance.status.adbWebSocketUrl) {
      throw new AppError(
        'COMMAND_FAILED',
        'Limrun Android instance did not expose API and ADB websocket endpoints',
      );
    }
    return await createLimrunAndroidSession(
      {
        lease: params.lease,
        instanceId: instance.metadata.id,
        device: buildLimrunDevice('android', params.lease, instance.metadata.id),
        apiUrl: instance.status.apiUrl,
        token: instance.status.token,
        adbUrl: instance.status.adbWebSocketUrl,
      },
      params.dependencies,
    );
  } catch (error) {
    await params.limrun.androidInstances.delete(instance.metadata.id).catch(() => {});
    throw error;
  }
}
