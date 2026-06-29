import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInfoPlistString } from './plist.ts';
import { AppError } from '../../kernel/errors.ts';
import { runCmd } from '../../utils/exec.ts';
import {
  isTrustedInstallSourceUrl,
  materializeInstallablePath,
  type MaterializeInstallSource,
} from '../install-source.ts';

type InstallIosArtifactOptions = {
  appIdentifierHint?: string;
  signal?: AbortSignal;
};

type IosPayloadAppBundle = {
  installPath: string;
  bundleName: string;
  bundleId?: string;
  appName?: string;
};

export type PreparedIosInstallArtifact = {
  archivePath?: string;
  installablePath: string;
  bundleId?: string;
  appName?: string;
  cleanup: () => Promise<void>;
};

export async function prepareIosInstallArtifact(
  source: MaterializeInstallSource,
  options?: InstallIosArtifactOptions,
): Promise<PreparedIosInstallArtifact> {
  if (source.kind === 'url' && !isTrustedInstallSourceUrl(source.url)) {
    throw new AppError(
      'INVALID_ARGS',
      'iOS install_from_source URL sources are only supported for trusted artifact services such as GitHub Actions and EAS. Use a path source for other hosts.',
    );
  }
  const materialized = await materializeInstallablePath({
    source,
    isInstallablePath: (candidatePath, stat) =>
      (stat.isDirectory() && candidatePath.toLowerCase().endsWith('.app')) ||
      (stat.isFile() && candidatePath.toLowerCase().endsWith('.ipa')),
    installableLabel: 'iOS installable (.app or .ipa)',
    allowArchiveExtraction: source.kind !== 'url' || isTrustedInstallSourceUrl(source.url),
    signal: options?.signal,
  });

  let resolved: Awaited<ReturnType<typeof resolveIosInstallablePath>> | undefined;
  try {
    resolved = await resolveIosInstallablePath(materialized.installablePath, options);
    const resolvedInstallable = resolved;
    const bundleInfo = await readIosBundleInfo(resolvedInstallable.installPath);
    const archivePath =
      materialized.archivePath ??
      (materialized.installablePath.toLowerCase().endsWith('.ipa')
        ? materialized.installablePath
        : undefined);

    return {
      archivePath,
      installablePath: resolvedInstallable.installPath,
      bundleId: bundleInfo.bundleId,
      appName: bundleInfo.appName,
      cleanup: async () => {
        await resolvedInstallable.cleanup();
        await materialized.cleanup();
      },
    };
  } catch (error) {
    try {
      await resolved?.cleanup();
    } finally {
      await materialized.cleanup();
    }
    throw error;
  }
}

async function readIosBundleInfo(
  appBundlePath: string,
): Promise<{ bundleId?: string; appName?: string }> {
  const infoPlistPath = path.join(appBundlePath, 'Info.plist');
  const [bundleId, displayName, bundleName] = await Promise.all([
    readInfoPlistString(infoPlistPath, 'CFBundleIdentifier'),
    readInfoPlistString(infoPlistPath, 'CFBundleDisplayName'),
    readInfoPlistString(infoPlistPath, 'CFBundleName'),
  ]);
  return {
    bundleId,
    appName: displayName ?? bundleName,
  };
}

async function resolveIosInstallablePath(
  appPath: string,
  options?: InstallIosArtifactOptions,
): Promise<{ installPath: string; cleanup: () => Promise<void> }> {
  if (!appPath.toLowerCase().endsWith('.ipa')) {
    return { installPath: appPath, cleanup: async () => {} };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-ipa-'));
  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  };
  try {
    await runCmd('unzip', ['-q', appPath, '-d', tempDir]);
    const payloadDir = path.join(tempDir, 'Payload');
    const payloadEntries = await fs.readdir(payloadDir, { withFileTypes: true }).catch(() => {
      throw new AppError('INVALID_ARGS', 'Invalid IPA: missing Payload directory');
    });
    const appBundles: IosPayloadAppBundle[] = payloadEntries
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith('.app'))
      .map((entry) => ({
        installPath: path.join(payloadDir, entry.name),
        bundleName: entry.name.replace(/\.app$/i, ''),
      }));
    const appBundle = appBundles[0];
    if (appBundle !== undefined && appBundles.length === 1) {
      return { installPath: appBundle.installPath, cleanup };
    }
    if (appBundles.length === 0) {
      throw new AppError(
        'INVALID_ARGS',
        'Invalid IPA: expected at least one .app under Payload, found 0',
      );
    }

    await ensureIosPayloadBundleDetails(appBundles);
    const hint = options?.appIdentifierHint?.trim();
    if (hint) {
      const resolved = resolveIosPayloadBundleByHint(appBundles, hint);
      if (resolved) return { installPath: resolved.installPath, cleanup };
      throw new AppError(
        'INVALID_ARGS',
        `Invalid IPA: found ${appBundles.length} .app bundles under Payload and none matched "${hint}". Available bundles: ${appBundles.map(formatIosPayloadBundleDetails).join(', ')}`,
      );
    }

    throw new AppError(
      'INVALID_ARGS',
      `Invalid IPA: found ${appBundles.length} .app bundles under Payload. Pass an app identifier or bundle name matching one of: ${appBundles.map(formatIosPayloadBundleDetails).join(', ')}`,
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function ensureIosPayloadBundleDetails(bundles: IosPayloadAppBundle[]): Promise<void> {
  await Promise.all(
    bundles.map(async (bundle) => {
      if (bundle.bundleId && bundle.appName) return;
      const bundleInfo = await readIosBundleInfo(bundle.installPath);
      bundle.bundleId = bundle.bundleId ?? bundleInfo.bundleId;
      bundle.appName = bundle.appName ?? bundleInfo.appName;
    }),
  );
}

function resolveIosPayloadBundleByHint(
  bundles: IosPayloadAppBundle[],
  hint: string,
): IosPayloadAppBundle | undefined {
  const hintLower = hint.toLowerCase();
  const directNameMatches = bundles.filter(
    (bundle) => bundle.bundleName.toLowerCase() === hintLower,
  );
  if (directNameMatches.length === 1) return directNameMatches[0];
  if (directNameMatches.length > 1) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid IPA: multiple app bundles matched "${hint}" by name. Use a bundle id hint instead.`,
    );
  }

  if (hint.includes('.')) {
    const bundleIdMatches = bundles.filter(
      (bundle) => bundle.bundleId?.toLowerCase() === hintLower,
    );
    if (bundleIdMatches.length === 1) return bundleIdMatches[0];
  }

  return undefined;
}

function formatIosPayloadBundleDetails(bundle: IosPayloadAppBundle): string {
  const identity = bundle.bundleId ?? bundle.appName;
  if (identity) return `${bundle.bundleName}.app (${identity})`;
  return `${bundle.bundleName}.app`;
}
