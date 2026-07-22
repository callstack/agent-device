import type { RawSnapshotNode, SnapshotNode } from '../kernel/snapshot.ts';

/**
 * Android status-bar/navigation-bar chrome identity, shared by the settle-chrome
 * classifier (`core/snapshot-chrome.ts`) and the helper content classifier
 * (`platforms/android/snapshot-content-recovery.ts`). SystemUI also hosts actionable
 * overlays — volume panel, media pickers, the shade itself — so chrome is never a
 * package-level fact: only the status/nav-bar container's subtree is chrome.
 */
export const ANDROID_SYSTEM_CHROME_PACKAGE = 'com.android.systemui';

/**
 * Resource-ids of the status-bar / navigation-bar WINDOW containers. Matched as an id
 * segment, not a prefix, so an expanded shade's `split_shade_status_bar` counts.
 */
export function isAndroidSystemChromeWindowResourceId(
  resourceId: string | null | undefined,
): boolean {
  const identifier = resourceId ?? '';
  if (!identifier.startsWith(`${ANDROID_SYSTEM_CHROME_PACKAGE}:id/`)) return false;
  const leaf = identifier.slice(`${ANDROID_SYSTEM_CHROME_PACKAGE}:id/`.length);
  return /(^|_)(status_bar|navigation_bar)(_|$)/.test(leaf);
}

/** Android-internal provenance retained in daemon session snapshots only. */
export type AndroidSystemChromeProvenance = {
  systemChrome?: true;
};

export type AndroidSystemChromeRawSnapshotNode = RawSnapshotNode & AndroidSystemChromeProvenance;

export function hasAndroidSystemChromeProvenance(node: RawSnapshotNode): boolean {
  return (node as AndroidSystemChromeRawSnapshotNode).systemChrome === true;
}

/** Drops Android-internal provenance before snapshot nodes cross a public boundary. */
export function publicAndroidSnapshotNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  if (!nodes.some((node) => Object.hasOwn(node, 'systemChrome'))) return nodes;
  return nodes.map((node) => {
    if (!Object.hasOwn(node, 'systemChrome')) return node;
    const { systemChrome: _systemChrome, ...published } = node as SnapshotNode &
      AndroidSystemChromeProvenance;
    return published;
  });
}
