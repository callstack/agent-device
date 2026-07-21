/**
 * Android status-bar/navigation-bar chrome identity, shared between the settle-chrome
 * classifier (`core/snapshot-chrome.ts`, #1198) and the helper content classifier
 * (`platforms/android/snapshot-content-recovery.ts`). SystemUI hosts BOTH persistent chrome
 * and actionable overlays (volume panel, media/output pickers, notification shade, quick
 * settings), so chrome is never a package-level fact: only the status/nav-bar window
 * subtree is chrome; every other systemui surface is real content.
 */
export const ANDROID_SYSTEM_CHROME_PACKAGE = 'com.android.systemui';

/**
 * Resource-ids of the status-bar / navigation-bar WINDOW containers. `status_bar` and
 * `navigation_bar` are matched as an id segment rather than a prefix so the shade's own
 * `split_shade_status_bar` container counts too — live-verified on Pixel 9 Pro XL API 37,
 * where an expanded shade hosts the status icons under exactly that id.
 *
 * Membership is decided ONCE, during the walk (`walkUiHierarchyNode`), which stamps
 * `systemChrome` on every descendant while the container is still in the tree. Consumers
 * read that flag; nothing downstream re-derives chrome identity from ids.
 */
export function isAndroidSystemChromeWindowResourceId(
  resourceId: string | null | undefined,
): boolean {
  const identifier = resourceId ?? '';
  if (!identifier.startsWith(`${ANDROID_SYSTEM_CHROME_PACKAGE}:id/`)) return false;
  const leaf = identifier.slice(`${ANDROID_SYSTEM_CHROME_PACKAGE}:id/`.length);
  return /(^|_)(status_bar|navigation_bar)/.test(leaf);
}
