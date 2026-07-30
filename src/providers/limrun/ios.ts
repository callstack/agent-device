import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Limrun from '@limrun/api';
import {
  createInstanceClient as createIosInstanceClient,
  type InstanceClient as LimrunIosClient,
} from '@limrun/api/ios-client';
import type { DeviceRotation } from '../../contracts/device-rotation.ts';
import { isDeepLinkTarget } from '../../contracts/open-target.ts';
import type {
  Interactor,
  SnapshotOptions,
  SnapshotResult,
} from '../../contracts/interactor-types.ts';
import type { DeviceLease } from '../../contracts/device-provider.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
} from '../../provider-device-runtime.ts';
import { execFailureDetails, runCmd } from '../../utils/exec.ts';
import { sleep } from '../../utils/timeouts.ts';
import { flattenIosTree, toIosSelector, writeBase64File, type IosTreeNode } from './snapshot.ts';
import { normalizeOptionalString } from './strings.ts';

export type LimrunIosSession = {
  platform: 'ios';
  lease: DeviceLease;
  instanceId: string;
  device: DeviceInfo;
  client: LimrunIosClient;
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

export async function createLimrunIosSession(options: {
  lease: DeviceLease;
  instanceId: string;
  device: DeviceInfo;
  apiUrl: string;
  token: string;
}): Promise<LimrunIosSession> {
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
  };
}

export async function installLimrunIosApp(
  limrun: Limrun,
  session: LimrunIosSession,
  installablePath: string,
  options?: ProviderDeviceInstallOptions,
): Promise<ProviderDeviceInstallResult> {
  const prepared = await prepareLimrunIosAsset(installablePath);
  try {
    const asset = await limrun.assets.getOrUpload({
      path: prepared.uploadPath,
      name: prepared.assetName,
    });
    const result = await installLimrunIosRemoteApp(session, asset.signedDownloadUrl, {
      md5: asset.md5,
      relaunch: options?.relaunch,
      appIdentifierHint: options?.appIdentifierHint,
    });
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
): Promise<LimrunIosRemoteInstallResult> {
  const beforeInstallApps = await session.client.listApps().catch(() => undefined);
  const result = await session.client.installApp(url, {
    md5: options?.md5,
    launchMode: options?.relaunch ? 'RelaunchIfRunning' : 'ForegroundIfRunning',
  });
  const resultBundleId = normalizeOptionalString(result.bundleId);
  const requestedBundleId = normalizeOptionalString(options?.appIdentifierHint);
  let afterInstallApps: LimrunIosApp[] = [];
  for (const delayMs of IOS_APP_INVENTORY_RETRY_DELAYS_MS) {
    if (delayMs > 0) await sleep(delayMs);
    afterInstallApps = await session.client.listApps();
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
      await this.session.client.launchApp(await resolveIosTarget(app));
      await this.session.client.openUrl(options.url);
      return;
    }
    if (isDeepLinkTarget(app)) {
      await this.session.client.openUrl(app);
      return;
    }
    await this.session.client.launchApp(await resolveIosTarget(app));
  }

  async openDevice(): Promise<void> {}

  async close(app: string): Promise<void> {
    if (app) await this.session.client.terminateApp(await resolveIosTarget(app)).catch(() => {});
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

  async fillElementSelector(
    selector: { key: 'id' | 'label' | 'text' | 'value'; value: string },
    text: string,
  ): Promise<void> {
    await this.session.client.setElementValue(text, toIosSelector(selector));
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
    return { nodes: flattenIosTree(parsed), backend: 'xctest' };
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

async function prepareLimrunIosAsset(artifactPath: string): Promise<{
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
  const result = await runCmd('zip', ['-qr', zipPath, path.basename(artifactPath)], {
    cwd: path.dirname(artifactPath),
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    throw new AppError('COMMAND_FAILED', 'Failed to package iOS .app for Limrun install', {
      command: ['zip', '-qr', zipPath, path.basename(artifactPath)].join(' '),
      ...execFailureDetails(result),
    });
  }
  return {
    uploadPath: zipPath,
    assetName: path.basename(zipPath),
    appName: await readIosBundleAppName(artifactPath),
    cleanup: async () => {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function resolveIosTarget(app: string): Promise<string> {
  const { resolveIosAppAlias } = await import('../../platforms/apple/core/app-resolution.ts');
  return resolveIosAppAlias(app);
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

async function readIosBundleAppName(appPath: string): Promise<string | undefined> {
  const { readIosBundleInfo } = await import('../../platforms/apple/core/install-artifact.ts');
  return (await readIosBundleInfo(appPath)).appName ?? inferAppNameFromPath(appPath);
}

function unsupported(command: string, message: string): never {
  throw new AppError('UNSUPPORTED_OPERATION', message, { command });
}
