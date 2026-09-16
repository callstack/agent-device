import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type {
  DeviceLease,
  DeviceRotation,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
} from '@agent-device/contracts/device';
import type { FillBackendResult, Interactor } from '@agent-device/contracts/interactor-types';
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
import { toIosSelector } from './snapshot.ts';
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
    token: options.token,
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

  /**
   * Both taps travel in one `performActions` batch so the inter-tap gap is enforced on the
   * device. Two separate `tap` requests put a network round trip between the taps, which
   * exceeds the double-tap recognition window and registers as two slow single taps.
   */
  async doubleTap(x: number, y: number): Promise<void> {
    await this.session.client.performActions([
      { type: 'tap', x, y },
      { type: 'wait', durationMs: DOUBLE_TAP_INTERVAL_MS },
      { type: 'tap', x, y },
    ]);
  }

  /** One held touch as HID primitives; the hold runs on the device, not across the wire. */
  async longPress(
    x: number,
    y: number,
    durationMs = DEFAULT_LONG_PRESS_DURATION_MS,
  ): Promise<void> {
    await this.session.client.performActions([
      { type: 'touchDown', x, y },
      { type: 'wait', durationMs },
      { type: 'touchUp', x, y },
    ]);
  }

  async focus(x: number, y: number): Promise<void> {
    await this.tap(x, y);
  }

  async type(text: string, delayMs?: number): Promise<void> {
    await this.enterText(text, delayMs);
  }

  async fill(x: number, y: number, text: string, delayMs?: number): Promise<FillBackendResult> {
    // Loaded on the fill path to keep this provider's declared import-time closure budget.
    const { awaitLimrunTextEntryFocus, readLimrunUnambiguousTapTargets, readLimrunTextEntryFocus } =
      await import('./text-entry-focus.ts');
    // Read before the tap: the witness needs to know what was under this point.
    const targetsAtPoint = readLimrunUnambiguousTapTargets(
      await this.session.client.elementTree(),
      x,
      y,
    );
    await this.tap(x, y);
    const textEntryReadiness = await awaitLimrunTextEntryFocus({
      targetsAtPoint,
      readFocus: async () => readLimrunTextEntryFocus(await this.session.client.elementTree()),
      sleep: (milliseconds) => sleep(milliseconds),
      x,
      y,
    });
    // Select first: iOS replaces a selection on the next key, so `fill` replaces and
    // an empty fill clears.
    await this.session.client.pressKey('a', ['command']);
    if (text.length === 0) {
      await this.session.client.pressKey('delete');
      return { textEntryReadiness };
    }
    await this.enterText(text, delayMs);
    return { textEntryReadiness };
  }

  /**
   * Types into whatever holds text-entry focus, character by character when a delay is
   * asked for. Focus targeting belongs to the caller, so the provider's own scan for a
   * globally focused element is skipped: an app can expose fields that take keys without
   * ever reporting one.
   */
  private async enterText(text: string, delayMs?: number): Promise<void> {
    if (delayMs && delayMs > 0) {
      for (const char of Array.from(text)) {
        await this.session.client.typeText(char, false, { requireFocus: false });
        await sleep(delayMs);
      }
      return;
    }
    await this.session.client.typeText(text, false, { requireFocus: false });
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', options?: { pixels?: number }) {
    await this.session.client.scroll(direction, options?.pixels ?? 300);
  }

  /** Limrun serves its capture as JPEG; the PNG-only readers behind `outPath` get a PNG. */
  async screenshot(outPath: string): Promise<void> {
    // Loaded on the screenshot path to keep this provider's declared import-time closure budget.
    const { transcodeScreenshotToPngAsync } =
      await import('@agent-device/capture-kit/png-worker-client');
    const screenshot = await this.session.client.screenshot();
    const png = await transcodeScreenshotToPngAsync(
      Buffer.from(screenshot.base64, 'base64'),
      'Limrun iOS screenshot',
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, png);
  }

  async snapshot() {
    const { captureLimrunIosSnapshot } = await import('./ios-snapshot-adapter.ts');
    return await captureLimrunIosSnapshot(this.session);
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

/** Hold applied when the caller names no duration; matches the Android and Linux interactors. */
const DEFAULT_LONG_PRESS_DURATION_MS = 800;
/** On-device pause between the two taps of a double tap; well inside the recognizer's window. */
const DOUBLE_TAP_INTERVAL_MS = 80;

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
