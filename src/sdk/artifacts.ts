import path from 'node:path';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { loadAndroidMechanics } from '../platform-runtime-android-mechanics.ts';
import { withSdkHost } from './host.ts';

type ResolveAndroidArchivePackageName =
  typeof import('@agent-device/platform-android/mechanics').resolveAndroidArchivePackageName;

export async function resolveAndroidArchivePackageName(
  archivePath: string,
  host: HostEnvironment,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<ResolveAndroidArchivePackageName>>> {
  return await withSdkHost(host, async () => {
    const { resolveAndroidArchivePackageName: resolve } = await loadAndroidMechanics();
    return await resolve(path.resolve(host.cwd, archivePath), signal);
  });
}
