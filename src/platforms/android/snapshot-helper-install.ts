import { readAndroidSnapshotHelperInstallOptions } from './snapshot-helper-artifact.ts';
import {
  inspectInstalledAndroidHelper,
  verifyAndroidHelperApkChecksum,
} from './helper-package-install.ts';
import {
  androidAdbResultError,
  installAndroidAdbPackage,
  type AndroidAdbExecutor,
  type AndroidAdbProvider,
} from './adb-executor.ts';
import type { AndroidSnapshotHelperInstallOptions } from './snapshot-helper-artifact.ts';
import type {
  AndroidSnapshotHelperArtifact,
  AndroidSnapshotHelperInstallPolicy,
  AndroidSnapshotHelperInstallResult,
} from './snapshot-helper-types.ts';

const installedSnapshotHelpers = new Map<string, number>();

export function forgetAndroidSnapshotHelperInstall(options: {
  deviceKey: string;
  packageName: string;
  versionCode: number;
}): void {
  const prefix = `${options.deviceKey}\0${options.packageName}\0${options.versionCode}\0`;
  for (const cacheKey of installedSnapshotHelpers.keys()) {
    if (cacheKey.startsWith(prefix)) forgetInstalledSnapshotHelper(cacheKey);
  }
}

// Tests reset the process-global install memo so cases do not share helper state.
export function resetAndroidSnapshotHelperInstallCache(): void {
  installedSnapshotHelpers.clear();
}

function getInstallCacheKey(
  deviceKey: string | undefined,
  packageName: string,
  versionCode: number,
  sha256: string,
): string | undefined {
  return deviceKey ? `${deviceKey}\0${packageName}\0${versionCode}\0${sha256}` : undefined;
}

function rememberInstalledSnapshotHelper(
  cacheKey: string | undefined,
  installedVersionCode: number,
): void {
  if (cacheKey) {
    installedSnapshotHelpers.set(cacheKey, installedVersionCode);
  }
}

function forgetInstalledSnapshotHelper(cacheKey: string | undefined): void {
  if (cacheKey) {
    installedSnapshotHelpers.delete(cacheKey);
  }
}

export async function ensureAndroidSnapshotHelper(options: {
  adb: AndroidAdbExecutor;
  adbProvider?: AndroidAdbProvider | AndroidAdbExecutor;
  artifact: AndroidSnapshotHelperArtifact;
  deviceKey?: string;
  installPolicy?: AndroidSnapshotHelperInstallPolicy;
  timeoutMs?: number;
}): Promise<AndroidSnapshotHelperInstallResult> {
  const { adb, artifact } = options;
  const installPolicy = options.installPolicy ?? 'missing-or-outdated';
  const packageName = artifact.manifest.packageName;
  const versionCode = artifact.manifest.versionCode;
  const sha256 = artifact.manifest.sha256;
  if (installPolicy === 'never') {
    return {
      packageName,
      versionCode,
      installed: false,
      reason: 'skipped',
    };
  }
  const installCacheKey = getInstallCacheKey(options.deviceKey, packageName, versionCode, sha256);
  const cachedVersionCode = installCacheKey
    ? installedSnapshotHelpers.get(installCacheKey)
    : undefined;
  if (installCacheKey && installPolicy !== 'always' && cachedVersionCode !== undefined) {
    return {
      packageName,
      versionCode,
      installedVersionCode: cachedVersionCode,
      installedSha256: sha256,
      installed: false,
      reason: 'current',
    };
  }
  await verifyAndroidHelperApkChecksum(artifact.apkPath, sha256, 'Android snapshot helper');
  const installedState =
    installPolicy === 'always'
      ? {
          installedVersionCode: await readInstalledVersionCode(adb, packageName, options.timeoutMs),
          reason: 'forced' as const,
        }
      : await inspectInstalledAndroidHelper({
          adb,
          adbProvider: normalizeAdbProvider(options.adbProvider, adb),
          packageName,
          versionCode,
          sha256,
        });
  const { installedVersionCode } = installedState;
  const installedSha256 =
    'installedSha256' in installedState ? installedState.installedSha256 : undefined;
  const reason = installedState.reason;

  if (reason === 'current') {
    if (installedVersionCode === undefined) {
      throw new Error('Expected installed versionCode for current Android snapshot helper');
    }
    rememberInstalledSnapshotHelper(installCacheKey, installedVersionCode);
    return {
      packageName,
      versionCode,
      installedVersionCode,
      installedSha256,
      installed: false,
      reason,
    };
  }

  const result = await installAndroidSnapshotHelper(
    adb,
    options.adbProvider ?? adb,
    artifact.apkPath,
    readAndroidSnapshotHelperInstallOptions(artifact.manifest),
    {
      packageName,
      timeoutMs: options.timeoutMs,
    },
  );
  if (result.exitCode !== 0) {
    forgetInstalledSnapshotHelper(installCacheKey);
    throw androidAdbResultError('Failed to install Android snapshot helper', result, {
      packageName,
      versionCode,
    });
  }

  rememberInstalledSnapshotHelper(installCacheKey, versionCode);
  return {
    packageName,
    versionCode,
    installedVersionCode,
    installedSha256,
    installed: true,
    reason,
  };
}

function normalizeAdbProvider(
  provider: AndroidAdbProvider | AndroidAdbExecutor | undefined,
  adb: AndroidAdbExecutor,
): AndroidAdbProvider {
  if (!provider) return { exec: adb };
  return typeof provider === 'function' ? { exec: provider } : provider;
}

async function readInstalledVersionCode(
  adb: AndroidAdbExecutor,
  packageName: string,
  timeoutMs: number | undefined,
): Promise<number | undefined> {
  const result = await adb(
    ['shell', 'cmd', 'package', 'list', 'packages', '--show-versioncode', packageName],
    {
      allowFailure: true,
      timeoutMs,
    },
  );
  if (result.exitCode === 0) {
    return parsePackageListVersionCode(`${result.stdout}\n${result.stderr}`, packageName);
  }
  return undefined;
}

async function installAndroidSnapshotHelper(
  adb: AndroidAdbExecutor,
  adbProvider: AndroidAdbProvider | AndroidAdbExecutor,
  apkPath: string,
  installOptions: AndroidSnapshotHelperInstallOptions,
  options: { packageName: string; timeoutMs?: number },
): Promise<Awaited<ReturnType<AndroidAdbExecutor>>> {
  const install = async () =>
    await installAndroidAdbPackage(apkPath, {
      allowFailure: true,
      provider: adbProvider,
      ...installOptions,
      timeoutMs: options.timeoutMs,
    });

  const result = await install();
  if (result.exitCode === 0 || !isInstallUpdateIncompatible(result)) {
    return result;
  }

  const uninstall = await adb(['uninstall', options.packageName], {
    allowFailure: true,
    timeoutMs: options.timeoutMs,
  });
  const retry = await install();
  if (retry.exitCode === 0) {
    return retry;
  }

  return {
    ...retry,
    stderr: [
      retry.stderr,
      uninstall.stderr
        ? `Previous uninstall stderr after INSTALL_FAILED_UPDATE_INCOMPATIBLE: ${uninstall.stderr}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function parsePackageListVersionCode(output: string, packageName: string): number | undefined {
  const packagePrefix = `package:${packageName}`;
  for (const line of output.split(/\r?\n/)) {
    if (
      !line.startsWith(packagePrefix) ||
      (line.length > packagePrefix.length && !/\s/.test(line[packagePrefix.length] ?? ''))
    ) {
      continue;
    }
    const match = /(?:^|\s)versionCode:(\d+)(?:\s|$)/.exec(line);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

function isInstallUpdateIncompatible(result: { stdout: string; stderr: string }): boolean {
  return `${result.stdout}\n${result.stderr}`.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE');
}
