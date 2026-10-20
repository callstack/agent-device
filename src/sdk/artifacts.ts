import { loadAndroidMechanics } from '../platform-runtime-android-mechanics.ts';
import { withSdkHost } from './host.ts';

type ResolveAndroidArchivePackageName =
  typeof import('@agent-device/platform-android/mechanics').resolveAndroidArchivePackageName;

export async function resolveAndroidArchivePackageName(
  ...args: Parameters<ResolveAndroidArchivePackageName>
): Promise<Awaited<ReturnType<ResolveAndroidArchivePackageName>>> {
  return await withSdkHost(async () => {
    const { resolveAndroidArchivePackageName: resolve } = await loadAndroidMechanics();
    return await resolve(...args);
  });
}
