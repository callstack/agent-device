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
import type { DeviceRotation } from '../../contracts/device-rotation.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type {
  Interactor,
  RunnerContext,
  SnapshotOptions,
  SnapshotResult,
} from '../../core/interactor-types.ts';
import { createAndroidInteractor } from '../../core/interactors/android.ts';
import type { DeviceInventoryProvider } from '../../core/dispatch-resolve.ts';
import {
  withAndroidAdbProvider,
  type AndroidAdbExecutorOptions,
  type AndroidAdbExecutorResult,
  type AndroidAdbProvider,
  type AndroidPortReverseEndpoint,
  type AndroidPortReverseProvider,
} from '../../platforms/android/adb-executor.ts';
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
import { flattenIosTree, toIosSelector, writeBase64File, type IosTreeNode } from './snapshot.ts';

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

  getInteractor(device: DeviceInfo, _runnerContext: RunnerContext): Interactor | undefined {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    return session.platform === 'ios'
      ? new LimrunIosInteractor(session)
      : createLimrunAndroidInteractor(session);
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
): Promise<AndroidAdbExecutorResult> {
  const serial = await ensurePersistentAndroidAdbSerial(session);
  const adbArgs = limrunAdbArgs(serial, args);
  const result = await runCmd('adb', adbArgs, limrunAdbRunOptions(options));
  if (result.exitCode !== 0 && options?.allowFailure !== true)
    throw limrunAndroidAdbError(adbArgs, result);
  return result;
}

function limrunAdbArgs(serial: string, args: string[]): string[] {
  return ['-s', serial, ...args];
}

function limrunAdbRunOptions(options: AndroidAdbExecutorOptions | undefined) {
  return {
    allowFailure: options?.allowFailure,
    binaryStdout: options?.binaryStdout,
    stdin: options?.stdin,
    timeoutMs: options?.timeoutMs ?? 30_000,
    signal: options?.signal,
  };
}

function limrunAndroidAdbError(adbArgs: string[], result: AndroidAdbExecutorResult): AppError {
  return new AppError('COMMAND_FAILED', 'Limrun Android ADB command failed', {
    command: ['adb', ...adbArgs].join(' '),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function createLimrunAndroidInteractor(
  session: Extract<LimrunRuntimeSession, { platform: 'android' }>,
): Interactor {
  const base = createAndroidInteractor(session.device);
  const provider = createLimrunAndroidAdbProvider(session);
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        withAndroidAdbProvider(provider, { serial: session.device.id }, async () =>
          value.apply(target, args),
        );
    },
  });
}

function createLimrunAndroidAdbProvider(
  session: Extract<LimrunRuntimeSession, { platform: 'android' }>,
): AndroidAdbProvider {
  return {
    exec: async (args, options) => await runLimrunAndroidAdb(session, args, options),
    reverse: createLimrunAndroidPortReverseProvider(session),
    text: async (request) => {
      await session.client.setText(request.target, request.text);
    },
  };
}

function createLimrunAndroidPortReverseProvider(
  session: Extract<LimrunRuntimeSession, { platform: 'android' }>,
): AndroidPortReverseProvider {
  return {
    async ensure(mapping) {
      await ensureAndroidPortReverse(session, {
        devicePort: tcpEndpointPort(mapping.local),
        hostPort: tcpEndpointPort(mapping.remote),
        name: mapping.ownerId ?? 'android-adb-provider',
      });
    },
    async remove(local) {
      await removeAndroidPortReverse(session, tcpEndpointPort(local));
    },
    async removeAllOwned(ownerId) {
      const ownedPorts = Array.from(session.reversedPorts.entries())
        .filter(([, name]) => name === ownerId)
        .map(([port]) => port);
      for (const port of ownedPorts) {
        await removeAndroidPortReverse(session, port);
      }
    },
  };
}

function tcpEndpointPort(endpoint: AndroidPortReverseEndpoint): number {
  if (!endpoint.startsWith('tcp:')) {
    throw unsupported('port reverse', `Limrun Android only supports tcp reverse endpoints.`);
  }
  const port = Number(endpoint.slice('tcp:'.length));
  if (!Number.isInteger(port) || port <= 0) {
    throw new AppError('INVALID_ARGS', `Invalid Android tcp reverse endpoint: ${endpoint}`);
  }
  return port;
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

function unsupported(command: string, message: string): never {
  throw new AppError('UNSUPPORTED_OPERATION', message, { command });
}
