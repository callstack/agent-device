import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type {
  DeviceLease,
  DeviceRotation,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
} from '@agent-device/contracts/device';
import type {
  Interactor,
  SnapshotOptions,
  SnapshotResult,
} from '@agent-device/contracts/interaction';
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
import { flattenIosTree, toIosSelector, writeBase64File, type IosTreeNode } from './snapshot.ts';
import { normalizeOptionalString } from './strings.ts';
import {
  awaitLimrunDeploymentOperation,
  type LimrunRequestOperationDrain,
} from './request-cancellation.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

export type LimrunIosSession = {
  platform: 'ios';
  lease: DeviceLease;
  instanceId: string;
  device: DeviceInfo;
  client: LimrunIosClient;
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
  return {
    platform: 'ios',
    lease: options.lease,
    instanceId: options.instanceId,
    device: options.device,
    client,
    dependencies,
  };
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
      md5: options?.md5,
      launchMode: options?.relaunch ? 'RelaunchIfRunning' : 'ForegroundIfRunning',
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

export function createLimrunIosInteractor(session: LimrunIosSession): Interactor {
  return new LimrunIosInteractor(session);
}

class LimrunIosInteractor implements Interactor {
  private readonly session: LimrunIosSession;

  constructor(session: LimrunIosSession) {
    this.session = session;
  }

  async open(app: string, options?: { url?: string }): Promise<void> {
    if (options?.url) {
      await this.session.client.launchApp(await this.session.dependencies.ios.resolveAppAlias(app));
      await this.session.client.openUrl(options.url);
      return;
    }
    if (isDeepLinkTarget(app)) {
      await this.session.client.openUrl(app);
      return;
    }
    await this.session.client.launchApp(await this.session.dependencies.ios.resolveAppAlias(app));
  }

  async openDevice(): Promise<void> {}

  async close(app: string): Promise<void> {
    if (app) {
      await this.session.client
        .terminateApp(await this.session.dependencies.ios.resolveAppAlias(app))
        .catch(() => {});
    }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.session.client.tap(x, y);
  }

  async tapElementSelector(selector: {
    key: 'id' | 'label' | 'text' | 'value';
    value: string;
  }): Promise<Record<string, unknown> | void> {
    await this.session.client.tapElement(toIosSelector(selector));
  }

  async doubleTap(x: number, y: number): Promise<void> {
    await this.tap(x, y);
    await this.tap(x, y);
  }

  async longPress(): Promise<never> {
    throw unsupported('longpress', 'Limrun iOS direct sessions do not expose long press yet.');
  }

  async focus(x: number, y: number): Promise<void> {
    await this.tap(x, y);
  }

  async type(text: string, delayMs?: number): Promise<void> {
    if (delayMs && delayMs > 0) {
      for (const char of Array.from(text)) {
        await this.session.client.typeText(char);
        await sleep(delayMs);
      }
      return;
    }
    await this.session.client.typeText(text);
  }

  async fill(x: number, y: number, text: string): Promise<void> {
    await this.tap(x, y);
    await this.session.client.typeText(text);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', options?: { pixels?: number }) {
    await this.session.client.scroll(direction, options?.pixels ?? 300);
  }

  async screenshot(outPath: string): Promise<void> {
    const screenshot = await this.session.client.screenshot();
    await writeBase64File(outPath, screenshot.base64);
  }

  async snapshot(_options?: SnapshotOptions): Promise<SnapshotResult> {
    const treeJson = await this.session.client.elementTree();
    const parsed = JSON.parse(treeJson) as IosTreeNode | IosTreeNode[];
    return { nodes: flattenIosTree(parsed), backend: 'xctest', producer: 'limrun-ios-tree' };
  }

  async back(): Promise<void> {
    await this.session.client.pressKey('escape');
  }

  async home(): Promise<never> {
    throw unsupported('home', 'Limrun iOS direct sessions do not expose home yet.');
  }

  async setOrientation(orientation: DeviceRotation): Promise<void> {
    if (orientation === 'portrait-upside-down') {
      throw unsupported(
        'orientation',
        'Limrun iOS direct sessions support portrait and landscape orientation, not portrait upside-down.',
      );
    }
    await this.session.client.setOrientation(orientation === 'portrait' ? 'Portrait' : 'Landscape');
  }

  async performGesture(): Promise<never> {
    throw unsupported(
      'gesture',
      'Limrun iOS direct sessions do not expose portable gesture execution yet.',
    );
  }

  async appSwitcher(): Promise<never> {
    throw unsupported('app-switcher', 'Limrun iOS direct sessions do not expose app switcher yet.');
  }

  async tvRemote(): Promise<never> {
    throw unsupported('tv-remote', 'Limrun iOS direct sessions do not expose tv remote control.');
  }

  async readAlert(): Promise<never> {
    throw unsupported('alert', LIMRUN_IOS_ALERT_UNSUPPORTED);
  }

  async awaitAlert(): Promise<never> {
    throw unsupported('alert', LIMRUN_IOS_ALERT_UNSUPPORTED);
  }

  async acceptAlert(): Promise<never> {
    throw unsupported('alert', LIMRUN_IOS_ALERT_UNSUPPORTED);
  }

  async dismissAlert(): Promise<never> {
    throw unsupported('alert', LIMRUN_IOS_ALERT_UNSUPPORTED);
  }

  async readClipboard(): Promise<never> {
    throw unsupported('clipboard', 'Limrun iOS direct sessions do not expose clipboard read yet.');
  }

  async writeClipboard(): Promise<never> {
    throw unsupported('clipboard', 'Limrun iOS direct sessions do not expose clipboard write yet.');
  }

  async setSetting(): Promise<never> {
    throw unsupported('settings', 'Limrun iOS direct sessions do not expose settings changes yet.');
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

/** One sentence for all four alert legs: this session has no XCUITest runner to read a sheet. */
const LIMRUN_IOS_ALERT_UNSUPPORTED =
  'Limrun iOS direct sessions do not expose alert inspection yet.';

function unsupported(command: string, message: string): never {
  throw new AppError('UNSUPPORTED_OPERATION', message, { command });
}
