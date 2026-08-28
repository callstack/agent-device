import path from 'node:path';
import type { LocalInstallSource } from '@agent-device/kernel/contracts';
import {
  isTrustedInstallSourceUrl,
  materializeInstallablePath,
} from '@agent-device/provision-kit/install-source';
import * as manifest from './manifest.ts';

export type PreparedAndroidInstallArtifact = {
  archivePath?: string;
  installablePath: string;
  packageName?: string;
  cleanup: () => Promise<void>;
};

export async function prepareAndroidInstallArtifact(
  source: LocalInstallSource,
  options?: { signal?: AbortSignal; resolveIdentity?: boolean },
): Promise<PreparedAndroidInstallArtifact> {
  const trustedUrlSource = source.kind === 'url' && isTrustedInstallSourceUrl(source.url);
  const materialized = await materializeInstallablePath({
    source,
    isInstallablePath: (candidatePath, stat) =>
      stat.isFile() && isAndroidInstallablePath(candidatePath),
    installableLabel: 'Android installable (.apk or .aab)',
    allowArchiveExtraction: source.kind !== 'url' || trustedUrlSource,
    signal: options?.signal,
  });
  try {
    const identity =
      options?.resolveIdentity === false
        ? {}
        : await inspectAndroidArtifactIdentity(materialized.installablePath, options?.signal);
    return {
      archivePath: materialized.archivePath,
      installablePath: materialized.installablePath,
      packageName: identity.packageName,
      cleanup: materialized.cleanup,
    };
  } catch (error) {
    await materialized.cleanup();
    throw error;
  }
}

function isAndroidInstallablePath(candidatePath: string): boolean {
  const extension = path.extname(candidatePath).toLowerCase();
  return extension === '.apk' || extension === '.aab';
}

async function inspectAndroidArtifactIdentity(
  installablePath: string,
  signal?: AbortSignal,
): Promise<{ packageName?: string }> {
  const extension = path.extname(installablePath).toLowerCase();
  if (extension !== '.apk' && extension !== '.aab') {
    return {};
  }
  const packageName = await manifest.resolveAndroidArchivePackageName(installablePath, signal);
  return {
    packageName,
  };
}
