import type Limrun from '@limrun/api';
import type { Asset } from '@limrun/api/resources/assets';
import { AppError } from '@agent-device/kernel/errors';

const APP_CATALOG_LIMIT = 1_000;

export type LimrunAppAsset = Readonly<{
  id: string;
  name: string;
}>;

type InstalledAppIdentity = Readonly<{ id: string; name?: string }>;

export function assertLimrunUploadedAppAccess(publicNetworkOnly: boolean | undefined): void {
  if (!publicNetworkOnly) return;
  throw new AppError(
    'UNAUTHORIZED',
    'Limrun uploaded apps are unavailable on the public daemon HTTP surface.',
  );
}

export async function listLimrunAppAssets(
  limrun: Limrun,
  platform: 'android' | 'ios',
  signal?: AbortSignal,
): Promise<readonly LimrunAppAsset[]> {
  signal?.throwIfAborted();
  const assets = await limrun.assets.list({ limit: APP_CATALOG_LIMIT }, { signal });
  signal?.throwIfAborted();
  const apps: LimrunAppAsset[] = [];
  for (const asset of assets) {
    const app = toAvailableAppAsset(asset, platform);
    if (app) apps.push(app);
  }
  return apps.sort((left, right) => left.name.localeCompare(right.name));
}

export async function resolveLimrunAppAsset(
  limrun: Limrun,
  platform: 'android' | 'ios',
  name: string,
  signal?: AbortSignal,
): Promise<LimrunAppAsset | undefined> {
  signal?.throwIfAborted();
  const assets = await limrun.assets.list(
    { limit: APP_CATALOG_LIMIT, nameFilter: name },
    { signal },
  );
  signal?.throwIfAborted();
  const matches = assets
    .filter((asset) => asset.name === name)
    .map((asset) => toAvailableAppAsset(asset, platform))
    .filter((asset): asset is LimrunAppAsset => asset !== undefined);
  if (matches.length <= 1) return matches[0];
  throw new AppError('COMMAND_FAILED', `Limrun returned multiple uploaded apps named ${name}.`, {
    app: name,
    platform,
    assetIds: matches.map((asset) => asset.id),
  });
}

export function resolveInstalledAppIdForAsset(
  assetName: string,
  apps: readonly InstalledAppIdentity[],
): string | undefined {
  const assetKey = appIdentityKey(
    assetName.replace(/\.(?:tar\.gz|tgz|tar|zip|ipa|apk)$/i, '').replace(/\.app$/i, ''),
  );
  if (assetKey.length < 5) return undefined;
  const candidates = apps.map((app) => ({ app, keys: appIdentityValues(app) }));
  const exact = candidates.filter(({ keys }) => keys.includes(assetKey));
  return exact.length === 1 ? exact[0]?.app.id : undefined;
}

function toAvailableAppAsset(
  asset: Asset,
  requestedPlatform: 'android' | 'ios',
): LimrunAppAsset | undefined {
  if (!asset.md5) return undefined;
  const platform = resolveAssetPlatform(asset);
  if (platform !== requestedPlatform) return undefined;
  return { id: asset.id, name: asset.name };
}

function resolveAssetPlatform(asset: Asset): 'android' | 'ios' | undefined {
  if (asset.os === 'android' || asset.os === 'ios') return asset.os;
  const name = asset.name.toLowerCase();
  if (name.endsWith('.apk')) return 'android';
  if (
    name.endsWith('.ipa') ||
    name.endsWith('.zip') ||
    name.endsWith('.tar') ||
    name.endsWith('.tar.gz') ||
    name.endsWith('.tgz')
  ) {
    return 'ios';
  }
  return undefined;
}

function appIdentityValues(app: InstalledAppIdentity): string[] {
  const terminalId = app.id.split(/[.:/]/).at(-1);
  return [app.id, terminalId, app.name]
    .filter((value): value is string => typeof value === 'string')
    .map(appIdentityKey);
}

function appIdentityKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '');
}
