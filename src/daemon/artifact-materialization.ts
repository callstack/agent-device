import fs from 'node:fs';
import path from 'node:path';
import {
  extractTarInstallableArtifact,
  readZipEntries,
  resolveTarArchiveRootName,
} from './artifact-archive.ts';
import { createArtifactTempDir, downloadArtifactToTempDir } from './artifact-download.ts';
import { readInfoPlistString } from '../platforms/ios/plist.ts';
import { AppError } from '../kernel/errors.ts';

export type MaterializeArtifactParams = {
  platform: 'ios' | 'android';
  url: string;
  headers?: Record<string, string>;
  requestId?: string;
};

export type MaterializedArtifact = {
  archivePath: string;
  installablePath: string;
  detected: {
    packageName?: string;
    bundleId?: string;
    appName?: string;
  };
};

export function cleanupMaterializedArtifact(result: MaterializedArtifact): void {
  fs.rmSync(path.dirname(result.archivePath), { recursive: true, force: true });
}

export async function materializeArtifact(
  params: MaterializeArtifactParams,
): Promise<MaterializedArtifact> {
  const tempDir = createArtifactTempDir(params.requestId);

  try {
    const download = await downloadArtifactToTempDir({
      url: params.url,
      headers: params.headers,
      requestId: params.requestId,
      tempDir,
    });

    return await resolveMaterializedArtifact({
      archivePath: download.archivePath,
      tempDir,
      platform: params.platform,
    });
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function resolveMaterializedArtifact(params: {
  archivePath: string;
  tempDir: string;
  platform: 'ios' | 'android';
}): Promise<MaterializedArtifact> {
  if (params.platform === 'android') {
    return await resolveAndroidArtifact(params.archivePath);
  }
  return await resolveIosArtifact(params.archivePath, params.tempDir);
}

async function resolveAndroidArtifact(archivePath: string): Promise<MaterializedArtifact> {
  const kind = await detectAndroidArtifactKind(archivePath);
  const normalizedArchivePath = normalizeArchiveExtension(
    archivePath,
    kind === 'aab' ? '.aab' : '.apk',
  );
  return {
    archivePath: normalizedArchivePath,
    installablePath: normalizedArchivePath,
    detected: detectAndroidMetadata(normalizedArchivePath),
  };
}

async function resolveIosArtifact(
  archivePath: string,
  tempDir: string,
): Promise<MaterializedArtifact> {
  const kind = await detectIosArtifactKind(archivePath);
  if (kind === 'app-tar') {
    const normalizedArchivePath = normalizeArchiveExtension(archivePath, '.tar', [
      '.tar',
      '.tgz',
      '.tar.gz',
    ]);
    const installablePath = await extractTarInstallableArtifact({
      archivePath: normalizedArchivePath,
      tempDir,
      platform: 'ios',
    });
    return {
      archivePath: normalizedArchivePath,
      installablePath,
      detected: await detectIosAppMetadata(installablePath),
    };
  }

  const normalizedArchivePath = normalizeArchiveExtension(archivePath, '.ipa');
  return {
    archivePath: normalizedArchivePath,
    installablePath: normalizedArchivePath,
    detected: await detectIosIpaMetadata(normalizedArchivePath),
  };
}

async function detectAndroidArtifactKind(archivePath: string): Promise<'apk' | 'aab'> {
  const extension = path.extname(archivePath).toLowerCase();
  if (extension === '.apk') return 'apk';
  if (extension === '.aab') return 'aab';

  const entries = await readZipEntries(archivePath);
  if (entries?.includes('BundleConfig.pb')) return 'aab';
  if (entries?.includes('AndroidManifest.xml')) return 'apk';

  throw new AppError(
    'INVALID_ARGS',
    `Android artifact URLs must resolve to .apk or .aab files, got "${path.basename(archivePath)}"`,
  );
}

async function detectIosArtifactKind(archivePath: string): Promise<'app-tar' | 'ipa'> {
  if (isTarLikePath(archivePath)) return 'app-tar';
  if (path.extname(archivePath).toLowerCase() === '.ipa') return 'ipa';

  try {
    await resolveTarArchiveRootName({ archivePath, platform: 'ios' });
    return 'app-tar';
  } catch {
    const entries = await readZipEntries(archivePath);
    if (entries?.some((entry) => /^Payload\/[^/]+\.app(\/|$)/.test(entry))) {
      return 'ipa';
    }
  }

  throw new AppError(
    'INVALID_ARGS',
    `iOS artifact URLs must resolve to .ipa or app bundle tar archives, got "${path.basename(archivePath)}"`,
  );
}

function detectAndroidMetadata(archivePath: string): MaterializedArtifact['detected'] {
  const appName = readBaseNameIfMeaningful(archivePath);
  return appName ? { appName } : {};
}

async function detectIosIpaMetadata(
  archivePath: string,
): Promise<MaterializedArtifact['detected']> {
  const entries = await readZipEntries(archivePath);
  const appEntry = entries?.find((entry) => /^Payload\/[^/]+\.app(\/|$)/.test(entry));
  if (!appEntry) {
    const appName = readBaseNameIfMeaningful(archivePath);
    return appName ? { appName } : {};
  }

  const appName = appEntry
    .replace(/^Payload\//, '')
    .split('/')[0]
    ?.replace(/\.app$/i, '');
  return appName ? { appName } : {};
}

async function detectIosAppMetadata(
  installablePath: string,
): Promise<MaterializedArtifact['detected']> {
  const bundleId = await readIosPlistValue(installablePath, 'CFBundleIdentifier');
  const displayName = await readIosPlistValue(installablePath, 'CFBundleDisplayName');
  const bundleName = await readIosPlistValue(installablePath, 'CFBundleName');
  const appName = displayName ?? bundleName ?? readBaseNameIfMeaningful(installablePath, '.app');

  return {
    ...(bundleId ? { bundleId } : {}),
    ...(appName ? { appName } : {}),
  };
}

async function readIosPlistValue(appBundlePath: string, key: string): Promise<string | undefined> {
  const infoPlistPath = path.join(appBundlePath, 'Info.plist');
  return await readInfoPlistString(infoPlistPath, key);
}

function readBaseNameIfMeaningful(filePath: string, suffix?: string): string | undefined {
  const basename = suffix
    ? path.basename(filePath, suffix)
    : path.basename(filePath, path.extname(filePath));
  return basename && basename !== 'artifact' ? basename : undefined;
}

function normalizeArchiveExtension(
  archivePath: string,
  desiredExtension: string,
  acceptedExtensions: string[] = [desiredExtension],
): string {
  const loweredPath = archivePath.toLowerCase();
  if (acceptedExtensions.some((extension) => loweredPath.endsWith(extension))) {
    return archivePath;
  }
  const normalizedPath = `${archivePath}${desiredExtension}`;
  try {
    fs.renameSync(archivePath, normalizedPath);
    return normalizedPath;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to normalize artifact path to ${desiredExtension}`,
      {
        from: archivePath,
        to: normalizedPath,
      },
      error instanceof Error ? error : undefined,
    );
  }
}

function isTarLikePath(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  return lowered.endsWith('.tar') || lowered.endsWith('.tgz') || lowered.endsWith('.tar.gz');
}
