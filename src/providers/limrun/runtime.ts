import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Limrun from '@limrun/api';
import {
  createInstanceClient as createAndroidInstanceClient,
  type InstanceClient as LimrunAndroidClient,
} from '@limrun/api/instance-client';
import {
  createInstanceClient as createIosInstanceClient,
  type InstanceClient as LimrunIosClient,
} from '@limrun/api/ios-client';
import { AppError } from '../../kernel/errors.ts';
import { runCmd } from '../../utils/exec.ts';
import { readVersion } from '../../utils/version.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { Interactor, SnapshotOptions, SnapshotResult } from '../../core/interactor-types.ts';
import type { DeviceInventoryProvider } from '../../core/dispatch-resolve.ts';
import type { AndroidAdbExecutorOptions } from '../../platforms/android/adb-executor.ts';
import type { LeaseLifecycleProvider } from '../../daemon/handlers/lease.ts';
import type { DeviceLease } from '../../daemon/lease-registry.ts';
import type {
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
} from '../../provider-device-runtime.ts';
import {
  buildLimrunDevice,
  LIMRUN_PROVIDER,
  parseLimrunDeviceId,
  platformForLimrunLeaseBackend,
  readLimrunLeaseIdFromInventoryRequest,
} from './device.ts';
import {
  flattenIosTree,
  mapAndroidNode,
  toAndroidSelector,
  toIosSelector,
  writeBase64File,
  writeDataUriFile,
  type IosTreeNode,
} from './snapshot.ts';

type LimrunAdbTunnel = Awaited<ReturnType<LimrunAndroidClient['startAdbTunnel']>>;

type LimrunInstance = {
  metadata: { id: string };
  status: {
    token: string;
    apiUrl?: string;
    adbWebSocketUrl?: string;
    state?: string;
  };
};

type LimrunRuntimeSession =
  | {
      platform: 'ios';
      lease: DeviceLease;
      instanceId: string;
      device: DeviceInfo;
      client: LimrunIosClient;
    }
  | {
      platform: 'android';
      lease: DeviceLease;
      instanceId: string;
      device: DeviceInfo;
      client: LimrunAndroidClient;
      adbTunnel?: LimrunAdbTunnel;
      adbSerial?: string;
      reversedPorts: Map<number, string>;
    };

type LimrunRuntimeOptions = {
  apiKey: string;
  region?: string;
  version?: string;
};

const LIMRUN_CLIENT_HEADER = 'agent-device-cli';
const SETTINGS_INTENT = 'android.settings.SETTINGS';

export function createLimrunRuntimeFromEnv(env: NodeJS.ProcessEnv): LimrunRuntime | undefined {
  const apiKey = env.LIMRUN_API_KEY?.trim() || env.LIM_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new LimrunRuntime({
    apiKey,
    region: env.LIMRUN_REGION?.trim() || env.LIM_REGION?.trim() || undefined,
    version: readVersion(),
  });
}

export class LimrunRuntime implements ProviderDeviceRuntime {
  private readonly limrun: Limrun;
  private readonly sessions = new Map<string, LimrunRuntimeSession>();
  private readonly options: LimrunRuntimeOptions;
  readonly provider = LIMRUN_PROVIDER;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease) => await this.allocate(lease),
    release: async (lease) => await this.release(lease.leaseId),
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider) return null;
    const leaseId = readLimrunLeaseIdFromInventoryRequest(request);
    if (!leaseId) return null;
    const session = this.sessions.get(leaseId);
    if (!session) return null;
    if (request.platform && request.platform !== session.platform) return [];
    return [session.device];
  };

  constructor(options: LimrunRuntimeOptions) {
    this.options = options;
    this.limrun = new Limrun({
      apiKey: options.apiKey,
      defaultHeaders: {
        'x-agent-device-client': LIMRUN_CLIENT_HEADER,
        'x-agent-device-version': options.version ?? readVersion(),
      },
    });
  }

  ownsDevice(device: DeviceInfo): boolean {
    return parseLimrunDeviceId(device.id) !== undefined;
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    return session.platform === 'ios'
      ? new LimrunIosInteractor(session)
      : new LimrunAndroidInteractor(session);
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.installInstallablePath(device, appPath, {
      ...options,
      appIdentifierHint: options?.appIdentifierHint ?? app,
      packageNameHint: options?.packageNameHint ?? app,
    });
  }

  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    return session.platform === 'ios'
      ? await installLimrunIosApp(this.limrun, session, installablePath, options)
      : await installLimrunAndroidApp(this.limrun, session, installablePath, options);
  }

  async configurePortReverse(options: {
    leaseId: string;
    devicePort: number;
    hostPort: number;
    name: string;
  }): Promise<Record<string, unknown> | undefined> {
    const session = this.getAndroidPortReverseSession(options.leaseId, { throwOnIos: true });
    if (!session) return undefined;
    await ensureAndroidPortReverse(session, options);
    return portReverseResult(options);
  }

  async removePortReverse(options: {
    leaseId: string;
    devicePort: number;
    hostPort: number;
    name: string;
  }): Promise<Record<string, unknown> | undefined> {
    const session = this.getAndroidPortReverseSession(options.leaseId);
    if (!session) return undefined;
    await removeAndroidPortReverse(session, options.devicePort);
    return portReverseResult(options);
  }

  async shutdown(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    await Promise.allSettled(sessions.map((session) => this.terminateSession(session)));
    this.sessions.clear();
  }

  private async allocate(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const platform = platformForLimrunLeaseBackend(lease.backend);
    if (!platform) return undefined;
    const existing = this.sessions.get(lease.leaseId);
    if (existing) {
      return { limrunInstanceId: existing.instanceId, device: existing.device };
    }

    const session =
      platform === 'ios'
        ? await this.createIosSession(lease)
        : await this.createAndroidSession(lease);
    this.sessions.set(lease.leaseId, session);
    return { limrunInstanceId: session.instanceId, device: session.device };
  }

  private async createIosSession(lease: DeviceLease): Promise<LimrunRuntimeSession> {
    const instance = (await this.limrun.iosInstances.create({
      wait: true,
      metadata: this.buildInstanceMetadata(lease),
      spec: this.options.region ? { region: this.options.region } : {},
    })) as LimrunInstance;
    try {
      if (!instance.status.apiUrl) {
        throw new AppError('COMMAND_FAILED', 'Limrun iOS instance did not expose apiUrl');
      }
      const client = await createIosInstanceClient({
        apiUrl: instance.status.apiUrl,
        token: instance.status.token,
        logLevel: 'warn',
      });
      return {
        platform: 'ios',
        lease,
        instanceId: instance.metadata.id,
        device: buildLimrunDevice('ios', lease, instance.metadata.id),
        client,
      };
    } catch (error) {
      await this.limrun.iosInstances.delete(instance.metadata.id).catch(() => {});
      throw error;
    }
  }

  private async createAndroidSession(lease: DeviceLease): Promise<LimrunRuntimeSession> {
    const instance = (await this.limrun.androidInstances.create({
      wait: true,
      metadata: this.buildInstanceMetadata(lease),
      spec: this.options.region ? { region: this.options.region } : {},
    })) as LimrunInstance;
    try {
      if (!instance.status.apiUrl || !instance.status.adbWebSocketUrl) {
        throw new AppError(
          'COMMAND_FAILED',
          'Limrun Android instance did not expose API and ADB websocket endpoints',
        );
      }
      const client = await createAndroidInstanceClient({
        apiUrl: instance.status.apiUrl,
        adbUrl: instance.status.adbWebSocketUrl,
        token: instance.status.token,
        logLevel: 'warn',
      });
      return {
        platform: 'android',
        lease,
        instanceId: instance.metadata.id,
        device: buildLimrunDevice('android', lease, instance.metadata.id),
        client,
        reversedPorts: new Map(),
      };
    } catch (error) {
      await this.limrun.androidInstances.delete(instance.metadata.id).catch(() => {});
      throw error;
    }
  }

  private buildInstanceMetadata(lease: DeviceLease) {
    return {
      displayName: `agent-device-${lease.tenantId}-${lease.runId}`,
      labels: {
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseId: lease.leaseId,
        provider: lease.leaseProvider ?? LIMRUN_PROVIDER,
        source: LIMRUN_CLIENT_HEADER,
      },
    };
  }

  private async release(leaseId: string): Promise<Record<string, unknown> | undefined> {
    const session = this.sessions.get(leaseId);
    if (!session) return undefined;
    await this.terminateSession(session);
    this.sessions.delete(leaseId);
    return { limrunInstanceId: session.instanceId };
  }

  private async terminateSession(session: LimrunRuntimeSession): Promise<void> {
    session.client.disconnect();
    if (session.platform === 'ios') {
      await this.limrun.iosInstances.delete(session.instanceId);
      return;
    }
    await cleanupAndroidAdbTunnel(session);
    await this.limrun.androidInstances.delete(session.instanceId);
  }

  private getSessionForDevice(device: DeviceInfo): LimrunRuntimeSession | undefined {
    const parsed = parseLimrunDeviceId(device.id);
    if (!parsed) return undefined;
    const session = this.sessions.get(parsed.leaseId);
    if (!session || session.platform !== parsed.platform) return undefined;
    return session;
  }

  private getAndroidPortReverseSession(
    leaseId: string,
    options: { throwOnIos?: boolean } = {},
  ): Extract<LimrunRuntimeSession, { platform: 'android' }> | undefined {
    const session = this.sessions.get(leaseId);
    if (!session) return undefined;
    if (session.platform === 'android') return session;
    if (options.throwOnIos) {
      throw unsupported(
        'port reverse',
        'Direct Limrun iOS sessions cannot reach local host ports; use a bridge public URL.',
      );
    }
    return undefined;
  }
}

function portReverseResult(options: {
  leaseId: string;
  devicePort: number;
  hostPort: number;
  name: string;
}): Record<string, unknown> {
  return {
    leaseId: options.leaseId,
    devicePort: options.devicePort,
    hostPort: options.hostPort,
    name: options.name,
  };
}

async function installLimrunIosApp(
  limrun: Limrun,
  session: Extract<LimrunRuntimeSession, { platform: 'ios' }>,
  installablePath: string,
  options?: ProviderDeviceInstallOptions,
): Promise<ProviderDeviceInstallResult> {
  const prepared = await prepareLimrunIosAsset(installablePath);
  try {
    const asset = await limrun.assets.getOrUpload({
      path: prepared.uploadPath,
      name: prepared.assetName,
    });
    const result = await session.client.installApp(asset.signedDownloadUrl, {
      md5: asset.md5,
      launchMode: options?.relaunch ? 'RelaunchIfRunning' : 'ForegroundIfRunning',
    });
    const bundleId = normalizeOptionalString(result.bundleId) ?? options?.appIdentifierHint;
    return {
      ...(bundleId ? { bundleId, launchTarget: bundleId } : {}),
      appName: inferAppNameFromPath(installablePath),
    };
  } finally {
    await prepared.cleanup();
  }
}

async function installLimrunAndroidApp(
  limrun: Limrun,
  session: Extract<LimrunRuntimeSession, { platform: 'android' }>,
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
  return {
    ...(packageName ? { packageName, launchTarget: packageName } : {}),
    ...(packageName ? { appName: inferAndroidAppName(packageName) } : {}),
  };
}

async function prepareLimrunIosAsset(artifactPath: string): Promise<{
  uploadPath: string;
  assetName: string;
  cleanup: () => Promise<void>;
}> {
  const stat = await fs.promises.stat(artifactPath);
  if (!stat.isDirectory()) {
    return {
      uploadPath: artifactPath,
      assetName: path.basename(artifactPath),
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
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return {
    uploadPath: zipPath,
    assetName: path.basename(zipPath),
    cleanup: async () => {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function runLimrunAndroidAdb(
  session: Extract<LimrunRuntimeSession, { platform: 'android' }>,
  args: string[],
  options?: AndroidAdbExecutorOptions,
): Promise<void> {
  const serial = await ensurePersistentAndroidAdbSerial(session);
  const result = await runCmd('adb', ['-s', serial, ...args], {
    allowFailure: options?.allowFailure,
    timeoutMs: options?.timeoutMs ?? 30_000,
    signal: options?.signal,
  });
  if (result.exitCode !== 0 && options?.allowFailure !== true) {
    throw new AppError('COMMAND_FAILED', 'Limrun Android ADB command failed', {
      command: ['adb', '-s', serial, ...args].join(' '),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
}

class LimrunIosInteractor implements Interactor {
  private readonly session: Extract<LimrunRuntimeSession, { platform: 'ios' }>;

  constructor(session: Extract<LimrunRuntimeSession, { platform: 'ios' }>) {
    this.session = session;
  }

  async open(app: string, options?: { url?: string }): Promise<void> {
    if (options?.url) {
      await this.session.client.launchApp(app);
      await this.session.client.openUrl(options.url);
      return;
    }
    if (looksLikeUrl(app)) {
      await this.session.client.openUrl(app);
      return;
    }
    await this.session.client.launchApp(resolveIosTarget(app));
  }

  async openDevice(): Promise<void> {}

  async close(app: string): Promise<void> {
    if (app) await this.session.client.terminateApp(resolveIosTarget(app)).catch(() => {});
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

  async swipe(): Promise<never> {
    throw unsupported('swipe', 'Limrun iOS direct sessions do not expose swipe yet.');
  }

  async pan(): Promise<never> {
    throw unsupported('pan', 'Limrun iOS direct sessions do not expose pan yet.');
  }

  async fling(): Promise<never> {
    throw unsupported('fling', 'Limrun iOS direct sessions do not expose fling yet.');
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
        await new Promise((resolve) => setTimeout(resolve, delayMs));
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

  async pinch(): Promise<never> {
    throw unsupported('pinch', 'Limrun iOS direct sessions do not expose multi-touch pinch yet.');
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

  async rotate(orientation: 'portrait' | 'landscape-left' | 'landscape-right'): Promise<void> {
    await this.session.client.setOrientation(orientation === 'portrait' ? 'Portrait' : 'Landscape');
  }

  async rotateGesture(): Promise<never> {
    throw unsupported('rotate', 'Limrun iOS direct sessions do not expose rotate gestures yet.');
  }

  async transformGesture(): Promise<never> {
    throw unsupported(
      'transform',
      'Limrun iOS direct sessions do not expose transform gestures yet.',
    );
  }

  async appSwitcher(): Promise<never> {
    throw unsupported('app-switcher', 'Limrun iOS direct sessions do not expose app switcher yet.');
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

class LimrunAndroidInteractor implements Interactor {
  private readonly session: Extract<LimrunRuntimeSession, { platform: 'android' }>;

  constructor(session: Extract<LimrunRuntimeSession, { platform: 'android' }>) {
    this.session = session;
  }

  async open(app: string, options?: { url?: string }): Promise<void> {
    if (options?.url) {
      await this.ensureReverseForUrl(options.url, 'launch-url');
      await this.runAdb([
        'shell',
        'monkey',
        '-p',
        app,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ]);
      await this.session.client.openUrl(options.url);
      return;
    }
    if (looksLikeUrl(app)) {
      await this.ensureReverseForUrl(app, 'open-url');
      await this.session.client.openUrl(app);
      return;
    }
    if (isAndroidSettingsTarget(app)) {
      await this.runAdb(['shell', 'am', 'start', '-W', '-a', SETTINGS_INTENT]);
      return;
    }
    await this.runAdb([
      'shell',
      'monkey',
      '-p',
      app,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);
  }

  async openDevice(): Promise<void> {}

  async close(app: string): Promise<void> {
    if (app) await this.runAdb(['shell', 'am', 'force-stop', app], { allowFailure: true });
  }

  async tap(x: number, y: number): Promise<void> {
    await this.session.client.tap({ x, y });
  }

  async tapElementSelector(selector: {
    key: 'id' | 'label' | 'text' | 'value';
    value: string;
  }): Promise<void> {
    await this.session.client.tap({ selector: toAndroidSelector(selector) });
  }

  async doubleTap(x: number, y: number): Promise<void> {
    await this.tap(x, y);
    await this.tap(x, y);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number) {
    await this.runAdb([
      'shell',
      'input',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(durationMs ?? 300),
    ]);
  }

  async pan(x1: number, y1: number, x2: number, y2: number, durationMs?: number) {
    await this.swipe(x1, y1, x2, y2, durationMs);
  }

  async fling(x1: number, y1: number, x2: number, y2: number, durationMs?: number) {
    await this.swipe(x1, y1, x2, y2, durationMs);
  }

  async longPress(x: number, y: number, durationMs?: number) {
    await this.swipe(x, y, x, y, durationMs ?? 800);
  }

  async focus(x: number, y: number): Promise<void> {
    await this.tap(x, y);
  }

  async type(text: string): Promise<void> {
    await this.session.client.setText(undefined, text);
  }

  async fill(x: number, y: number, text: string): Promise<void> {
    await this.session.client.setText({ x, y }, text);
  }

  async fillElementSelector(
    selector: { key: 'id' | 'label' | 'text' | 'value'; value: string },
    text: string,
  ): Promise<void> {
    await this.session.client.setText({ selector: toAndroidSelector(selector) }, text);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', options?: { pixels?: number }) {
    await this.session.client.scrollScreen(direction, options?.pixels);
  }

  async pinch(): Promise<never> {
    throw unsupported('pinch', 'Limrun Android direct sessions do not expose pinch yet.');
  }

  async screenshot(outPath: string): Promise<void> {
    const screenshot = await this.session.client.screenshot();
    await writeDataUriFile(outPath, screenshot.dataUri);
  }

  async snapshot(): Promise<SnapshotResult> {
    const tree = await this.session.client.getElementTree();
    return {
      nodes: tree.nodes.map(mapAndroidNode),
      ...readOptionalTruncation(tree),
      backend: 'android',
    };
  }

  async back(): Promise<void> {
    await this.session.client.pressKey('BACK');
  }

  async home(): Promise<void> {
    await this.session.client.pressKey('HOME');
  }

  async rotate(): Promise<never> {
    throw unsupported('rotate', 'Limrun Android direct sessions do not expose rotate yet.');
  }

  async rotateGesture(): Promise<never> {
    throw unsupported(
      'rotate',
      'Limrun Android direct sessions do not expose rotate gestures yet.',
    );
  }

  async transformGesture(): Promise<never> {
    throw unsupported(
      'transform',
      'Limrun Android direct sessions do not expose transform gestures yet.',
    );
  }

  async appSwitcher(): Promise<void> {
    await this.session.client.pressKey('APP_SWITCH');
  }

  async readClipboard(): Promise<never> {
    throw unsupported(
      'clipboard',
      'Limrun Android direct sessions do not expose clipboard read yet.',
    );
  }

  async writeClipboard(): Promise<never> {
    throw unsupported(
      'clipboard',
      'Limrun Android direct sessions do not expose clipboard write yet.',
    );
  }

  async setSetting(): Promise<never> {
    throw unsupported(
      'settings',
      'Limrun Android direct sessions do not expose settings changes yet.',
    );
  }

  private async runAdb(args: string[], options?: AndroidAdbExecutorOptions): Promise<void> {
    await runLimrunAndroidAdb(this.session, args, options);
  }

  private async ensureReverseForUrl(url: string, name: string): Promise<void> {
    const port = readLocalhostUrlPort(url);
    if (!port) return;
    await ensureAndroidPortReverse(this.session, {
      devicePort: port,
      hostPort: port,
      name,
    });
  }
}

async function ensureAndroidPortReverse(
  session: Extract<LimrunRuntimeSession, { platform: 'android' }>,
  options: {
    devicePort: number;
    hostPort: number;
    name: string;
  },
): Promise<void> {
  const existing = session.reversedPorts.get(options.devicePort);
  if (existing === options.name) return;
  if (existing && existing !== options.name) {
    throw new AppError('INVALID_ARGS', `Limrun Android port reverse already exists`, {
      devicePort: options.devicePort,
      existingName: existing,
      requestedName: options.name,
    });
  }
  const serial = await ensurePersistentAndroidAdbSerial(session);
  const result = await runCmd(
    'adb',
    ['-s', serial, 'reverse', `tcp:${options.devicePort}`, `tcp:${options.hostPort}`],
    {
      timeoutMs: 30_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'Limrun Android ADB reverse failed', {
      command: [
        'adb',
        '-s',
        serial,
        'reverse',
        `tcp:${options.devicePort}`,
        `tcp:${options.hostPort}`,
      ].join(' '),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  session.reversedPorts.set(options.devicePort, options.name);
}

async function removeAndroidPortReverse(
  session: Extract<LimrunRuntimeSession, { platform: 'android' }>,
  devicePort: number,
): Promise<void> {
  if (!session.reversedPorts.has(devicePort)) return;
  const serial = await ensurePersistentAndroidAdbSerial(session);
  await runCmd('adb', ['-s', serial, 'reverse', '--remove', `tcp:${devicePort}`], {
    allowFailure: true,
    timeoutMs: 10_000,
  }).catch(() => {});
  session.reversedPorts.delete(devicePort);
}

function readOptionalTruncation(value: unknown): Pick<SnapshotResult, 'truncated'> {
  const truncated =
    value && typeof value === 'object' && 'truncated' in value
      ? (value as { truncated?: unknown }).truncated
      : undefined;
  return typeof truncated === 'boolean' ? { truncated } : {};
}

async function ensurePersistentAndroidAdbSerial(
  session: Extract<LimrunRuntimeSession, { platform: 'android' }>,
): Promise<string> {
  if (session.adbTunnel && session.adbSerial) return session.adbSerial;
  const tunnel = await session.client.startAdbTunnel();
  const serial = `${tunnel.address.address}:${tunnel.address.port}`;
  session.adbTunnel = tunnel;
  session.adbSerial = serial;
  return serial;
}

async function cleanupAndroidAdbTunnel(
  session: Extract<LimrunRuntimeSession, { platform: 'android' }>,
): Promise<void> {
  const serial = session.adbSerial;
  if (serial) {
    await Promise.allSettled(
      Array.from(session.reversedPorts.keys()).map((port) =>
        runCmd('adb', ['-s', serial, 'reverse', '--remove', `tcp:${port}`], {
          allowFailure: true,
          timeoutMs: 10_000,
        }),
      ),
    );
    await runCmd('adb', ['disconnect', serial], {
      allowFailure: true,
      timeoutMs: 10_000,
    }).catch(() => {});
  }
  session.reversedPorts.clear();
  session.adbTunnel?.close();
  session.adbTunnel = undefined;
  session.adbSerial = undefined;
}

function resolveIosTarget(app: string): string {
  const normalized = app.trim().toLowerCase();
  if (normalized === 'settings') return 'com.apple.Preferences';
  return app;
}

function isAndroidSettingsTarget(app: string): boolean {
  const normalized = app.trim().toLowerCase();
  return normalized === 'settings' || normalized === 'com.android.settings';
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function inferAppNameFromPath(appPath: string): string | undefined {
  const base = path.basename(appPath).replace(/\.(?:app|ipa|apk|aab|zip)$/i, '');
  return base || undefined;
}

function inferAndroidAppName(packageName: string): string | undefined {
  const segments = packageName.split('.').filter(Boolean);
  const last = segments.at(-1);
  return last ? last.replace(/[_-]+/g, ' ') : undefined;
}

function buildAndroidAssetName(packageName: string | undefined, artifactPath: string): string {
  const extension = path.extname(artifactPath) || '.apk';
  const prefix = packageName?.replace(/[^a-zA-Z0-9_.-]+/g, '-') || 'android-app';
  return `${prefix}${extension}`;
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value.trim());
}

export function readLocalhostUrlPort(value: string): number | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname !== 'localhost' &&
    hostname !== '127.0.0.1' &&
    hostname !== '::1' &&
    hostname !== '[::1]'
  ) {
    return undefined;
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return port;
}

function unsupported(command: string, message: string): never {
  throw new AppError('UNSUPPORTED_OPERATION', message, { command });
}
