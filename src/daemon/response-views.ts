import type { ResponseLevel } from '../contracts.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';
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

export const RESPONSE_VIEWS: Record<string, ResponseView> = {
  snapshot: snapshotView,
};
