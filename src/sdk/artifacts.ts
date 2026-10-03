import { loadAndroidMechanics } from '../platform-runtime-android-mechanics.ts';

type ResolveAndroidArchivePackageName =
  typeof import('@agent-device/platform-android/mechanics').resolveAndroidArchivePackageName;

export async function resolveAndroidArchivePackageName(
  ...args: Parameters<ResolveAndroidArchivePackageName>
): Promise<Awaited<ReturnType<ResolveAndroidArchivePackageName>>> {
  const { resolveAndroidArchivePackageName: resolve } = await loadAndroidMechanics();
  return await resolve(...args);
}
