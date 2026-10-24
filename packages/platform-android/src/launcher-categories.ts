import type { DeviceTarget } from '@agent-device/kernel/device';

const ANDROID_LAUNCHER_CATEGORY = 'android.intent.category.LAUNCHER';
const ANDROID_LEANBACK_CATEGORY = 'android.intent.category.LEANBACK_LAUNCHER';

/**
 * What a launcher probe may be keyed on: the discovered `DeviceInfo` targets plus the `auto`
 * listing target. A target Android cannot run (desktop) reads the unknown-target probe order.
 */
type AndroidLauncherQuery = 'mobile' | 'tv' | 'auto' | DeviceTarget | undefined;

/**
 * Launcher categories whose MAIN activities count as launchable for a target, in probe order.
 * The first entry is the launch category. With `includeFallbackCategories` the list also carries
 * the secondary categories, which form the listing union and the launch fallback: a Fire OS app
 * can register under either TV launcher category, so a leanback-only probe misses LAUNCHER-only
 * apps, and an unknown-target probe keeps LAUNCHER first.
 */
export function androidLauncherCategories(
  target: AndroidLauncherQuery,
  options: { includeFallbackCategories?: boolean } = {},
): string[] {
  if (target === 'tv') {
    return options.includeFallbackCategories
      ? [ANDROID_LEANBACK_CATEGORY, ANDROID_LAUNCHER_CATEGORY]
      : [ANDROID_LEANBACK_CATEGORY];
  }
  if (target === 'mobile') {
    return [ANDROID_LAUNCHER_CATEGORY];
  }
  return options.includeFallbackCategories
    ? [ANDROID_LAUNCHER_CATEGORY, ANDROID_LEANBACK_CATEGORY]
    : [ANDROID_LAUNCHER_CATEGORY];
}

/** The category a launch for this target starts with, without any fallback categories. */
export function androidLaunchCategory(target: AndroidLauncherQuery): string {
  return androidLauncherCategories(target)[0]!;
}
