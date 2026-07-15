import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import { findProjectRoot, readVersion } from '../../utils/version.ts';
import {
  androidAdbResultError,
  installAndroidAdbPackage,
  pullAndroidAdbFile,
  type AndroidAdbExecutor,
  type AndroidAdbProvider,
} from './adb-executor.ts';

// Shared install/version-check/checksum lifecycle for the three Android helper APKs.

export type AndroidHelperInstallDecision = {
  packageName: string;
  versionCode: number;
  installedVersionCode?: number;
  installedSha256?: string;
  installed: boolean;
  reason: 'missing' | 'outdated' | 'mismatched' | 'unverifiable' | 'current';
};

export type InstalledAndroidHelperState = Pick<
  AndroidHelperInstallDecision,
  'installedVersionCode' | 'installedSha256' | 'reason'
>;

const ANDROID_HELPER_IDENTITY_TIMEOUT_MS = 10_000;

async function ensureAndroidHelperPackageInstalled(options: {
  adb: AndroidAdbExecutor;
  adbProvider: AndroidAdbProvider;
  packageName: string;
  versionCode: number;
  apkPath: string;
  sha256: string;
  cache: Set<string>;
  deviceKey: string;
  installTimeoutMs: number;
  helperLabel: string;
}): Promise<AndroidHelperInstallDecision> {
  const {
    adb,
    adbProvider,
    packageName,
    versionCode,
    apkPath,
    sha256,
    cache,
    deviceKey,
    installTimeoutMs,
    helperLabel,
  } = options;
  const cacheKey = `${deviceKey}\0${packageName}\0${versionCode}\0${sha256}`;
  if (cache.has(cacheKey)) {
    return {
      packageName,
      versionCode,
      installedSha256: sha256,
      installed: false,
      reason: 'current',
    };
  }
  await verifyAndroidHelperApkChecksum(apkPath, sha256, helperLabel);
  const state = await inspectInstalledAndroidHelper({
    adb,
    adbProvider,
    packageName,
    versionCode,
    sha256,
  });

  if (state.reason === 'current') {
    cache.add(cacheKey);
    return {
      packageName,
      versionCode,
      ...state,
      installed: false,
    };
  }

  const result = await installAndroidAdbPackage(apkPath, {
    provider: adbProvider,
    replace: true,
    allowTestPackages: true,
    allowFailure: true,
    timeoutMs: installTimeoutMs,
  });
  if (result.exitCode !== 0) {
    throw androidAdbResultError(`Failed to install ${helperLabel}`, result, {
      packageName,
      versionCode,
      reason: state.reason,
    });
  }
  cache.add(cacheKey);
  return {
    packageName,
    versionCode,
    ...state,
    installed: true,
  };
}

export async function inspectInstalledAndroidHelper(options: {
  adb: AndroidAdbExecutor;
  adbProvider: AndroidAdbProvider;
  packageName: string;
  versionCode: number;
  sha256: string;
}): Promise<InstalledAndroidHelperState> {
  const { adb, adbProvider, packageName, versionCode, sha256 } = options;
  const installedVersionCode = await readInstalledAndroidPackageVersionCode(adb, packageName);
  if (installedVersionCode === undefined) return { reason: 'missing' };
  if (installedVersionCode < versionCode) return { installedVersionCode, reason: 'outdated' };
  if (installedVersionCode > versionCode) return { installedVersionCode, reason: 'current' };

  try {
    const installedSha256 = await readInstalledAndroidPackageSha256(adb, adbProvider, packageName);
    return {
      installedVersionCode,
      installedSha256,
      reason: installedSha256 === sha256 ? 'current' : 'mismatched',
    };
  } catch {
    return { installedVersionCode, reason: 'unverifiable' };
  }
}

// Resolves an npm-bundled helper artifact: parses/validates its manifest, confirms the APK exists.
export async function resolveAndroidHelperArtifact<
  Manifest extends { assetName: string },
>(options: {
  helperDirName: string;
  manifestFileName: (version: string) => string;
  parseManifest: (value: unknown) => Manifest;
  unavailableMessage: string;
}): Promise<{ apkPath: string; manifest: Manifest }> {
  const version = readVersion();
  const helperDir = path.join(findProjectRoot(), 'android', options.helperDirName, 'dist');
  const manifestPath = path.join(helperDir, options.manifestFileName(version));
  try {
    const manifest = options.parseManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
    const apkPath = path.join(helperDir, manifest.assetName);
    await fs.access(apkPath);
    return { apkPath, manifest };
  } catch (error) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      options.unavailableMessage,
      { manifestPath, error: normalizeError(error).message },
      error,
    );
  }
}

// Binds cache/timeout/label once per helper to a one-line ensureAndroidXxxHelper.
export function makeEnsureAndroidHelperInstalled<
  Artifact extends {
    apkPath: string;
    manifest: { packageName: string; versionCode: number; sha256: string };
  },
>(params: {
  cache: Set<string>;
  installTimeoutMs: number;
  helperLabel: string;
}): (options: {
  adb: AndroidAdbExecutor;
  adbProvider: AndroidAdbProvider;
  artifact: Artifact;
  deviceKey: string;
}) => Promise<AndroidHelperInstallDecision> {
  return async (options) => {
    return await ensureAndroidHelperPackageInstalled({
      adb: options.adb,
      adbProvider: options.adbProvider,
      packageName: options.artifact.manifest.packageName,
      versionCode: options.artifact.manifest.versionCode,
      apkPath: options.artifact.apkPath,
      sha256: options.artifact.manifest.sha256,
      cache: params.cache,
      deviceKey: options.deviceKey,
      installTimeoutMs: params.installTimeoutMs,
      helperLabel: params.helperLabel,
    });
  };
}

async function readInstalledAndroidPackageVersionCode(
  adb: AndroidAdbExecutor,
  packageName: string,
): Promise<number | undefined> {
  const result = await adb(
    ['shell', 'cmd', 'package', 'list', 'packages', '--show-versioncode', packageName],
    { allowFailure: true, timeoutMs: 5_000 },
  );
  if (result.exitCode !== 0) return undefined;
  const match = new RegExp(
    `package:${escapeRegExp(packageName)}(?:\\s|$).*versionCode:(\\d+)`,
  ).exec(`${result.stdout}\n${result.stderr}`);
  return match ? Number(match[1]) : undefined;
}

async function readInstalledAndroidPackageSha256(
  adb: AndroidAdbExecutor,
  adbProvider: AndroidAdbProvider,
  packageName: string,
): Promise<string> {
  const pathResult = await adb(['shell', 'pm', 'path', packageName], {
    allowFailure: true,
    timeoutMs: ANDROID_HELPER_IDENTITY_TIMEOUT_MS,
  });
  const remotePath = readBaseApkPath(`${pathResult.stdout}\n${pathResult.stderr}`);
  if (pathResult.exitCode !== 0 || !remotePath) {
    throw new AppError('COMMAND_FAILED', 'Could not resolve installed Android helper APK');
  }

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-helper-'));
  const localPath = path.join(tempDirectory, 'base.apk');
  try {
    const pull = await pullAndroidAdbFile(remotePath, localPath, {
      provider: adbProvider,
      allowFailure: true,
      timeoutMs: ANDROID_HELPER_IDENTITY_TIMEOUT_MS,
    });
    if (pull.exitCode !== 0) {
      throw androidAdbResultError('Could not read installed Android helper APK', pull, {
        packageName,
        remotePath,
      });
    }
    return await sha256File(localPath);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

function readBaseApkPath(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => (line.startsWith('package:') ? line.slice('package:'.length).trim() : ''))
    .find((candidate) => candidate.endsWith('/base.apk'));
}

export async function verifyAndroidHelperApkChecksum(
  apkPath: string,
  expectedSha256: string,
  helperLabel: string,
): Promise<void> {
  const actual = await sha256File(apkPath);
  if (actual !== expectedSha256) {
    throw new AppError('COMMAND_FAILED', `${helperLabel} APK checksum mismatch`, {
      apkPath,
      expectedSha256,
      actualSha256: actual,
    });
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
