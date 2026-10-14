import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';

/**
 * Android status-bar/navigation-bar chrome identity, shared by the settle-chrome
 * classifier (`packages/capture-kit/src/snapshot-chrome.ts`) and the helper content classifier
 * (`packages/platform-android/src/snapshot-content-recovery.ts`). SystemUI also hosts actionable
 * overlays — volume panel, media pickers, the shade itself — so chrome is never a
 * package-level fact: only the status/nav-bar container's subtree is chrome.
 */
export const ANDROID_SYSTEM_CHROME_PACKAGE = 'com.android.systemui';

/** Persistent bar roots and shade/keyguard headers whose icon churn settle ignores. */
export function isAndroidSystemChromeWindowResourceId(
  resourceId: string | null | undefined,
): boolean {
  return (
    androidSystemBarMembership(ANDROID_SYSTEM_CHROME_PACKAGE, resourceId) !== undefined ||
    resourceId === 'com.android.systemui:id/split_shade_status_bar' ||
    resourceId === 'com.android.systemui:id/keyguard_status_bar'
  );
}

/**
 * Persistent bar container membership, separate from the broader settle-chrome predicate.
 * The expanded shade's `split_shade_status_bar` is a shade header, not a persistent bar.
 * Ownership is checked at every edge so a foreign or unknown-owner child cannot inherit it.
 */
export function androidSystemBarMembership(
  packageName: string | null | undefined,
  resourceId: string | null | undefined,
  ancestor?: Pick<RawSnapshotNode, 'bundleId' | 'systemBar'>,
): RawSnapshotNode['systemBar'] {
  if (
    packageName === 'com.android.launcher3' ||
    packageName === 'com.google.android.apps.nexuslauncher'
  ) {
    if (resourceId === `${packageName}:id/navbuttons_view`) return 'navigation';
    return ancestor?.bundleId === packageName && ancestor.systemBar === 'navigation'
      ? 'navigation'
      : undefined;
  }
  if (packageName !== ANDROID_SYSTEM_CHROME_PACKAGE) return undefined;
  switch (resourceId) {
    case 'com.android.systemui:id/status_bar':
    case 'com.android.systemui:id/status_bar_container':
    case 'com.android.systemui:id/status_bar_launch_animation_container':
      return 'status';
    case 'com.android.systemui:id/navigation_bar':
    case 'com.android.systemui:id/navigation_bar_frame':
      return 'navigation';
    default:
      return ancestor?.bundleId === packageName ? ancestor.systemBar : undefined;
  }
}

/** Android-internal settle provenance retained in daemon session snapshots only. */
export type AndroidSystemChromeProvenance = {
  systemChrome?: true;
};

export function hasAndroidSystemChromeProvenance(value: object): value is { systemChrome: true } {
  return 'systemChrome' in value && value.systemChrome === true;
}

/** Drops Android-internal provenance from a node embedded in a public response. */
export function stripAndroidSystemChromeProvenanceFromNode(node: SnapshotNode): SnapshotNode {
  if (!hasAndroidSystemChromeProvenance(node)) return node;
  const { systemChrome: _systemChrome, ...published } = node;
  return published;
}

/** Drops Android-internal provenance at the daemon's public snapshot seam. */
export function stripAndroidSystemChromeProvenance(nodes: SnapshotNode[]): SnapshotNode[] {
  if (!nodes.some(hasAndroidSystemChromeProvenance)) return nodes;
  return nodes.map(stripAndroidSystemChromeProvenanceFromNode);
}
