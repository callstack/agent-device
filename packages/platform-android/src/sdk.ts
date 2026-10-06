import path from 'node:path';
import {
  requireAndroidAdbHost,
  type AndroidAdbEnvironment,
  type AndroidAdbFileHost,
} from './adb-host.ts';

export type AndroidSdkEnvironment = AndroidAdbEnvironment;

const ANDROID_SDK_BIN_DIRS = [
  'emulator',
  'platform-tools',
  path.join('cmdline-tools', 'latest', 'bin'),
  path.join('cmdline-tools', 'tools', 'bin'),
] as const;

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function resolveAndroidSdkRoots(
  env: AndroidSdkEnvironment = requireAndroidAdbHost().environment,
  platform: NodeJS.Platform,
): string[] {
  const configuredRoot = env.ANDROID_SDK_ROOT?.trim();
  const configuredHome = env.ANDROID_HOME?.trim();
  const homeDir = env.HOME?.trim();
  // Android Studio installs the SDK here on macOS; the `Android/Sdk` layout is the Linux default.
  const studioRoot =
    platform === 'darwin' && homeDir ? path.join(homeDir, 'Library', 'Android', 'sdk') : '';
  const defaultRoot = homeDir ? path.join(homeDir, 'Android', 'Sdk') : '';
  return uniqueNonEmpty([configuredRoot ?? '', configuredHome ?? '', studioRoot, defaultRoot]);
}

export async function ensureAndroidSdkPathConfigured(
  env: AndroidSdkEnvironment = requireAndroidAdbHost().environment,
  files: Pick<AndroidAdbFileHost, 'isExecutable'> = requireAndroidAdbHost().files,
): Promise<void> {
  const existingDirs: string[] = [];
  let detectedRoot: string | undefined;

  const { hostPlatform } = await import('@agent-device/host-kit/process');
  for (const sdkRoot of resolveAndroidSdkRoots(env, hostPlatform())) {
    const presentDirs: string[] = [];
    for (const relativeDir of ANDROID_SDK_BIN_DIRS) {
      const candidate = path.join(sdkRoot, relativeDir);
      if (await files.isExecutable(candidate)) {
        presentDirs.push(candidate);
      }
    }
    if (presentDirs.length === 0) continue;
    if (!detectedRoot) {
      detectedRoot = sdkRoot;
    }
    existingDirs.push(...presentDirs);
  }

  if (detectedRoot) {
    env.ANDROID_SDK_ROOT = env.ANDROID_SDK_ROOT?.trim() || detectedRoot;
    env.ANDROID_HOME = env.ANDROID_HOME?.trim() || detectedRoot;
  }

  if (existingDirs.length === 0) return;

  const currentEntries = (env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  env.PATH = uniqueNonEmpty([...existingDirs, ...currentEntries]).join(path.delimiter);
}
