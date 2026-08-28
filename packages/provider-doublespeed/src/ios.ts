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
} from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DoublespeedApiClient } from './api-client.ts';
import type { DoublespeedRuntimeDependencies } from './runtime-dependencies.ts';
import {
  createDoublespeedSessionClient,
  type DoublespeedInstalledApp,
  type DoublespeedSessionClient,
  type DoublespeedSessionScreen,
} from './session-client.ts';
import { flattenDoublespeedTree, toDoublespeedSelector, writeBase64File } from './snapshot.ts';
import { normalizeOptionalString } from './strings.ts';

export type DoublespeedIosSession = {
  lease: DeviceLease;
  simulatorId: string;
  device: DeviceInfo;
  client: DoublespeedSessionClient;
  screen: DoublespeedSessionScreen;
  readonly dependencies: Pick<DoublespeedRuntimeDependencies, 'host' | 'ios'>;
};

export type DoublespeedIosRemoteInstallOptions = {
  sha256?: string;
  relaunch?: boolean;
  appIdentifierHint?: string;
};

export type DoublespeedIosRemoteInstallResult = {
  appId?: string;
};

export function createDoublespeedIosSession(
  options: {
    lease: DeviceLease;
    simulatorId: string;
    device: DeviceInfo;
    apiUrl: string;
    screen: DoublespeedSessionScreen;
    fetch?: typeof fetch;
  },
  dependencies: Pick<DoublespeedRuntimeDependencies, 'host' | 'ios'>,
): DoublespeedIosSession {
  return {
    lease: options.lease,
    simulatorId: options.simulatorId,
    device: options.device,
    client: createDoublespeedSessionClient(options.apiUrl, { fetch: options.fetch }),
    screen: options.screen,
    dependencies,
  };
}

export async function installDoublespeedIosApp(
  api: DoublespeedApiClient,
  session: DoublespeedIosSession,
  installablePath: string,
  options?: ProviderDeviceInstallOptions,
  signal?: AbortSignal,
): Promise<ProviderDeviceInstallResult> {
  signal?.throwIfAborted();
  const prepared = await prepareIosAsset(installablePath, session.dependencies);
  try {
    signal?.throwIfAborted();
    const digest = await fileDigest(prepared.uploadPath);
    const downloadUrl = await publishAsset(api, prepared, digest, signal);
    const result = await installDoublespeedIosRemoteApp(
      session,
      downloadUrl,
      {
        sha256: digest.sha256,
        relaunch: options?.relaunch,
        appIdentifierHint: options?.appIdentifierHint,
      },
      signal,
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

async function publishAsset(
  api: DoublespeedApiClient,
  prepared: { uploadPath: string; assetName: string },
  digest: { sha256: string; size: number },
  signal?: AbortSignal,
): Promise<string> {
  let asset = await api.registerAsset({ ...digest, name: prepared.assetName }, signal);
  if (!asset.exists) {
    if (!asset.upload_url) {
      throw new AppError(
        'COMMAND_FAILED',
        'Doublespeed asset registration returned no upload URL.',
      );
    }
    await api.uploadAsset(asset.upload_url, prepared.uploadPath, signal);
    asset = await api.completeAsset(digest.sha256, digest.size, signal);
  }
  if (!asset.download_url) {
    throw new AppError(
      'COMMAND_FAILED',
      'Doublespeed asset registration returned no download URL.',
    );
  }
  return asset.download_url;
}

export async function installDoublespeedIosRemoteApp(
  session: DoublespeedIosSession,
  url: string,
  options?: DoublespeedIosRemoteInstallOptions,
  signal?: AbortSignal,
): Promise<DoublespeedIosRemoteInstallResult> {
  signal?.throwIfAborted();
  const beforeInstallApps = await session.client.listApps(signal).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    return undefined;
  });
  const result = await session.client.installApp(
    {
      url,
      sha256: options?.sha256,
      launchMode: options?.relaunch ? 'RelaunchIfRunning' : 'ForegroundIfRunning',
    },
    signal,
  );
  const resultBundleId = normalizeOptionalString(result.bundleId);
  const requestedBundleId = normalizeOptionalString(options?.appIdentifierHint);
  let afterInstallApps: DoublespeedInstalledApp[] = [];
  for (const delayMs of IOS_APP_INVENTORY_RETRY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs, undefined, { signal });
    afterInstallApps = await session.client.listApps(signal);
    const verifiedBundleId = resolveInstalledIosAppId({
      resultBundleId,
      requestedBundleId,
      beforeInstallApps,
      afterInstallApps,
    });
    if (verifiedBundleId) return { appId: verifiedBundleId };
  }
  throw new AppError('COMMAND_FAILED', 'Doublespeed iOS app installation could not be verified.', {
    resultBundleId,
    requestedBundleId,
    installedUserApps: afterInstallApps
      .filter(isUserInstalledIosApp)
      .map((app) => app.bundleId)
      .sort(),
  });
}

export function createDoublespeedIosInteractor(session: DoublespeedIosSession): Interactor {
  return new DoublespeedIosInteractor(session);
}

class DoublespeedIosInteractor implements Interactor {
  private readonly session: DoublespeedIosSession;

  constructor(session: DoublespeedIosSession) {
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
    await this.session.client.tapElement(toDoublespeedSelector(selector));
  }

  async doubleTap(x: number, y: number): Promise<void> {
    await this.tap(x, y);
    await this.tap(x, y);
  }

  async longPress(x: number, y: number, durationMs?: number): Promise<void> {
    await this.session.client.longPress(x, y, durationMs);
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
    const tree = await this.session.client.elementTree();
    return {
      nodes: flattenDoublespeedTree(tree),
      backend: 'xctest',
      producer: 'doublespeed-ios-tree',
    };
  }

  async back(): Promise<never> {
    throw unsupported('back', DOUBLESPEED_IOS_BACK_UNSUPPORTED);
  }

  async home(): Promise<void> {
    await this.session.client.pressKey('home');
  }

  async setOrientation(orientation: DeviceRotation): Promise<void> {
    if (orientation === 'portrait-upside-down') {
      throw unsupported(
        'orientation',
        'Doublespeed iOS sessions support portrait and landscape orientation, not portrait upside-down.',
      );
    }
    await this.session.client.setOrientation(orientation === 'portrait' ? 'portrait' : 'landscape');
  }

  async performGesture(): Promise<never> {
    throw unsupported('gesture', DOUBLESPEED_IOS_GESTURE_UNSUPPORTED);
  }

  async appSwitcher(): Promise<never> {
    throw unsupported('app-switcher', 'Doublespeed iOS sessions do not expose app switcher yet.');
  }

  async tvRemote(): Promise<never> {
    throw unsupported('tv-remote', 'Doublespeed iOS sessions do not expose tv remote control.');
  }

  async readAlert(): Promise<never> {
    throw unsupported('alert', DOUBLESPEED_IOS_ALERT_UNSUPPORTED);
  }

  async awaitAlert(): Promise<never> {
    throw unsupported('alert', DOUBLESPEED_IOS_ALERT_UNSUPPORTED);
  }

  async acceptAlert(): Promise<never> {
    throw unsupported('alert', DOUBLESPEED_IOS_ALERT_UNSUPPORTED);
  }

  async dismissAlert(): Promise<never> {
    throw unsupported('alert', DOUBLESPEED_IOS_ALERT_UNSUPPORTED);
  }

  async readClipboard(): Promise<never> {
    throw unsupported('clipboard', 'Doublespeed iOS sessions do not expose clipboard read yet.');
  }

  async writeClipboard(): Promise<never> {
    throw unsupported('clipboard', 'Doublespeed iOS sessions do not expose clipboard write yet.');
  }

  async setSetting(): Promise<never> {
    throw unsupported('settings', 'Doublespeed iOS sessions do not expose settings changes yet.');
  }
}

async function prepareIosAsset(
  artifactPath: string,
  dependencies: Pick<DoublespeedRuntimeDependencies, 'host' | 'ios'>,
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

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-doublespeed-ios-app-'),
  );
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

async function fileDigest(filePath: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

function inferAppNameFromPath(appPath: string): string | undefined {
  const base = path.basename(appPath).replace(/\.(?:app|ipa|zip)$/i, '');
  return base || undefined;
}

const IOS_APP_INVENTORY_RETRY_DELAYS_MS = [0, 250] as const;

function resolveInstalledIosAppId(params: {
  resultBundleId?: string;
  requestedBundleId?: string;
  beforeInstallApps: DoublespeedInstalledApp[] | undefined;
  afterInstallApps: DoublespeedInstalledApp[];
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
  beforeInstallApps: DoublespeedInstalledApp[] | undefined,
  afterInstallApps: DoublespeedInstalledApp[],
): string | undefined {
  if (!beforeInstallApps) return undefined;
  const beforeBundleIds = new Set(beforeInstallApps.map((app) => app.bundleId));
  const candidates = afterInstallApps.filter(
    (app) => isUserInstalledIosApp(app) && !beforeBundleIds.has(app.bundleId),
  );
  return candidates.length === 1 ? candidates[0]?.bundleId : undefined;
}

export function isUserInstalledIosApp(app: DoublespeedInstalledApp): boolean {
  return (
    !app.bundleId.startsWith('com.apple.') &&
    !app.bundleId.startsWith('com.facebook.WebDriverAgentRunner') &&
    !app.installType.toLowerCase().includes('system')
  );
}

export const DOUBLESPEED_IOS_BACK_UNSUPPORTED =
  'Doublespeed iOS sessions do not expose back navigation yet.';
export const DOUBLESPEED_IOS_GESTURE_UNSUPPORTED =
  'Doublespeed iOS sessions do not expose portable gesture execution yet.';
/** One sentence for all four alert legs: the session API exposes no alert inspection. */
export const DOUBLESPEED_IOS_ALERT_UNSUPPORTED =
  'Doublespeed iOS sessions do not expose alert inspection yet.';

function unsupported(command: string, message: string): never {
  throw new AppError('UNSUPPORTED_OPERATION', message, { command });
}
