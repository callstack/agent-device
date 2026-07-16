/**
 * Android status-bar/navigation-bar chrome markers, shared between the settle-chrome
 * classifier (`core/snapshot-chrome.ts`, #1198) and the helper content classifier
 * (`platforms/android/snapshot-content-recovery.ts`). SystemUI hosts BOTH persistent chrome
 * and actionable overlays (volume panel, media/output pickers, notification shade, quick
 * settings), so chrome is never a package-level fact: only these status/nav-bar marker
 * resource-ids classify as chrome; every other systemui surface is real content.
 */
export const ANDROID_SYSTEM_CHROME_PACKAGE = 'com.android.systemui';

const ANDROID_SYSTEM_CHROME_MARKER_PREFIXES = [
  'com.android.systemui:id/status_bar',
  'com.android.systemui:id/navigation_bar',
] as const;

/**
 * Surviving status-bar/nav-bar LEAF ids (#1251). The non-raw Android walk
 * (`walkUiHierarchyNode` in `platforms/android/ui-hierarchy.ts`) drops
 * unlabeled/unidentified structural nodes via `shouldIncludeStructuralAndroidNode`,
 * re-parenting their children upward — and that silently swallows every
 * `status_bar*`/`navigation_bar*` WRAPPER node, i.e. the only nodes the prefix
 * check above matches. A non-raw capture is left with just their labeled/
 * identified LEAVES (clock, battery, wifi/mobile icons, nav buttons), whose
 * own resource-ids carry no `status_bar`/`navigation_bar` prefix, so the run
 * loses its marker and `collectAndroidSystemChromeRunIndexes` stops dropping
 * it (verified against a real `--raw` vs. default capture pair of the same
 * screen). Recognize those leaves directly, by EXACT id — not prefix, to stay
 * tight: nothing here should ever swallow an actionable systemui overlay like
 * the volume dialog or a media/output picker, which live under unrelated ids.
 * `--raw` keeps the wrapper markers, so the prefix check above stays
 * load-bearing there.
 *
 * A more robust fix would thread the AOSP window-type constants
 * (`TYPE_STATUS_BAR` = 2000, `TYPE_NAVIGATION_BAR` = 2019) already parsed in
 * `readNodeAttributes` (ui-hierarchy.ts) through to the output `SnapshotNode`
 * and key off that instead of resource-ids — deferred until the id-based
 * approach here proves insufficient.
 */
const ANDROID_SYSTEM_CHROME_MARKER_LEAF_IDS: ReadonlySet<string> = new Set(
  [
    // status bar
    'clock',
    'battery',
    'statusIcons',
    'notificationIcons',
    'notification_icon_area',
    'system_icons',
    'cutout_space_view',
    'mobile_signal',
    'mobile_combo',
    'mobile_group',
    'wifi_signal',
    'wifi_combo',
    'wifi_group',
    'start_side_notif_and_chip_container',
    // nav bar
    'back',
    'home',
    'recent_apps',
    'home_handle',
  ].map((leaf) => `${ANDROID_SYSTEM_CHROME_PACKAGE}:id/${leaf}`),
);

/** True when the resource-id marks Android status-bar or navigation-bar chrome. */
export function isAndroidSystemChromeResourceId(resourceId: string | null | undefined): boolean {
  const identifier = resourceId ?? '';
  if (ANDROID_SYSTEM_CHROME_MARKER_LEAF_IDS.has(identifier)) return true;
  return ANDROID_SYSTEM_CHROME_MARKER_PREFIXES.some((prefix) => identifier.startsWith(prefix));
}
