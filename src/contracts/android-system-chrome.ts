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
 * This note previously proposed threading the AOSP window-type constants
 * (`TYPE_STATUS_BAR` = 2000, `TYPE_NAVIGATION_BAR` = 2019) through to the
 * output `SnapshotNode` and keying off those instead. Measured against the
 * helper XML on a live device (2026-07-21, emulator-5554, Pixel 9 Pro XL API
 * 37), that does not work and should not be attempted:
 *
 * - systemui reports `window-type=3` (`TYPE_SYSTEM`) both with the shade
 *   collapsed and fully expanded; `TYPE_STATUS_BAR` never appears at all;
 * - the helper stamps window metadata on window ROOT nodes only (1 of 169
 *   nodes in an expanded-shade capture), not per node;
 * - an expanded shade is ONE window hosting the status icons AND the
 *   quick-settings tiles, so no window-level signal separates them.
 *
 * The real constraint is upstream: the walk drops the `status_bar*` wrappers —
 * the only nodes that identify the region — and re-parents chrome leaves next
 * to unmarked chrome siblings that carry no id (`"Battery 100 percent."`, the
 * notification-icon summary). Everything here is reconstructing identity the
 * walk already discarded, which is why classification depends on capture
 * shape (#1318 raw vs #1319 interactive-only). See #1319 for the measured
 * dead ends and the provenance-preserving alternative.
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
