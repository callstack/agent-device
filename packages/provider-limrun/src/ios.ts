import type { SettingOptions } from '@agent-device/contracts/settings';
import type {
  DeviceLease,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
} from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type Limrun from '@limrun/api';
import {
  createInstanceClient as createIosInstanceClient,
  type InstanceClient as LimrunIosClient,
} from '@limrun/api/ios-client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeOptionalString } from './strings.ts';
import {
  awaitLimrunDeploymentOperation,
  type LimrunRequestOperationDrain,
} from './request-cancellation.ts';
import type { LimrunInstanceOwnership } from './instance-access.ts';
import type { LimrunRuntimeDependencies, LimrunIosRunner } from './runtime-dependencies.ts';

export type LimrunIosSession = {
  platform: 'ios';
  lease: DeviceLease;
  instanceId: string;
  readonly apiUrl: string;
  runner: LimrunIosRunner;
  appBundleId?: string;
  readonly ownership: LimrunInstanceOwnership;
  device: DeviceInfo;
  client: LimrunIosClient;
  /** Instance bearer token; the recording download the SDK would run inline is done by the host instead. */
  readonly token: string;
  readonly dependencies: Pick<LimrunRuntimeDependencies, 'host' | 'ios'>;
};

export type LimrunIosRemoteInstallOptions = {
  md5?: string;
  relaunch?: boolean;
  appIdentifierHint?: string;
};

export type LimrunIosRemoteInstallResult = {
  appId?: string;
};

type LimrunIosApp = Awaited<ReturnType<LimrunIosClient['listApps']>>[number];

export async function createLimrunIosSession(
  options: {
    lease: DeviceLease;
    instanceId: string;
    ownership: LimrunInstanceOwnership;
    device: DeviceInfo;
    apiUrl: string;
    token: string;
  },
  dependencies: Pick<LimrunRuntimeDependencies, 'host' | 'ios'>,
): Promise<LimrunIosSession> {
  const client = await createIosInstanceClient({
    apiUrl: options.apiUrl,
    token: options.token,
    logLevel: 'warn',
  });
  try {
    const runner = await dependencies.ios.createRunner({ ...options, client });
    return { ...options, platform: 'ios', client, runner, dependencies };
  } catch (error) {
    client.disconnect();
    throw error;
  }
}

export async function installLimrunIosApp(
  limrun: Limrun,
  session: LimrunIosSession,
  installablePath: string,
  options?: ProviderDeviceInstallOptions,
  signal?: AbortSignal,
  operationDrain?: LimrunRequestOperationDrain,
): Promise<ProviderDeviceInstallResult> {
  signal?.throwIfAborted();
  const prepared = await prepareLimrunIosAsset(installablePath, session.dependencies);
  try {
    signal?.throwIfAborted();
    const asset = await awaitLimrunDeploymentOperation(
      operationDrain,
      limrun.assets.getOrUpload(
        {
          path: prepared.uploadPath,
          name: prepared.assetName,
        },
        { signal },
      ),
      signal,
    );
    const result = await installLimrunIosRemoteApp(
      session,
      asset.signedDownloadUrl,
      {
        md5: asset.md5,
        relaunch: options?.relaunch,
        appIdentifierHint: options?.appIdentifierHint,
      },
      signal,
      operationDrain,
    );
    const bundleId = result.appId;
    return {
      ...(bundleId ? { bundleId, launchTarget: bundleId } : {}),
      ...(prepared.appName ? { appName: prepared.appName } : {}),
    };
  } finally {
    await prepared.cleanup();
  }
}

export async function installLimrunIosRemoteApp(
  session: LimrunIosSession,
  url: string,
  options?: LimrunIosRemoteInstallOptions,
  signal?: AbortSignal,
  operationDrain?: LimrunRequestOperationDrain,
): Promise<LimrunIosRemoteInstallResult> {
  signal?.throwIfAborted();
  const beforeInstallApps = await awaitLimrunDeploymentOperation(
    operationDrain,
    session.client.listApps(),
    signal,
  ).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    return undefined;
  });
  const result = await awaitLimrunDeploymentOperation(
    operationDrain,
    session.client.installApp(url, {
      // The server's digest cache survives uninstall, so every requested install must run.
      launchMode: options?.relaunch ? 'RelaunchIfRunning' : undefined,
    }),
    signal,
  );
  const resultBundleId = normalizeOptionalString(result.bundleId);
  const requestedBundleId = normalizeOptionalString(options?.appIdentifierHint);
  let afterInstallApps: LimrunIosApp[] = [];
  for (const delayMs of IOS_APP_INVENTORY_RETRY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs, undefined, { signal });
    afterInstallApps = await awaitLimrunDeploymentOperation(
      operationDrain,
      session.client.listApps(),
      signal,
    );
    const verifiedBundleId = resolveInstalledIosAppId({
      resultBundleId,
      requestedBundleId,
      beforeInstallApps,
      afterInstallApps,
    });
    if (verifiedBundleId) return { appId: verifiedBundleId };
  }
  throw new AppError('COMMAND_FAILED', 'Limrun iOS app installation could not be verified.', {
    resultBundleId,
    requestedBundleId,
    installedUserApps: afterInstallApps
      .filter(isUserInstalledIosApp)
      .map((app) => app.bundleId)
      .sort(),
  });
}

export function createLimrunIosInteractor(
  session: LimrunIosSession,
  runner?: RunnerContext,
): Interactor {
  const context = {
    ...runner,
    get appBundleId() {
      return runner?.appBundleId ?? session.appBundleId;
    },
  };
  const shared = session.runner.createInteractor(context);
  const host = new LimrunIosHostInteractor(session, shared, context);
  return {
    ...shared,
    open: host.open.bind(host),
    openDevice: host.openDevice.bind(host),
    close: host.close.bind(host),
    setSetting: host.setSetting.bind(host),
  };
}

class LimrunIosHostInteractor {
  private readonly session: LimrunIosSession;

  private readonly signal?: AbortSignal;
  private readonly context: RunnerContext;
  private readonly shared: Interactor;

  constructor(session: LimrunIosSession, shared: Interactor, context: RunnerContext) {
    this.session = session;
    this.shared = shared;
    this.context = context;
    this.signal = context.signal;
  }

  async open(app: string, options?: Parameters<Interactor['open']>[1]): Promise<void> {
    const target =
      options?.appBundleId ??
      (
        await this.session.runner.applicationTools.resolveOpenTarget(this.session.device, {
          target: app,
          currentAppBundleId: this.context.appBundleId,
          surface: 'app',
        })
      ).appBundleId;
    await this.shared.open(app, { ...options, appBundleId: target });
    this.session.appBundleId = target;
  }

  async openDevice(): Promise<void> {}

  async close(app: string): Promise<void> {
    const { appBundleId } = await this.session.runner.applicationTools.resolveOpenTarget(
      this.session.device,
      {
        target: app,
        surface: 'app',
      },
    );
    await this.shared.close(appBundleId ?? app);
    if (appBundleId !== undefined && this.session.appBundleId === appBundleId) {
      await this.session.runner.resetTarget(this.signal);
      this.session.appBundleId = undefined;
    }
  }

  async setSetting(
    setting: string,
    state: string,
    appId?: string,
    options?: SettingOptions,
  ): Promise<Record<string, unknown> | void> {
    if (setting.toLowerCase() === 'reset-keychain') {
      throw new AppError('UNSUPPORTED_OPERATION', 'Limrun does not expose keychain reset.');
    }
    return await this.shared.setSetting(setting, state, appId, options);
  }
}

async function prepareLimrunIosAsset(
  artifactPath: string,
  dependencies: Pick<LimrunRuntimeDependencies, 'host' | 'ios'>,
): Promise<{
  uploadPath: string;
  assetName: string;
  appName?: string;
  cleanup: () => Promise<void>;
}> {
  const stat = await fs.promises.stat(artifactPath);
  if (!stat.isDirectory()) {
    return {
      uploadPath: artifactPath,
      assetName: path.basename(artifactPath),
      appName: inferAppNameFromPath(artifactPath),
      cleanup: async () => {},
    };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-device-limrun-ios-app-'));
  const zipPath = path.join(tempDir, `${path.basename(artifactPath)}.zip`);
  try {
    await dependencies.host.archiveDirectory({
      sourceDirectory: path.dirname(artifactPath),
      entryName: path.basename(artifactPath),
      archivePath: zipPath,
    });
  } catch (error) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  return {
    uploadPath: zipPath,
    assetName: path.basename(zipPath),
    appName:
      (await dependencies.ios.readBundleAppName(artifactPath)) ??
      inferAppNameFromPath(artifactPath),
    cleanup: async () => {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    },
  };
}

function inferAppNameFromPath(appPath: string): string | undefined {
  const base = path.basename(appPath).replace(/\.(?:app|ipa|apk|aab|zip)$/i, '');
  return base || undefined;
}

const IOS_APP_INVENTORY_RETRY_DELAYS_MS = [0, 250] as const;

function resolveInstalledIosAppId(params: {
  resultBundleId?: string;
  requestedBundleId?: string;
  beforeInstallApps: LimrunIosApp[] | undefined;
  afterInstallApps: LimrunIosApp[];
}): string | undefined {
  const installedBundleIds = new Set(params.afterInstallApps.map((app) => app.bundleId));
  return (
    (params.resultBundleId && installedBundleIds.has(params.resultBundleId)
      ? params.resultBundleId
      : undefined) ??
    (params.requestedBundleId && installedBundleIds.has(params.requestedBundleId)
      ? params.requestedBundleId
      : undefined) ??
    inferNewUserInstalledApp(params.beforeInstallApps, params.afterInstallApps)
  );
}

function inferNewUserInstalledApp(
  beforeInstallApps: LimrunIosApp[] | undefined,
  afterInstallApps: LimrunIosApp[],
): string | undefined {
  if (!beforeInstallApps) return undefined;
  const beforeBundleIds = new Set(beforeInstallApps.map((app) => app.bundleId));
  const candidates = afterInstallApps.filter(
    (app) => isUserInstalledIosApp(app) && !beforeBundleIds.has(app.bundleId),
  );
  return candidates.length === 1 ? candidates[0]?.bundleId : undefined;
}

export function isUserInstalledIosApp(app: LimrunIosApp): boolean {
  return (
    !app.bundleId.startsWith('com.apple.') && !app.installType.toLowerCase().includes('system')
  );
}
