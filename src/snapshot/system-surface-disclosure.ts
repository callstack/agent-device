import type { SnapshotState } from '../kernel/snapshot.ts';

/**
 * The one agent-facing explanation for an Android capture that faithfully shows an occluding
 * system surface (notification shade, quick settings) instead of app content. Shared by the
 * direct snapshot warning and every selector-backed consumer (find/wait/get/is), so the
 * disclosure cannot silently drop on one route while surviving on another.
 */
export const ANDROID_SYSTEM_SURFACE_DISCLOSURE =
  'A system surface (notification shade, quick settings, or another system overlay) covers the app, so this snapshot shows that surface. Interact with it or dismiss it (press back or swipe up) to reach app content.';

export function systemSurfaceDisclosure(
  snapshot: Pick<SnapshotState, 'systemSurfaceOnly'> | undefined,
): string | undefined {
  return snapshot?.systemSurfaceOnly === true ? ANDROID_SYSTEM_SURFACE_DISCLOSURE : undefined;
}
