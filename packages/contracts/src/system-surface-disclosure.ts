import type { SnapshotSystemSurface } from '@agent-device/contracts/snapshot-model';
import { iosSystemSurfaceDisclosure } from '@agent-device/contracts/ios-system-surface';

/**
 * The agent-facing explanation for an Android capture that faithfully shows an occluding system
 * surface (notification shade, quick settings) instead of app content.
 */
export const ANDROID_SYSTEM_SURFACE_DISCLOSURE =
  'A system surface (notification shade, quick settings, or another system overlay) covers the app, so this snapshot shows that surface. Interact with it or dismiss it (press back or swipe up) to reach app content.';

/**
 * The one agent-facing explanation for a capture that shows an occluding system surface, on every
 * platform. Every selector-backed consumer (find/wait/get/is) reads it from the stored capture, so
 * the disclosure cannot silently drop on one route while surviving on another.
 */
export function systemSurfaceDisclosure(
  surface: SnapshotSystemSurface | undefined,
): string | undefined {
  if (surface === undefined) return undefined;
  switch (surface.kind) {
    case 'android-system-overlay':
      return ANDROID_SYSTEM_SURFACE_DISCLOSURE;
    case 'web-auth':
    case 'payment':
      return iosSystemSurfaceDisclosure(surface.bundleId);
  }
}
