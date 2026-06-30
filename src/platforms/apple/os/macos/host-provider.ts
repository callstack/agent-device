import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppsFilter } from '../../../../contracts/app-inventory.ts';
import { AppError } from '../../../../kernel/errors.ts';
import { filterAppleAppsByBundlePrefix } from '../../core/app-filter.ts';
import type { IosAppInfo } from '../../core/app-info.ts';
import type {
  AppleMacOsHostProvider,
  AppleToolCommandExecutor,
} from '../../core/tool-provider-types.ts';

type ApplePlistJsonReader = (plistPath: string) => Promise<Record<string, unknown> | null>;

export function createLocalAppleMacOsHostProvider(
  runCommand: AppleToolCommandExecutor,
  readPlistJson: ApplePlistJsonReader,
): AppleMacOsHostProvider {
  return {
    openBundle: async (bundleId, url) => {
      await runCommand('open', buildMacOpenArgs(bundleId, url));
    },
    openTarget: async (target) => {
      await runCommand('open', [target]);
    },
    readClipboard: async () => {
      const result = await runCommand('pbpaste', [], { allowFailure: true });
      if (result.exitCode !== 0) {
        throw new AppError('COMMAND_FAILED', 'Failed to read macOS clipboard', {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }
      return result.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '');
    },
    writeClipboard: async (text) => {
      const result = await runCommand('pbcopy', [], {
        allowFailure: true,
        stdin: text,
      });
      if (result.exitCode !== 0) {
        throw new AppError('COMMAND_FAILED', 'Failed to write macOS clipboard', {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }
    },
    readDarkMode: async () => {
      const script =
        'tell application "System Events" to tell appearance preferences to get dark mode';
      const result = await runCommand('osascript', ['-e', script], { allowFailure: true });
      if (result.exitCode !== 0) {
        throw new AppError('COMMAND_FAILED', 'Failed to read macOS appearance', {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }
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
      const result = await runCommand('osascript', ['-e', script], { allowFailure: true });
      if (result.exitCode !== 0) {
        throw new AppError('COMMAND_FAILED', 'Failed to set macOS appearance', {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }
    },
    listApps: async (filter) => await listLocalMacApps(runCommand, readPlistJson, filter),
  };
}

function buildMacOpenArgs(bundleId: string, url?: string): string[] {
  const openArgs = ['-b', bundleId];
  if (url) {
    openArgs.push(url);
  }
  return openArgs;
}

async function listLocalMacApps(
  runCommand: AppleToolCommandExecutor,
  readPlistJson: ApplePlistJsonReader,
  filter: AppsFilter,
): Promise<IosAppInfo[]> {
  const appRoots = [
    '/Applications',
    '/System/Applications',
    path.join(os.homedir(), 'Applications'),
  ];
  const appPaths = new Set<string>();

  for (const root of appRoots) {
    const stat = await fs.stat(root).catch(() => null);
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
      } satisfies IosAppInfo;
    }),
  );

  return filterAppleAppsByBundlePrefix(
    apps
      .filter((app): app is IosAppInfo => app !== null)
      .sort((a, b) => a.name.localeCompare(b.name)),
    filter,
  );
}

async function readMacOsBundleInfo(
  appBundlePath: string,
  readPlistJson: ApplePlistJsonReader,
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
