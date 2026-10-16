import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { SurfaceScopedNodes } from '@agent-device/contracts/interaction';

/**
 * Mints the one baseline value a post-action comparison carries: the captured nodes together with the
 * surface they describe and the presentation the capture read (#2438, #3565).
 *
 * Both settle routes take their baseline from here — the element-targeted interaction route and the
 * generic daemon route (`scroll`/`back --settle`) — so a fact a capture established cannot be carried
 * by one route and dropped by the other. The pair sits beside {@link buildSnapshotState} because that
 * is the layer both routes can reach: the interaction route lives in `commands/`, the generic route in
 * `daemon/`, and the layering forbids the second from importing the first.
 *
 * One value, never two channels: every boundary that carries a baseline carries the type this returns,
 * so nodes cannot arrive without the surface they describe.
 */
export function surfaceScopedNodes(
  snapshot:
    | Pick<SnapshotState, 'nodes' | 'iosSystemSurfaceBundleId' | 'presentedSurface'>
    | undefined,
): SurfaceScopedNodes {
  return {
    nodes: snapshot?.nodes ?? [],
    ...(snapshot?.iosSystemSurfaceBundleId
      ? { surfaceBundleId: snapshot.iosSystemSurfaceBundleId }
      : {}),
    ...(snapshot?.presentedSurface ? { presentedSurface: snapshot.presentedSurface } : {}),
  };
}
