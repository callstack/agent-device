import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import type { SurfaceScopedNodes } from '@agent-device/contracts/interaction';
import type { SnapshotPresentation } from '@agent-device/kernel/snapshot';

/** Reproduce a populated baseline's view; without one, capture the interactive view. */
export function postActionPresentation(
  baseline: SurfaceScopedNodes | undefined,
): SnapshotPresentation {
  return baseline?.presentation ?? (baseline?.nodes.length ? {} : { interactiveOnly: true });
}

/**
 * Mints the one baseline value a post-action comparison carries: the captured nodes together with the
 * surface they describe, the presentation the capture read (#2438, #3565), and the view it was read
 * in (#4486).
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
    | Pick<
        SnapshotState,
        'nodes' | 'iosSystemSurfaceBundleId' | 'presentedSurface' | 'presentation'
      >
    | undefined,
): SurfaceScopedNodes {
  return {
    nodes: snapshot?.nodes ?? [],
    ...(snapshot?.iosSystemSurfaceBundleId
      ? { surfaceBundleId: snapshot.iosSystemSurfaceBundleId }
      : {}),
    ...(snapshot?.presentedSurface ? { presentedSurface: snapshot.presentedSurface } : {}),
    ...(snapshot?.presentation ? { presentation: snapshot.presentation } : {}),
  };
}

/**
 * The pre-action tree a settle diff runs against, and through its `presentation` the view the settle
 * captures in (#4486). Two trees compare only within one presentation, and the agent's view is the
 * presentation of the ref frame it last read: `snapshot -i`, a full `snapshot`, a scoped one, or the
 * refs a settle issued. So the first candidate read in that view answers. A candidate read in another
 * view, such as a selector resolution that fell back to the full tree or a full tree a selector read
 * stored, is skipped, and the frame itself answers when no candidate qualifies. Without a frame, the
 * first candidate answers.
 *
 * Every settle route picks its baseline here, so none can compare an interactive read with a full one.
 */
export async function postActionBaseline(params: {
  /** The ref frame, as the caller admits it as a baseline. */
  frame: SurfaceScopedNodes | undefined;
  /** Pre-action trees in the caller's order of preference. */
  candidates: readonly (SurfaceScopedNodes | undefined)[];
}): Promise<SurfaceScopedNodes> {
  const { isSameSnapshotPresentation } = await import('@agent-device/kernel/snapshot');
  const { frame } = params;
  const view = frame && frame.nodes.length > 0 ? frame.presentation : undefined;
  const candidate = params.candidates.find(
    (baseline) =>
      baseline !== undefined &&
      baseline.nodes.length > 0 &&
      (!frame?.nodes.length || isSameSnapshotPresentation(baseline.presentation, view)),
  );
  return candidate ?? frame ?? { nodes: [] };
}
