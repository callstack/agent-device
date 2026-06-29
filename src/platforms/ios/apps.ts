import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { AppsFilter } from '../../contracts/app-inventory.ts';
import {
  LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE,
  LAUNCH_CONSOLE_IOS_SIMULATOR_ONLY_MESSAGE,
} from '../../core/launch-console.ts';
import { requireLocationCoordinates } from '../../utils/location-coordinates.ts';
import { resolveIosSimulatorDeviceSetPath } from '../../utils/device-isolation.ts';
import { Deadline, retryWithPolicy } from '../../utils/retry.ts';
import {
  isDeepLinkTarget,
  isWebUrl,
  resolveIosDeviceDeepLinkBundleId,
} from '../../core/open-target.ts';
import { getUnsupportedMacOsSettingMessage } from '../../core/settings-contract.ts';
import {
  parsePermissionAction,
  parsePermissionTarget,
  type SettingOptions,
} from '../permission-utils.ts';
import { parseAppearanceAction } from '../appearance.ts';
import { parseSettingState } from '../setting-state.ts';
import { createAppResolutionCache, type AppResolutionCacheScope } from '../app-resolution-cache.ts';
import {
  summarizeCommandAttemptFailures,
  type CommandAttemptFailure,
} from '../command-attempts.ts';

import {
  IOS_APP_LAUNCH_TIMEOUT_MS,
  IOS_DEVICECTL_TIMEOUT_MS,
  IOS_SIMULATOR_TERMINATE_TIMEOUT_MS,
} from './config.ts';
import {
  IOS_DEVICECTL_DEFAULT_HINT,
  listIosDeviceApps,
  resolveIosDevicectlHint,
  runIosDevicectl,
} from './devicectl.ts';
import type { IosAppInfo } from './app-info.ts';
import {
  isSimulatorLaunchFBSError,
  probeSimulatorLaunchContext,
  classifyLaunchFailure,
  launchFailureHint,
} from './launch-diagnostics.ts';
import { ensureBootedSimulator, getSimulatorState, requireSimulatorDevice } from './simulator.ts';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { runAppleToolCommand, runXcrun } from './tool-provider.ts';
import { prepareIosInstallArtifact } from './install-artifact.ts';
import { filterAppleAppsByBundlePrefix } from './app-filter.ts';
import {
  closeMacOsApp,
  listMacApps,
  openMacOsApp,
  readMacOsClipboardText,
  resolveMacOsApp,
  setMacOsAppearance,
  writeMacOsClipboardText,
} from './macos-apps.ts';
import { runMacOsPermissionAction, type MacOsPermissionTarget } from './macos-helper.ts';
import {
  invalidateSimulatorStatusBarOverrideCache,
  rememberClearedStatusBarOverrides,
} from './screenshot-status-bar.ts';
export {
  screenshotIos,
  shouldFallbackToRunnerForIosScreenshot,
  shouldRetryIosSimulatorScreenshot,
} from './screenshot.ts';

const ALIASES: Record<string, string> = {
  settings: 'com.apple.Preferences',
};
const IOS_SIMULATOR_CONSOLE_CAPTURE_MS = 25_000;
const AGENT_DEVICE_RUNNER_BUNDLE_PREFIX = 'com.callstack.agentdevice.runner';
const IOS_SIMULATOR_LAUNCH_ARGS_WITH_URL_MESSAGE =
  '--launch-args is not supported with iOS simulator URL opens (simctl openurl ignores launch args). Launch the app first with --launch-args, then issue the URL open in a separate call.';

const iosAppResolutionCache = createAppResolutionCache<string>();
let cachedSimctlPrivacyServices: Set<string> | null = null;
let cachedSimctlPrivacyServicesCacheKey: string | undefined;

function iosAppResolutionScope(device: DeviceInfo): AppResolutionCacheScope {
  return { platform: 'ios', deviceId: device.id, variant: device.kind };
}

function simctlArgs(device: DeviceInfo, args: string[]): string[] {
  return buildSimctlArgsForDevice(device, args);
}

function runSimctl(device: DeviceInfo, args: string[], options?: Parameters<typeof runXcrun>[1]) {
  return runXcrun(simctlArgs(device, args), options);
}

function isMissingAppErrorOutput(output: string): boolean {
  return (
    output.includes('not installed') ||
    output.includes('not found') ||
    output.includes('no such file')
  );
}

type InstallIosAppOptions = {
  appIdentifierHint?: string;
};

export async function resolveIosApp(device: DeviceInfo, app: string): Promise<string> {
  if (device.platform === 'macos') {
    return await resolveMacOsApp(app);
  }
  const trimmed = app.trim();
  if (trimmed.includes('.')) return trimmed;

  const alias = ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  const cacheScope = iosAppResolutionScope(device);
  const cached = iosAppResolutionCache.get(cacheScope, trimmed);
  if (cached) return cached;

  const list =
    device.kind === 'simulator'
      ? await listSimulatorApps(device)
      : await listIosDeviceApps(device, 'all');
  const matches = list.filter((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
  const match = matches[0];
  if (match !== undefined && matches.length === 1) {
    return iosAppResolutionCache.set(cacheScope, trimmed, match.bundleId);
  }
  if (matches.length > 1) {
    throw new AppError('INVALID_ARGS', `Multiple apps matched "${app}"`, { matches });
  }

  throw new AppError('APP_NOT_INSTALLED', `No app found matching "${app}"`);
}

type SimulatorAppMetadata = {
  bundleId: string;
  name: string;
  path?: string;
  applicationType?: string;
};

export async function resolveIosSimulatorDeepLinkBundleId(
  device: DeviceInfo,
  url: string,
): Promise<string | undefined> {
  if (device.platform !== 'ios' || device.kind !== 'simulator') return undefined;
  const scheme = parseUrlScheme(url);
  if (!scheme) return undefined;

  const apps = await listSimulatorAppMetadata(device);
  const matches: SimulatorAppMetadata[] = [];
  for (const app of apps) {
    if (app.bundleId.startsWith(AGENT_DEVICE_RUNNER_BUNDLE_PREFIX)) continue;
    if (!app.path) continue;
    const schemes = await readIosSimulatorAppUrlSchemes(path.join(app.path, 'Info.plist'));
    if (schemes.has(scheme)) {
      matches.push(app);
    }
  }

  const userMatches = matches.filter((app) => app.applicationType === 'User');
  if (userMatches.length === 1) return userMatches[0]?.bundleId;
  if (userMatches.length > 1) return undefined;
  return matches.length === 1 ? matches[0]?.bundleId : undefined;
}

function parseUrlScheme(url: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url.trim());
  return match?.[1]?.toLowerCase();
}

// fallow-ignore-next-line complexity
export async function openIosApp(
  device: DeviceInfo,
  app: string,
  options?: { appBundleId?: string; launchConsole?: string; launchArgs?: string[]; url?: string },
): Promise<void> {
  const launchConsole = options?.launchConsole?.trim();
  const launchArgs = options?.launchArgs;
  if (launchConsole && (device.platform !== 'ios' || device.kind !== 'simulator')) {
    throw new AppError('UNSUPPORTED_OPERATION', LAUNCH_CONSOLE_IOS_SIMULATOR_ONLY_MESSAGE);
  }
  if (device.platform === 'macos') {
    if (launchArgs && launchArgs.length > 0) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        '--launch-args is not supported on macOS; launch arguments are currently iOS-only.',
      );
    }
    await openMacOsApp(device, app, options);
    return;
  }
  const explicitUrl = options?.url?.trim();
  if (explicitUrl) {
    if (launchConsole) {
      throw new AppError('INVALID_ARGS', LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE);
    }
    if (!isDeepLinkTarget(explicitUrl)) {
      throw new AppError('INVALID_ARGS', 'open <app> <url> requires a valid URL target');
    }
    if (device.kind === 'simulator') {
      if (launchArgs || isWebUrl(explicitUrl)) {
        const bundleId = options?.appBundleId ?? (await resolveIosApp(device, app));
        await launchIosSimulatorApp(device, bundleId, {
          ...(launchArgs ? { launchArgs } : {}),
        });
      }
      await openIosSimulatorUrl(device, explicitUrl, undefined);
      return;
    }
    const appBundleId = options?.appBundleId ?? (await resolveIosApp(device, app));
    const bundleId = resolveIosDeviceDeepLinkBundleId(appBundleId, explicitUrl);
    if (!bundleId) {
      throw new AppError(
        'INVALID_ARGS',
        'Deep link open on iOS devices requires an active app bundle ID. Open the app first, then open the URL.',
      );
    }
    await launchIosDeviceProcess(device, bundleId, { payloadUrl: explicitUrl, launchArgs });
    return;
  }

  const deepLinkTarget = app.trim();
  if (isDeepLinkTarget(deepLinkTarget)) {
    if (launchConsole) {
      throw new AppError('INVALID_ARGS', LAUNCH_CONSOLE_DIRECT_APP_ONLY_MESSAGE);
    }
    if (device.kind === 'simulator') {
      await openIosSimulatorUrl(device, deepLinkTarget, launchArgs);
      return;
    }
    const bundleId = resolveIosDeviceDeepLinkBundleId(options?.appBundleId, deepLinkTarget);
    if (!bundleId) {
      throw new AppError(
        'INVALID_ARGS',
        'Deep link open on iOS devices requires an active app bundle ID. Open the app first, then open the URL.',
      );
    }
    await launchIosDeviceProcess(device, bundleId, { payloadUrl: deepLinkTarget, launchArgs });
    return;
  }

  const bundleId = options?.appBundleId ?? (await resolveIosApp(device, app));
  if (device.kind === 'simulator') {
    await launchIosSimulatorApp(device, bundleId, {
      ...(launchConsole ? { launchConsole } : {}),
      ...(launchArgs ? { launchArgs } : {}),
    });
    return;
  }

  await launchIosDeviceProcess(device, bundleId, { launchArgs });
}

async function openIosSimulatorUrl(
  device: DeviceInfo,
  url: string,
  launchArgs: string[] | undefined,
): Promise<void> {
  if (launchArgs && launchArgs.length > 0) {
    throw new AppError('INVALID_ARGS', IOS_SIMULATOR_LAUNCH_ARGS_WITH_URL_MESSAGE);
  }
  await ensureBootedSimulator(device);
  await runSimctl(device, ['openurl', device.id, url]);
}

export async function openIosDevice(device: DeviceInfo): Promise<void> {
  if (device.platform === 'macos') {
    return;
  }
  if (device.kind !== 'simulator') return;
  const state = await getSimulatorState(device);
  if (state === 'Booted') return;

  await ensureBootedSimulator(device);
}

export async function closeIosApp(device: DeviceInfo, app: string): Promise<void> {
  if (device.platform === 'macos') {
    await closeMacOsApp(device, app);
    return;
  }
  const bundleId = await resolveIosApp(device, app);
  if (device.kind === 'simulator') {
    await ensureBootedSimulator(device);
    const terminateArgs = simctlArgs(device, ['terminate', device.id, bundleId]);
    const result = await runXcrun(terminateArgs, {
      allowFailure: true,
      timeoutMs: IOS_SIMULATOR_TERMINATE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toLowerCase();
      if (stderr.includes('found nothing to terminate')) return;
      throw new AppError('COMMAND_FAILED', `xcrun exited with code ${result.exitCode}`, {
        cmd: 'xcrun',
        args: terminateArgs,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }
    return;
  }

  await runIosDevicectl(['device', 'process', 'terminate', '--device', device.id, bundleId], {
    action: 'terminate iOS app',
    deviceId: device.id,
  });
}

async function clearIosSimulatorAppState(
  device: DeviceInfo,
  app: string,
): Promise<{ bundleId: string; containerPath: string }> {
  if (device.platform !== 'ios' || device.kind !== 'simulator') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Clearing app state is currently supported only on iOS simulators.',
    );
  }

  const bundleId = await resolveIosApp(device, app);
  await ensureBootedSimulator(device);
  await closeIosApp(device, bundleId);

  const result = await runSimctl(device, ['get_app_container', device.id, bundleId, 'data'], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', `simctl get_app_container failed for ${bundleId}`, {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }

  const containerPath = result.stdout.trim();
  if (!containerPath) {
    throw new AppError(
      'COMMAND_FAILED',
      `simctl get_app_container returned an empty data container path for ${bundleId}`,
    );
  }

  const entries = await fs.readdir(containerPath);
  await Promise.all(
    entries.map((entry) =>
      fs.rm(path.join(containerPath, entry), {
        recursive: true,
        force: true,
      }),
    ),
  );

  return { bundleId, containerPath };
}

export async function uninstallIosApp(
  device: DeviceInfo,
  app: string,
): Promise<{ bundleId: string }> {
  return await iosAppResolutionCache.invalidateWhile(iosAppResolutionScope(device), async () => {
    const bundleId = await resolveIosApp(device, app);
    if (device.kind !== 'simulator') {
      const args = ['devicectl', 'device', 'uninstall', 'app', '--device', device.id, bundleId];
      const result = await runXcrun(args, {
        allowFailure: true,
        timeoutMs: IOS_DEVICECTL_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        const stdout = String(result.stdout ?? '');
        const stderr = String(result.stderr ?? '');
        const output = `${stdout}\n${stderr}`.toLowerCase();
        if (!isMissingAppErrorOutput(output)) {
          throw new AppError('COMMAND_FAILED', `Failed to uninstall iOS app ${bundleId}`, {
            cmd: 'xcrun',
            args,
            exitCode: result.exitCode,
            stdout,
            stderr,
            deviceId: device.id,
            hint: resolveIosDevicectlHint(stdout, stderr) ?? IOS_DEVICECTL_DEFAULT_HINT,
          });
        }
      }
      return { bundleId };
    }

    await ensureBootedSimulator(device);

    const result = await runSimctl(device, ['uninstall', device.id, bundleId], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (!isMissingAppErrorOutput(output)) {
        throw new AppError('COMMAND_FAILED', `simctl uninstall failed for ${bundleId}`, {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }
    }

    return { bundleId };
  });
}

export async function installIosApp(
  device: DeviceInfo,
  appPath: string,
  options?: InstallIosAppOptions,
): Promise<{
  archivePath?: string;
  installablePath: string;
  bundleId?: string;
  appName?: string;
  launchTarget?: string;
}> {
  const prepared = await prepareIosInstallArtifact({ kind: 'path', path: appPath }, options);
  try {
    await installIosInstallablePath(device, prepared.installablePath);
    return {
      archivePath: prepared.archivePath,
      installablePath: prepared.installablePath,
      bundleId: prepared.bundleId,
      appName: prepared.appName,
      launchTarget: prepared.bundleId,
    };
  } finally {
    await prepared.cleanup();
  }
}

export async function reinstallIosApp(
  device: DeviceInfo,
  app: string,
  appPath: string,
): Promise<{ bundleId: string }> {
  return await iosAppResolutionCache.invalidateWhile(iosAppResolutionScope(device), async () => {
    const { bundleId } = await uninstallIosApp(device, app);
    await installIosApp(device, appPath, { appIdentifierHint: app });
    return { bundleId };
  });
}

export async function installIosInstallablePath(
  device: DeviceInfo,
  installablePath: string,
): Promise<void> {
  await iosAppResolutionCache.invalidateWhile(iosAppResolutionScope(device), async () => {
    if (device.kind !== 'simulator') {
      await runIosDevicectl(['device', 'install', 'app', '--device', device.id, installablePath], {
        action: 'install iOS app',
        deviceId: device.id,
      });
      return;
    }

    await ensureBootedSimulator(device);
    await runSimctl(device, ['install', device.id, installablePath]);
  });
}

export async function readIosClipboardText(device: DeviceInfo): Promise<string> {
  if (device.platform === 'macos') {
    return await readMacOsClipboardText();
  }
  requireSimulatorDevice(device, 'clipboard');
  await ensureBootedSimulator(device);
  const result = await runSimctl(device, ['pbpaste', device.id], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'Failed to read iOS simulator clipboard', {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return result.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

export async function writeIosClipboardText(device: DeviceInfo, text: string): Promise<void> {
  if (device.platform === 'macos') {
    await writeMacOsClipboardText(text);
    return;
  }
  requireSimulatorDevice(device, 'clipboard');
  await ensureBootedSimulator(device);
  const result = await runSimctl(device, ['pbcopy', device.id], {
    allowFailure: true,
    stdin: text,
  });
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'Failed to write iOS simulator clipboard', {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
}

export async function pushIosNotification(
  device: DeviceInfo,
  bundleId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  requireSimulatorDevice(device, 'push');
  await ensureBootedSimulator(device);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-push-'));
  const payloadPath = path.join(tempDir, 'payload.apns');
  try {
    await fs.writeFile(payloadPath, `${JSON.stringify(payload)}\n`, 'utf8');
    await runSimctl(device, ['push', device.id, bundleId, payloadPath]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function setIosSetting(
  device: DeviceInfo,
  setting: string,
  state: string,
  appBundleId?: string,
  options?: SettingOptions,
): Promise<Record<string, unknown> | void> {
  if (device.platform === 'macos') {
    const normalizedSetting = setting.toLowerCase();
    if (normalizedSetting === 'appearance') {
      await setMacOsAppearance(state);
      return;
    }
    if (normalizedSetting === 'permission') {
      const action = parsePermissionAction(state);
      if (action === 'deny') {
        throw new AppError('INVALID_ARGS', getUnsupportedMacOsSettingMessage('permission'));
      }
      const permissionTarget = parseMacOsPermissionTarget(options?.permissionTarget);
      return await runMacOsPermissionAction(action, permissionTarget);
    }
    throw new AppError('INVALID_ARGS', getUnsupportedMacOsSettingMessage(setting));
  }
  requireSimulatorDevice(device, 'settings');
  await ensureBootedSimulator(device);
  const normalized = setting.toLowerCase();

  switch (normalized) {
    case 'clear-app-state': {
      if (state.toLowerCase() !== 'clear') {
        throw new AppError('INVALID_ARGS', 'settings clear-app-state only supports clear.');
      }
      if (!appBundleId) {
        throw new AppError(
          'INVALID_ARGS',
          'settings clear-app-state requires an app id or an active app session.',
        );
      }
      const result = await clearIosSimulatorAppState(device, appBundleId);
      return { bundleId: result.bundleId, containerPath: result.containerPath, cleared: true };
    }
    case 'wifi': {
      const enabled = parseSettingState(state);
      const mode = enabled ? 'active' : 'failed';
      await runSimctl(device, ['status_bar', device.id, 'override', '--wifiMode', mode]);
      invalidateSimulatorStatusBarOverrideCache(device);
      return;
    }
    case 'airplane': {
      const enabled = parseSettingState(state);
      if (enabled) {
        await runSimctl(device, [
          'status_bar',
          device.id,
          'override',
          '--dataNetwork',
          'hide',
          '--wifiMode',
          'failed',
          '--wifiBars',
          '0',
          '--cellularMode',
          'failed',
          '--cellularBars',
          '0',
          '--operatorName',
          '',
        ]);
        invalidateSimulatorStatusBarOverrideCache(device);
      } else {
        await runSimctl(device, ['status_bar', device.id, 'clear']);
        rememberClearedStatusBarOverrides(device);
      }
      return;
    }
    case 'location': {
      if (state.toLowerCase() === 'set') {
        const { latitude, longitude } = requireLocationCoordinates(options);
        await runSimctl(device, ['location', device.id, 'set', `${latitude},${longitude}`]);
        return { latitude, longitude };
      }
      const enabled = parseSettingState(state);
      if (!appBundleId) {
        throw new AppError('INVALID_ARGS', 'location setting requires an active app in session');
      }
      const action = enabled ? 'grant' : 'revoke';
      await runSimctl(device, ['privacy', device.id, action, 'location', appBundleId]);
      return;
    }
    case 'faceid':
    case 'touchid': {
      const biometricSetting = normalized as IosBiometricSetting;
      const biometric = IOS_BIOMETRIC_SETTINGS[biometricSetting];
      const action = parseBiometricAction(state, biometricSetting);
      await runIosBiometricSimctlCommand(device, action, {
        settingName: biometricSetting,
        label: biometric.label,
        modalityAliases: biometric.modalityAliases,
      });
      return;
    }
    case 'appearance': {
      const target = await resolveIosAppearanceTarget(device, state);
      await runSimctl(device, ['ui', device.id, 'appearance', target]);
      return;
    }
    case 'permission': {
      if (!appBundleId) {
        throw new AppError('INVALID_ARGS', 'permission setting requires an active app in session');
      }
      const action = mapIosPermissionAction(parsePermissionAction(state));
      const target = parseIosPermissionTarget(options?.permissionTarget, options?.permissionMode);
      await runIosPrivacyCommand(device, action, target, appBundleId);
      return;
    }
    default:
      throw new AppError('INVALID_ARGS', `Unsupported setting: ${setting}`);
  }
}

export async function listIosApps(device: DeviceInfo, filter: AppsFilter): Promise<IosAppInfo[]> {
  if (device.platform === 'macos') {
    return await listMacApps(filter);
  }
  if (device.kind === 'simulator') {
    const apps = await listSimulatorApps(device);
    return filterAppleAppsByBundlePrefix(apps, filter);
  }
  return await listIosDeviceApps(device, filter);
}

export async function listSimulatorApps(device: DeviceInfo): Promise<IosAppInfo[]> {
  const apps = await listSimulatorAppMetadata(device);
  return apps.map((app) => ({
    bundleId: app.bundleId,
    name: app.name,
  }));
}

async function listSimulatorAppMetadata(device: DeviceInfo): Promise<SimulatorAppMetadata[]> {
  const result = await runSimctl(device, ['listapps', device.id], { allowFailure: true });
  const stdout = result.stdout as string;
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: Record<
    string,
    {
      ApplicationType?: string;
      Bundle?: string;
      CFBundleDisplayName?: string;
      CFBundleName?: string;
      Path?: string;
    }
  > | null = null;
  if (trimmed.startsWith('{')) {
    try {
      parsed = JSON.parse(trimmed) as Record<
        string,
        {
          ApplicationType?: string;
          Bundle?: string;
          CFBundleDisplayName?: string;
          CFBundleName?: string;
          Path?: string;
        }
      >;
    } catch {
      parsed = null;
    }
  }

  if (!parsed && trimmed.startsWith('{')) {
    try {
      const converted = await runAppleToolCommand('plutil', ['-convert', 'json', '-o', '-', '-'], {
        allowFailure: true,
        stdin: trimmed,
      });
      if (converted.exitCode === 0 && converted.stdout.trim().startsWith('{')) {
        parsed = JSON.parse(converted.stdout) as Record<
          string,
          {
            ApplicationType?: string;
            Bundle?: string;
            CFBundleDisplayName?: string;
            CFBundleName?: string;
            Path?: string;
          }
        >;
      }
    } catch {
      parsed = null;
    }
  }

  if (!parsed) return [];
  return Object.entries(parsed).map(([bundleId, info]) => {
    const appPath = resolveSimulatorAppPath(info);
    return {
      bundleId,
      name: info.CFBundleDisplayName ?? info.CFBundleName ?? bundleId,
      ...(appPath ? { path: appPath } : {}),
      ...(info.ApplicationType ? { applicationType: info.ApplicationType } : {}),
    };
  });
}

function resolveSimulatorAppPath(info: { Bundle?: string; Path?: string }): string | undefined {
  if (info.Path) return info.Path;
  if (!info.Bundle) return undefined;
  try {
    return fileURLToPath(info.Bundle);
  } catch {
    return undefined;
  }
}

async function readIosSimulatorAppUrlSchemes(infoPlistPath: string): Promise<Set<string>> {
  const result = await runAppleToolCommand(
    'plutil',
    ['-convert', 'json', '-o', '-', infoPlistPath],
    {
      allowFailure: true,
    },
  );
  if (result.exitCode !== 0) return new Set();
  try {
    const parsed = JSON.parse(result.stdout) as {
      CFBundleURLTypes?: Array<{ CFBundleURLSchemes?: unknown }>;
    };
    const schemes = new Set<string>();
    for (const urlType of parsed.CFBundleURLTypes ?? []) {
      if (!Array.isArray(urlType.CFBundleURLSchemes)) continue;
      for (const scheme of urlType.CFBundleURLSchemes) {
        if (typeof scheme === 'string' && scheme.trim()) {
          schemes.add(scheme.trim().toLowerCase());
        }
      }
    }
    return schemes;
  } catch {
    return new Set();
  }
}

function parseMacOsPermissionTarget(value: string | undefined): MacOsPermissionTarget {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'accessibility' ||
    normalized === 'screen-recording' ||
    normalized === 'input-monitoring'
  ) {
    return normalized;
  }
  throw new AppError(
    'INVALID_ARGS',
    'Unsupported macOS permission target. Use accessibility|screen-recording|input-monitoring.',
  );
}

async function resolveIosAppearanceTarget(
  device: DeviceInfo,
  state: string,
): Promise<'light' | 'dark'> {
  const action = parseAppearanceAction(state);
  if (action !== 'toggle') return action;

  const currentResult = await runSimctl(device, ['ui', device.id, 'appearance'], {
    allowFailure: true,
  });
  if (currentResult.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'Failed to read current iOS appearance', {
      stdout: currentResult.stdout,
      stderr: currentResult.stderr,
      exitCode: currentResult.exitCode,
    });
  }
  const current = parseIosAppearance(currentResult.stdout, currentResult.stderr);
  if (!current) {
    throw new AppError('COMMAND_FAILED', 'Unable to determine current iOS appearance for toggle', {
      stdout: currentResult.stdout,
      stderr: currentResult.stderr,
    });
  }
  return current === 'dark' ? 'light' : 'dark';
}

function parseIosAppearance(stdout: string, stderr: string): 'light' | 'dark' | null {
  const match = /\b(light|dark|unsupported|unknown)\b/i.exec(`${stdout}\n${stderr}`);
  if (!match) return null;
  const value = match[1]?.toLowerCase();
  if (value === 'dark') return 'dark';
  if (value === 'light') return 'light';
  return null;
}

type IosBiometricAction = 'match' | 'nonmatch' | 'enroll' | 'unenroll';
type IosBiometricSetting = 'faceid' | 'touchid';

const IOS_BIOMETRIC_SETTINGS: Record<
  IosBiometricSetting,
  { label: 'Face ID' | 'Touch ID'; modalityAliases: string[] }
> = {
  faceid: { label: 'Face ID', modalityAliases: ['face'] },
  touchid: { label: 'Touch ID', modalityAliases: ['finger', 'touch'] },
};

function mapIosPermissionAction(action: 'grant' | 'deny' | 'reset'): 'grant' | 'revoke' | 'reset' {
  if (action === 'deny') return 'revoke';
  return action;
}

async function runIosPrivacyCommand(
  device: DeviceInfo,
  action: 'grant' | 'revoke' | 'reset',
  target: string,
  appBundleId: string,
): Promise<void> {
  const supportedServices = await getSimctlPrivacyServices(device);
  if (!supportedServices.has(target)) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `iOS simctl privacy does not support service "${target}" on this runtime.`,
      {
        deviceId: device.id,
        appBundleId,
        hint: `Supported services: ${Array.from(supportedServices).sort().join(', ')}`,
      },
    );
  }

  const args = ['privacy', device.id, action, target, appBundleId];
  const isNotificationsTarget = target === 'notifications';
  if (!(action === 'reset' && isNotificationsTarget)) {
    try {
      await runSimctl(device, args);
      return;
    } catch (error) {
      if (!(isNotificationsTarget && isNotificationsOperationNotPermitted(error))) {
        throw error;
      }
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'iOS simulator does not support setting notifications permission via simctl privacy on this runtime.',
        {
          deviceId: device.id,
          appBundleId,
          hint: 'Use reset notifications for reprompt behavior, or toggle notifications manually in Settings.',
        },
      );
    }
  }

  try {
    await runSimctl(device, args);
    return;
  } catch (error) {
    if (!isNotificationsOperationNotPermitted(error)) {
      throw error;
    }
  }

  try {
    await runSimctl(device, ['privacy', device.id, 'reset', 'all', appBundleId]);
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'iOS simulator blocked direct notifications reset. Fallback reset-all also failed.',
      {
        deviceId: device.id,
        appBundleId,
        hint: 'Use reinstall to force a fresh notifications prompt, or reset simulator content and settings.',
      },
      error instanceof Error ? error : undefined,
    );
  }
}

function isNotificationsOperationNotPermitted(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return false;
  const stderr = String(error.details?.stderr ?? '').toLowerCase();
  return (
    (stderr.includes('failed to grant access') ||
      stderr.includes('failed to revoke access') ||
      stderr.includes('failed to reset access')) &&
    stderr.includes('operation not permitted')
  );
}

async function getSimctlPrivacyServices(device: DeviceInfo): Promise<Set<string>> {
  const simulatorSetPath = resolveIosSimulatorDeviceSetPath(device.simulatorSetPath);
  const currentCacheKey = `${process.env.PATH ?? ''}::${simulatorSetPath ?? ''}`;
  if (cachedSimctlPrivacyServices && cachedSimctlPrivacyServicesCacheKey === currentCacheKey) {
    return cachedSimctlPrivacyServices;
  }
  const result = await runSimctl(device, ['privacy', 'help'], { allowFailure: true });
  const services = parseSimctlPrivacyServices(`${result.stdout}\n${result.stderr}`);
  if (services.size === 0) {
    throw new AppError('COMMAND_FAILED', 'Unable to determine supported simctl privacy services', {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      hint: 'Run `xcrun simctl privacy help` manually to verify available services for this runtime.',
    });
  }
  cachedSimctlPrivacyServices = services;
  cachedSimctlPrivacyServicesCacheKey = currentCacheKey;
  return services;
}

function parseSimctlPrivacyServices(helpText: string): Set<string> {
  const services = new Set<string>();
  let inServiceSection = false;
  for (const line of helpText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'service') {
      inServiceSection = true;
      continue;
    }
    if (!inServiceSection) continue;
    if (trimmed.startsWith('bundle identifier')) break;
    const match = /^([a-z-]+)\s+-\s+/.exec(trimmed);
    const service = match?.[1];
    if (service !== undefined) {
      services.add(service);
    }
  }
  return services;
}

// fallow-ignore-next-line complexity
function parseIosPermissionTarget(
  permissionTarget: string | undefined,
  permissionMode: string | undefined,
): string {
  const normalized = parsePermissionTarget(permissionTarget);
  if (normalized !== 'photos' && permissionMode?.trim()) {
    throw new AppError(
      'INVALID_ARGS',
      `Permission mode is only supported for photos. Received: ${permissionMode}.`,
    );
  }
  if (normalized === 'camera') return 'camera';
  if (normalized === 'microphone') return 'microphone';
  if (normalized === 'contacts') return 'contacts';
  if (normalized === 'contacts-limited') return 'contacts-limited';
  if (normalized === 'notifications') return 'notifications';
  if (normalized === 'calendar') return 'calendar';
  if (normalized === 'location') return 'location';
  if (normalized === 'location-always') return 'location-always';
  if (normalized === 'media-library') return 'media-library';
  if (normalized === 'motion') return 'motion';
  if (normalized === 'reminders') return 'reminders';
  if (normalized === 'siri') return 'siri';
  if (normalized === 'photos') {
    const mode = permissionMode?.trim().toLowerCase();
    if (!mode || mode === 'full') return 'photos';
    if (mode === 'limited') return 'photos-add';
    throw new AppError('INVALID_ARGS', `Invalid photos mode: ${permissionMode}. Use full|limited.`);
  }
  throw new AppError(
    'INVALID_ARGS',
    `Unsupported permission target: ${permissionTarget}. Use camera|microphone|photos|contacts|contacts-limited|notifications|calendar|location|location-always|media-library|motion|reminders|siri.`,
  );
}

function parseBiometricAction(state: string, settingName: IosBiometricSetting): IosBiometricAction {
  const normalized = state.trim().toLowerCase();
  if (normalized === 'match') return 'match';
  if (normalized === 'nonmatch') return 'nonmatch';
  if (normalized === 'enroll') return 'enroll';
  if (normalized === 'unenroll') return 'unenroll';
  throw new AppError(
    'INVALID_ARGS',
    `Invalid ${settingName} state: ${state}. Use match|nonmatch|enroll|unenroll.`,
  );
}

async function runIosBiometricSimctlCommand(
  device: DeviceInfo,
  action: IosBiometricAction,
  options: {
    settingName: IosBiometricSetting;
    label: 'Face ID' | 'Touch ID';
    modalityAliases: string[];
  },
): Promise<void> {
  const attempts = biometricCommandAttempts(device.id, action, options.modalityAliases);
  const failures: CommandAttemptFailure[] = [];

  for (const args of attempts) {
    const commandArgs = simctlArgs(device, args);
    const result = await runXcrun(commandArgs, { allowFailure: true });
    if (result.exitCode === 0) return;
    failures.push({
      args: commandArgs,
      stderr: result.stderr,
      stdout: result.stdout,
      exitCode: result.exitCode,
    });
  }

  const attemptsPayload = summarizeCommandAttemptFailures(failures);
  const capabilityMissing =
    failures.length > 0 &&
    failures.every((failure) => isIosBiometricCapabilityMissing(failure.stdout, failure.stderr));
  if (capabilityMissing) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `${options.label} simulation is not supported on this simulator runtime.`,
      {
        deviceId: device.id,
        action,
        setting: options.settingName,
        attempts: attemptsPayload,
      },
    );
  }
  throw new AppError('COMMAND_FAILED', `Failed to simulate ${options.settingName}.`, {
    deviceId: device.id,
    action,
    setting: options.settingName,
    attempts: attemptsPayload,
  });
}

function biometricCommandAttempts(
  deviceId: string,
  action: IosBiometricAction,
  modalityAliases: string[],
): string[][] {
  const modalities = modalityAliases.length > 0 ? modalityAliases : ['face'];
  switch (action) {
    case 'match':
      return modalities.flatMap((modality) => [
        ['biometric', deviceId, 'match', modality],
        ['biometric', 'match', deviceId, modality],
      ]);
    case 'nonmatch':
      return modalities.flatMap((modality) => [
        ['biometric', deviceId, 'nonmatch', modality],
        ['biometric', deviceId, 'nomatch', modality],
        ['biometric', 'nonmatch', deviceId, modality],
        ['biometric', 'nomatch', deviceId, modality],
      ]);
    case 'enroll':
      return [
        ['biometric', deviceId, 'enroll', 'yes'],
        ['biometric', deviceId, 'enroll', '1'],
        ['biometric', 'enroll', deviceId, 'yes'],
        ['biometric', 'enroll', deviceId, '1'],
      ];
    case 'unenroll':
      return [
        ['biometric', deviceId, 'enroll', 'no'],
        ['biometric', deviceId, 'enroll', '0'],
        ['biometric', 'enroll', deviceId, 'no'],
        ['biometric', 'enroll', deviceId, '0'],
      ];
  }
}

function isIosBiometricCapabilityMissing(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return (
    text.includes('unrecognized subcommand') ||
    text.includes('unknown subcommand') ||
    text.includes('not supported') ||
    text.includes('unavailable') ||
    (text.includes('biometric') && text.includes('invalid'))
  );
}

async function launchIosSimulatorApp(
  device: DeviceInfo,
  bundleId: string,
  options?: { launchConsole?: string; launchArgs?: string[] },
): Promise<void> {
  await ensureBootedSimulator(device);

  let consecutiveFBSFailures = 0;
  const MAX_CONSECUTIVE_FBS_FAILURES = 3;

  const launchDeadline = Deadline.fromTimeoutMs(IOS_APP_LAUNCH_TIMEOUT_MS);
  try {
    await retryWithPolicy(
      async ({ deadline: attemptDeadline }) => {
        if (attemptDeadline?.isExpired()) {
          throw new AppError('COMMAND_FAILED', 'App launch deadline exceeded', {
            timeoutMs: IOS_APP_LAUNCH_TIMEOUT_MS,
          });
        }

        const launchArgs = simctlArgs(
          device,
          buildIosSimulatorLaunchArgs(device.id, bundleId, options),
        );
        const result = options?.launchConsole
          ? await runIosSimulatorConsoleLaunch(launchArgs, options.launchConsole)
          : await runXcrun(launchArgs, {
              allowFailure: true,
            });
        if (result.exitCode === 0) return;

        throw new AppError('COMMAND_FAILED', `xcrun exited with code ${result.exitCode}`, {
          cmd: 'xcrun',
          args: launchArgs,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      },
      {
        maxAttempts: 10,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
        jitter: 0.2,
        shouldRetry(error: unknown) {
          if (!isSimulatorLaunchFBSError(error)) return false;
          consecutiveFBSFailures += 1;
          return consecutiveFBSFailures < MAX_CONSECUTIVE_FBS_FAILURES;
        },
      },
      { deadline: launchDeadline },
    );
  } catch (error) {
    if (isSimulatorLaunchFBSError(error)) {
      const appError = error as AppError;
      const probe = await probeSimulatorLaunchContext(device, bundleId);
      const reason = classifyLaunchFailure(probe);
      appError.details = { ...appError.details, hint: launchFailureHint(reason) };
    }
    throw error;
  }
}

function buildIosSimulatorLaunchArgs(
  deviceId: string,
  bundleId: string,
  options?: { launchConsole?: string; launchArgs?: string[] },
): string[] {
  const args = ['launch'];
  if (options?.launchConsole) args.push('--console-pty');
  args.push(deviceId, bundleId);
  if (options?.launchArgs && options.launchArgs.length > 0) {
    args.push(...options.launchArgs);
  }
  return args;
}

async function runIosSimulatorConsoleLaunch(
  launchArgs: string[],
  logPath: string,
): Promise<Awaited<ReturnType<typeof runXcrun>>> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  try {
    const result = await runXcrun(launchArgs, {
      allowFailure: true,
      timeoutMs: IOS_SIMULATOR_CONSOLE_CAPTURE_MS,
    });
    await writeIosSimulatorConsoleLog(logPath, result.stdout, result.stderr);
    return result;
  } catch (error) {
    const appError = error instanceof AppError ? error : undefined;
    const details = appError?.details;
    if (details?.timeoutMs === IOS_SIMULATOR_CONSOLE_CAPTURE_MS) {
      const stdout = typeof details.stdout === 'string' ? details.stdout : '';
      const stderr = typeof details.stderr === 'string' ? details.stderr : '';
      await writeIosSimulatorConsoleLog(logPath, stdout, stderr);
      emitDiagnostic({
        level: 'warn',
        phase: 'ios_simulator_launch_console_capture_timeout',
        data: {
          timeoutMs: IOS_SIMULATOR_CONSOLE_CAPTURE_MS,
          logPath,
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: Buffer.byteLength(stderr),
        },
      });
      return { stdout, stderr, exitCode: 0 };
    }
    throw error;
  }
}

async function writeIosSimulatorConsoleLog(
  logPath: string,
  stdout: string,
  stderr: string,
): Promise<void> {
  await fs.writeFile(logPath, joinProcessOutput(stdout, stderr), 'utf8');
}

function joinProcessOutput(stdout: string, stderr: string): string {
  if (!stdout || !stderr || stdout.endsWith('\n') || stdout.endsWith('\r')) {
    return `${stdout}${stderr}`;
  }
  return `${stdout}\n${stderr}`;
}

async function launchIosDeviceProcess(
  device: DeviceInfo,
  bundleId: string,
  options?: { payloadUrl?: string; launchArgs?: string[] },
): Promise<void> {
  const args = ['device', 'process', 'launch', '--device', device.id, bundleId];
  if (options?.payloadUrl) {
    args.push('--payload-url', options.payloadUrl);
  }
  if (options?.launchArgs && options.launchArgs.length > 0) {
    // `devicectl` uses Swift ArgumentParser; without `--` an arg starting with
    // `-` / `--` could be re-interpreted as one of devicectl's own options.
    args.push('--', ...options.launchArgs);
  }
  await runIosDevicectl(args, { action: 'launch iOS app', deviceId: device.id });
}
