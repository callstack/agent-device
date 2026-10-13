// Input-surface ownership for both platforms: Android IME package provenance below, and the
// iOS keyboard role table (`IOS_KEYBOARD_*`) at the bottom. The iOS table lives HERE rather
// than in an ios-keyboard-ownership sibling because the eager-import closure gate
// (ADR-0027, eager-closure-budgets) requires shared symbols to sit in a module every entry
// that needs them already evaluates — a new static edge to a new module grows the daemon,
// replay-port, and capture-kit closures red. This module is that shared home: snapshot-chrome
// and tap-keyboard-occlusion already evaluate it, and renaming the published subpath would
// itself move every consumer's closure.

import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

export type AndroidInputOwner = 'app' | 'ime' | 'unknown';

const KNOWN_ANDROID_IME_PACKAGES = new Set([
  'com.google.android.inputmethod.latin',
  'com.samsung.android.honeyboard',
  'com.touchtype.swiftkey',
  'com.microsoft.swiftkey',
]);

export type AndroidInputOwnershipSource =
  | 'active-input-method'
  | 'active-input-method-resource'
  | 'known-ime-package'
  | 'known-ime-resource'
  | 'app';

export type AndroidInputOwnership = {
  inputMethodOwned: boolean;
  source: AndroidInputOwnershipSource;
};

export function classifyAndroidInputOwnership(options: {
  packageName: string | null | undefined;
  resourceId?: string | null | undefined;
  activeInputMethodPackage?: string | null | undefined;
}): AndroidInputOwnership {
  const packageName = normalizeAndroidPackageName(options.packageName);
  const resourceId = (options.resourceId ?? '').toLowerCase();
  const activeInputMethodPackage = normalizeAndroidPackageName(options.activeInputMethodPackage);

  if (packageName && activeInputMethodPackage && packageName === activeInputMethodPackage) {
    return { inputMethodOwned: true, source: 'active-input-method' };
  }
  if (activeInputMethodPackage && resourceId.startsWith(`${activeInputMethodPackage}:id/`)) {
    return { inputMethodOwned: true, source: 'active-input-method-resource' };
  }

  if (packageName && KNOWN_ANDROID_IME_PACKAGES.has(packageName)) {
    return { inputMethodOwned: true, source: 'known-ime-package' };
  }

  for (const knownPackageName of KNOWN_ANDROID_IME_PACKAGES) {
    if (resourceId.startsWith(`${knownPackageName}:id/`)) {
      return { inputMethodOwned: true, source: 'known-ime-resource' };
    }
  }

  return { inputMethodOwned: false, source: 'app' };
}

function isAndroidInputMethodOwned(
  packageName: string | null | undefined,
  resourceId?: string | null | undefined,
  activeInputMethodPackage?: string | null | undefined,
): boolean {
  return classifyAndroidInputOwnership({
    packageName,
    resourceId,
    activeInputMethodPackage,
  }).inputMethodOwned;
}

export function isAndroidInputMethodOwnedNode(options: {
  packageName: string | null | undefined;
  resourceId?: string | null | undefined;
  activeInputMethodPackage?: string | null | undefined;
}): boolean {
  return classifyAndroidInputOwnership(options).inputMethodOwned;
}

export function isAndroidInputMethodNode(
  node: Pick<RawSnapshotNode, 'bundleId' | 'identifier'>,
): boolean {
  return isAndroidInputMethodOwnedNode({
    packageName: node.bundleId,
    resourceId: node.identifier,
  });
}

export function isFallbackAndroidInputMethodPackage(
  packageName: string | null | undefined,
): boolean {
  const normalizedPackageName = normalizeAndroidPackageName(packageName);
  return Boolean(normalizedPackageName && KNOWN_ANDROID_IME_PACKAGES.has(normalizedPackageName));
}

export function isFallbackAndroidInputMethodResource(
  resourceId: string | null | undefined,
): boolean {
  const normalizedResourceId = (resourceId ?? '').toLowerCase();
  for (const packageName of KNOWN_ANDROID_IME_PACKAGES) {
    if (normalizedResourceId.startsWith(`${packageName}:id/`)) return true;
  }
  return false;
}

export function classifyAndroidInputOwner(
  packageName: string | null | undefined,
  resourceId?: string | null,
  activeInputMethodPackage?: string | null,
): AndroidInputOwner {
  if (!packageName && !resourceId) return 'unknown';
  return isAndroidInputMethodOwned(packageName, resourceId, activeInputMethodPackage)
    ? 'ime'
    : 'app';
}

export function readAndroidActiveInputMethodPackage(stdout: string): string | undefined {
  for (const pattern of [
    /\bmCurMethodId=([^\s]+)/i,
    /\bmCurId=([^\s]+)/i,
    /\bmCurrentInputMethodId=([^\s]+)/i,
    /\bcurMethodId=([^\s]+)/i,
  ]) {
    const match = stdout.match(pattern);
    const packageName = parseAndroidInputMethodPackage(match?.[1]);
    if (packageName) return packageName;
  }
  return undefined;
}

export function parseAndroidInputMethodPackage(
  value: string | null | undefined,
): string | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  const packageSegment = trimmed.split('/')[0] ?? '';
  const match = packageSegment.match(/[a-zA-Z0-9_.]+/);
  return normalizeAndroidPackageName(match?.[0]);
}

function normalizeAndroidPackageName(value: string | null | undefined): string | undefined {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized || undefined;
}

/**
 * iOS keyboard ownership — the `IOS_KEYBOARD_*` twin of the Android provenance above, shared
 * by the tap occlusion band (`tap-keyboard-occlusion.ts`) and the settle chrome classifier
 * (`@agent-device/capture-kit/snapshot-chrome`).
 *
 * The interactive projection flattens the keyboard surfaces beside app content, so ancestry
 * cannot reach them; each node still carries its producing UIKit class in `role`. The table is
 * exact class names only, so a near miss fails closed rather than widening what counts as
 * keyboard-owned (the same discipline the snapshot geometry policy applies to private UIKit
 * roles). Classes are locale-independent, unlike every label these nodes carry, and an app cannot
 * instantiate them.
 *
 * Four ownership shapes, because "produced by the keyboard" is not one question:
 * - {@link IOS_KEYBOARD_SURFACE_ROLES}: nodes the keyboard owns PER NODE, safe for geometry
 *   (occlusion band).
 * - {@link IOS_KEYBOARD_SETTLE_CHROME_ROLES}: per-node chrome for the settle classifier only —
 *   the QuickType prediction cell. Kept out of the surface table so a QuickType candidate never
 *   joins the occlusion band's geometry.
 * - {@link IOS_KEYBOARD_SUBTREE_CHROME_ROLES}: system-only hosts whose WHOLE subtree is
 *   keyboard chrome — the key plane and the prediction bar. An app can never fill these, so a
 *   subtree claim here cannot swallow app content.
 * - {@link IOS_KEYBOARD_CHROME_MARKER_ROLES}: hosts the app CAN also fill (its custom
 *   `inputView`, its `inputAssistantItem` bar buttons ride the assistant view). The marker is
 *   chrome itself and owns NO subtree: app content under it survives classification.
 */

/** Keyboard-owned per node; contributes geometry wherever the projection places it. */
export const IOS_KEYBOARD_SURFACE_ROLES: ReadonlySet<string> = new Set([
  'UIKeyboardDockItemButton',
  'UIAccessibilityElementKBKey',
]);

/** Per-node settle chrome beyond the surface table; never occlusion geometry. */
export const IOS_KEYBOARD_SETTLE_CHROME_ROLES: ReadonlySet<string> = new Set([
  'TUIPredictionViewCell',
]);

/** System-only keyboard hosts; their entire subtree is keyboard chrome. */
export const IOS_KEYBOARD_SUBTREE_CHROME_ROLES: ReadonlySet<string> = new Set([
  'UIKeyboardLayoutStar',
  'TUIPredictionView',
]);

/** Keyboard hosts the app can also fill: chrome itself, subtree left to the app. */
export const IOS_KEYBOARD_CHROME_MARKER_ROLES: ReadonlySet<string> = new Set([
  '_UIRemoteKeyboardPlaceholderView',
  'TUISystemInputAssistantView',
  'TUISystemInputAssistantPageView',
]);

/** True when this node's own UIKit class is one of `roles`. */
export function hasIosKeyboardRole(node: RawSnapshotNode, roles: ReadonlySet<string>): boolean {
  return node.role !== undefined && roles.has(node.role);
}
