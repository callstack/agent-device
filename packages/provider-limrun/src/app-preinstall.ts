import type Limrun from '@limrun/api';
import type { LeaseLifecycleContext } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import type { LimrunAndroidSession } from './android.ts';
import {
  resolveInstalledAppIdForAsset,
  resolveLimrunAppAsset,
  type LimrunAppAsset,
} from './app-catalog.ts';
import { createLimrunDeviceSession } from './device-session.ts';
import type { LimrunIosSession } from './ios.ts';

export async function resolveRequestedLimrunAppAsset(
  limrun: Limrun,
  platform: 'android' | 'ios',
  context?: LeaseLifecycleContext,
): Promise<LimrunAppAsset | undefined> {
  const value = context?.flags?.providerApp;
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return undefined;
  return await resolveLimrunAppAsset(limrun, platform, name, context?.signal);
}

export async function resolvePreinstalledAppId(
  session: LimrunAndroidSession | LimrunIosSession,
  asset: LimrunAppAsset,
): Promise<string> {
  const deviceSession = createLimrunDeviceSession(session);
  const apps = await deviceSession.listApps('user-installed');
  const matchedAppId = resolveInstalledAppIdForAsset(asset.name, apps);
  if (matchedAppId) return matchedAppId;
  throw new AppError(
    'COMMAND_FAILED',
    `Limrun installed ${asset.name}, but its application identifier could not be resolved unambiguously.`,
    { asset: asset.name, installedApps: apps.map((app) => app.id) },
  );
}
