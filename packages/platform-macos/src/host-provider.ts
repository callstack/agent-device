import { hostFileStat, hostHomeDirectory } from '@agent-device/host-kit/host-file';
import path from 'node:path';
import type { AppsFilter } from '@agent-device/contracts/device';
import type {
  MacOsHostProvider,
  MacOsInstalledApp,
  MacOsOpenOptions,
} from '@agent-device/contracts/macos-platform-leaf';
import { AppError, requireCommandSuccess } from '@agent-device/kernel/errors';
import type { MacOsRunCommand, MacOsToolbox } from './toolbox.ts';

type PlistJsonReader = (plistPath: string) => Promise<Record<string, unknown> | null>;

/** The local host routes: `open`, the pasteboard tools, `osascript`, and the app directories. */
export function createLocalMacOsHostProvider(box: MacOsToolbox): MacOsHostProvider {
  const runCommand = box.tools.runCommand;
  const readPlistJson: PlistJsonReader = async (plistPath) =>
    await box.tools.readPlistJson(plistPath);
  return {
    openBundle: async (bundleId, url, options) => {
      // Loaded on the first bundle open, not when this provider is constructed: the probe's host-kit
      // reads stay off the Apple façades' eager closure (ADR 0019).
      const { resolveListedRunningBundle } = await import('./launch-services-registration.ts');
      const runningBundle = await resolveListedRunningBundle(box, bundleId);
      await runCommand('open', [
        ...openActivationArgs(options),
        ...(runningBundle
          ? buildMacOpenPathArgs(runningBundle, url)
          : buildMacOpenArgs(bundleId, url)),
      ]);
    },
    openTarget: async (target, options) => {
      await runCommand('open', [...openActivationArgs(options), target]);
    },
    readClipboard: async () => {
      const result = requireCommandSuccess(
        await runCommand('pbpaste', [], { allowFailure: true }),
        'Failed to read macOS clipboard',
      );
      return result.stdout.replaceAll('\r\n', '\n').replace(/\n$/, '');
    },
    writeClipboard: async (text) => {
      requireCommandSuccess(
        await runCommand('pbcopy', [], {
          allowFailure: true,
          stdin: text,
        }),
        'Failed to write macOS clipboard',
      );
    },
    readDarkMode: async () => {
      const script =
        'tell application "System Events" to tell appearance preferences to get dark mode';
      const result = requireCommandSuccess(
        await runCommand('osascript', ['-e', script], { allowFailure: true }),
        'Failed to read macOS appearance',
      );
      const normalized = result.stdout.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
      throw new AppError(
        'COMMAND_FAILED',
        `Unable to determine current macOS appearance from osascript output: ${result.stdout.trim()}`,
      );
    },
    setDarkMode: async (enabled) => {
      const script = `tell application "System Events" to tell appearance preferences to set dark mode to ${enabled ? 'true' : 'false'}`;
      requireCommandSuccess(
        await runCommand('osascript', ['-e', script], { allowFailure: true }),
        'Failed to set macOS appearance',
      );
    },
    listApps: async (filter) => await listLocalMacApps(runCommand, readPlistJson, filter),
  };
}

function openActivationArgs(options: MacOsOpenOptions | undefined): string[] {
  return options?.background ? ['-g'] : [];
}

function buildMacOpenArgs(bundleId: string, url?: string): string[] {
  const openArgs = ['-b', bundleId];
  if (url) {
    openArgs.push(url);
  }
  return openArgs;
}

function buildMacOpenPathArgs(bundlePath: string, url?: string): string[] {
  return url ? ['-a', bundlePath, url] : [bundlePath];
}

async function listLocalMacApps(
  runCommand: MacOsRunCommand,
  readPlistJson: PlistJsonReader,
  filter: AppsFilter,
): Promise<MacOsInstalledApp[]> {
  const appRoots = [
    '/Applications',
    '/System/Applications',
    path.join(hostHomeDirectory(), 'Applications'),
  ];
  const appPaths = new Set<string>();

  for (const root of appRoots) {
    const stat = await hostFileStat(root).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const result = await runCommand(
      'find',
      [root, '-maxdepth', '4', '-type', 'd', '-name', '*.app'],
      {
        allowFailure: true,
      },
    );
    if (result.exitCode !== 0) continue;
    for (const line of result.stdout.split('\n')) {
      const candidate = line.trim();
      if (candidate) appPaths.add(candidate);
    }
  }

  const apps = await Promise.all(
    Array.from(appPaths).map(async (appPath) => {
      const bundleInfo = await readMacOsBundleInfo(appPath, readPlistJson).catch(
        () =>
          ({}) as {
            bundleId?: string;
            appName?: string;
          },
      );
      const bundleId = bundleInfo.bundleId;
      if (!bundleId) return null;
      return {
        bundleId,
        name: bundleInfo.appName ?? path.basename(appPath, '.app'),
      } satisfies MacOsInstalledApp;
    }),
  );

  const listed = apps
    .filter((app): app is MacOsInstalledApp => app !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return filter === 'user-installed'
    ? listed.filter((app) => !app.bundleId.startsWith('com.apple.'))
    : listed;
}

async function readMacOsBundleInfo(
  appBundlePath: string,
  readPlistJson: PlistJsonReader,
): Promise<{ bundleId?: string; appName?: string }> {
  for (const infoPlistPath of [
    path.join(appBundlePath, 'Contents', 'Info.plist'),
    path.join(appBundlePath, 'Info.plist'),
  ]) {
    const info = await readPlistJson(infoPlistPath);
    const bundleId = readPlistString(info, 'CFBundleIdentifier');
    const displayName = readPlistString(info, 'CFBundleDisplayName');
    const bundleName = readPlistString(info, 'CFBundleName');
    if (bundleId || displayName || bundleName) {
      return {
        bundleId,
        appName: displayName ?? bundleName,
      };
    }
  }
  return {};
}

function readPlistString(info: Record<string, unknown> | null, key: string): string | undefined {
  const value = info?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
