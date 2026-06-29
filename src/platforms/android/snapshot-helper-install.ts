import { AppError } from '../../kernel/errors.ts';
import {
  readAndroidSnapshotHelperInstallOptions,
  verifyAndroidSnapshotHelperArtifact,
} from './snapshot-helper-artifact.ts';
import {
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
  forgetInstalledSnapshotHelper(
    getInstallCacheKey(options.deviceKey, options.packageName, options.versionCode),
  );
}

export function resetAndroidSnapshotHelperInstallCache(): void {
  installedSnapshotHelpers.clear();
}

function getInstallCacheKey(
  deviceKey: string | undefined,
  packageName: string,
  versionCode: number,
): string | undefined {
  return deviceKey ? `${deviceKey}\0${packageName}\0${versionCode}` : undefined;
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
  if (installPolicy === 'never') {
    return {
      packageName,
      versionCode,
      installed: false,
      reason: 'skipped',
    };
  }
  const installCacheKey = getInstallCacheKey(options.deviceKey, packageName, versionCode);
  const cachedVersionCode = installCacheKey
    ? installedSnapshotHelpers.get(installCacheKey)
    : undefined;
  if (installCacheKey && installPolicy !== 'always' && cachedVersionCode !== undefined) {
    return {
      packageName,
      versionCode,
      installedVersionCode: cachedVersionCode,
      installed: false,
      reason: 'current',
    };
  }
  const installedVersionCode = await readInstalledVersionCode(adb, packageName, options.timeoutMs);
  const reason = getInstallReason(installPolicy, installedVersionCode, versionCode);

  if (reason === 'current') {
    if (installedVersionCode === undefined) {
      throw new Error('Expected installed versionCode for current Android snapshot helper');
    }
    rememberInstalledSnapshotHelper(installCacheKey, installedVersionCode);
    return {
      packageName,
      versionCode,
      installedVersionCode,
      installed: false,
      reason,
    };
  }

  await verifyAndroidSnapshotHelperArtifact(artifact);
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
    throw new AppError('COMMAND_FAILED', 'Failed to install Android snapshot helper', {
      packageName,
      versionCode,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }

  rememberInstalledSnapshotHelper(installCacheKey, versionCode);
  return {
    packageName,
    versionCode,
    installedVersionCode,
    installed: true,
    reason,
  };
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

function getInstallReason(
  installPolicy: AndroidSnapshotHelperInstallPolicy,
  installedVersionCode: number | undefined,
  requiredVersionCode: number,
): AndroidSnapshotHelperInstallResult['reason'] {
  if (installPolicy === 'never') {
    return 'skipped';
  }
  if (installPolicy === 'always') {
    return 'forced';
  }
  if (installedVersionCode === undefined) {
    return 'missing';
  }
  return installedVersionCode < requiredVersionCode ? 'outdated' : 'current';
}
