import type { ResponseLevel } from '../kernel/contracts.ts';
import type { ScreenshotOverlayRef, SnapshotNode } from '../kernel/snapshot.ts';
import type { DaemonResponseData } from './types.ts';

/**
 * Phase 4 leveled response views. A view maps a command's `default` result data
 * to a leveled form. The router only calls a view when `responseLevel` is
 * `digest` or `full` AND a view is registered — so `default` (and every
 * unregistered command) is byte-identical to today (Maestro `.ad` recompare
 * safe). Views are pure functions of the default `data`.
 */
export type ResponseView = (data: DaemonResponseData, level: ResponseLevel) => DaemonResponseData;

const DIGEST_REF_LIMIT = 12;

/**
 * Token-cheap snapshot digest: the node count plus the first N actionable refs
 * (hittable and not occluded) with a label, and the cheap top-level signals
 * (`truncated`, `visibility`, `snapshotQuality`). The full node tree — the
 * dominant token sink — is dropped. `full` returns today's shape unchanged
 * (nothing richer is computed yet).
 */
function snapshotView(data: DaemonResponseData, level: ResponseLevel): DaemonResponseData {
  if (level !== 'digest') return data;
  const nodes = Array.isArray(data.nodes) ? (data.nodes as SnapshotNode[]) : [];
  const refs = nodes
    .filter((node) => node.hittable === true && node.interactionBlocked !== 'covered')
    .slice(0, DIGEST_REF_LIMIT)
    .map((node) => ({ ref: node.ref, label: node.label ?? node.value ?? node.identifier }));
  return {
    nodeCount: nodes.length,
    refs,
    truncated: data.truncated,
    ...(data.visibility !== undefined ? { visibility: data.visibility } : {}),
    ...(data.snapshotQuality !== undefined ? { snapshotQuality: data.snapshotQuality } : {}),
  };
}

const DIGEST_OVERLAY_LIMIT = 12;

/**
 * Token-cheap screenshot digest: the captured `path` (the primary result), the
 * total overlay-ref count, and the first N overlay refs leveled down to
 * `{ ref, label }`. The per-overlay geometry (`rect`/`overlayRect`/`center`) —
 * the token sink that `--overlay-refs` emits when many nodes are annotated — is
 * dropped and the list is capped. `artifacts` (the client's image-retrieval
 * handle, grafted on by request finalization) is preserved when present so the
 * screenshot stays fetchable. `full` returns today's shape unchanged (nothing
 * richer is computed yet).
 */
function screenshotView(data: DaemonResponseData, level: ResponseLevel): DaemonResponseData {
  if (level !== 'digest') return data;
  const overlays = Array.isArray(data.overlayRefs)
    ? (data.overlayRefs as ScreenshotOverlayRef[])
    : [];
  const overlayRefs = overlays
    .slice(0, DIGEST_OVERLAY_LIMIT)
    .map((overlay) => ({ ref: overlay.ref, label: overlay.label }));
  return {
    ...(typeof data.path === 'string' ? { path: data.path } : {}),
    overlayCount: overlays.length,
    overlayRefs,
    ...(data.artifacts !== undefined ? { artifacts: data.artifacts } : {}),
  };
}

export const RESPONSE_VIEWS: Record<string, ResponseView> = {
  snapshot: snapshotView,
  screenshot: screenshotView,
};
