import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { summarizeAxEvidence } from '@agent-device/capture-kit/snapshot-evidence';
import type {
  InteractionEvidence,
  PostActionSurfaceChange,
  ResolvedInteractionTarget,
} from '@agent-device/contracts/interaction';
import { iosSystemSurfaceTransitionDisclosure } from '@agent-device/contracts/ios-system-surface';

/**
 * The surface question every post-action observation owes (#2438): iOS serves an in-place system
 * surface — a web sign-in sheet hosted out of the app's process — over a still-foreground app, so a
 * capture of the sheet and a capture of the app describe DIFFERENT surfaces. Comparing their node
 * digests yields a meaningless "changed" verdict, and diffing them presents a whole-surface
 * replacement as an in-surface diff, with refs.
 *
 * Both `--verify` and `--settle` route their comparison through this module, so the refusal and its
 * disclosure cannot hold on one route and drop on the other.
 */

/** One side of a post-action comparison: the nodes, and the surface the capture they came from described. */
export type SurfaceScopedNodes = {
  nodes: SnapshotNode[];
  /** Bundle id of the in-place iOS system surface; absent for ordinary app content. */
  surfaceBundleId?: string;
};

/** How a capture of ordinary app content names its surface in a {@link PostActionSurfaceChange}. */
const APP_SURFACE = 'app';

export function surfaceScopedNodes(snapshot: SnapshotState): SurfaceScopedNodes {
  return {
    nodes: snapshot.nodes,
    ...(snapshot.iosSystemSurfaceBundleId
      ? { surfaceBundleId: snapshot.iosSystemSurfaceBundleId }
      : {}),
  };
}

/** The resolution-time baseline as one value, or nothing when the resolution captured none. */
export function preActionBaseline(
  resolved: ResolvedInteractionTarget,
): SurfaceScopedNodes | undefined {
  const nodes = 'preActionNodes' in resolved ? resolved.preActionNodes : undefined;
  if (nodes === undefined) return undefined;
  return {
    nodes,
    ...(resolved.preActionSurfaceBundleId
      ? { surfaceBundleId: resolved.preActionSurfaceBundleId }
      : {}),
  };
}

/**
 * The transition between the two compared captures, or `undefined` when both describe the same
 * surface and an ordinary same-surface comparison is therefore valid. An absent baseline has no
 * surface to disagree with, so it reports no transition.
 */
export function resolvePostActionSurfaceChange(
  baseline: SurfaceScopedNodes | undefined,
  after: SurfaceScopedNodes,
): PostActionSurfaceChange | undefined {
  if (!baseline || baseline.surfaceBundleId === after.surfaceBundleId) return undefined;
  return {
    from: baseline.surfaceBundleId ?? APP_SURFACE,
    to: after.surfaceBundleId ?? APP_SURFACE,
    disclosure: iosSystemSurfaceTransitionDisclosure(after.surfaceBundleId),
  };
}

/**
 * `--verify` evidence for one post-action capture (#1047). Same surface: the digest comparison
 * against the pre-action baseline, as before. Cross-surface: no digest comparison is made — the
 * surface itself was replaced, which is a change by construction, and `surfaceChange` discloses
 * that this is what `changedFromBefore` reports.
 */
export function summarizePostActionEvidence(
  after: SurfaceScopedNodes,
  baseline: SurfaceScopedNodes | undefined,
): InteractionEvidence {
  const summary = summarizeAxEvidence(after.nodes);
  const surfaceChange = resolvePostActionSurfaceChange(baseline, after);
  if (surfaceChange) return { ...summary, changedFromBefore: true, surfaceChange };
  const changedFromBefore =
    baseline !== undefined && summary.digest !== summarizeAxEvidence(baseline.nodes).digest;
  return { ...summary, changedFromBefore };
}

/**
 * What `--settle` says instead of a diff it refuses to build: the transition itself, then the
 * observation the caller should take to read the surface that is now on screen.
 */
export function crossSurfaceSettleHint(change: PostActionSurfaceChange): string {
  return `${change.disclosure} The settled tree and the pre-action tree describe different surfaces (${change.from} → ${change.to}), so no settled diff or refs are shown; take a snapshot to read the current surface.`;
}
