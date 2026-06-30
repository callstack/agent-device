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

// The cheap, agent-actionable scalar fields a `find` / `get` selector read can
// surface (across the exists / wait / text / attrs / click outcomes). Each is
// copied verbatim into a digest when present; the verbose matched `node` is the
// only token sink and is handled separately.
const SELECTOR_DIGEST_SCALAR_FIELDS = [
  'found',
  'ref',
  'selector',
  'text',
  'waitedMs',
  'locator',
  'query',
  'x',
  'y',
] as const;

// The semantic attributes of a single matched node an agent reasons about. The
// verbose framing a digest drops — geometry (`rect`), tree indices
// (`index`/`parentIndex`/`depth`), and process/app plumbing
// (`pid`/`bundleId`/`appName`/`windowTitle`/`surface`/…) — is intentionally absent.
const SELECTOR_DIGEST_NODE_FIELDS = [
  'role',
  'type',
  'subrole',
  'label',
  'value',
  'identifier',
  'enabled',
  'selected',
  'focused',
  'hittable',
] as const;

function compactSelectorNode(node: SnapshotNode): Record<string, unknown> {
  const compact: Record<string, unknown> = { ref: node.ref };
  for (const field of SELECTOR_DIGEST_NODE_FIELDS) {
    const value = node[field];
    if (value !== undefined) compact[field] = value;
  }
  return compact;
}

/**
 * Token-cheap digest shared by the `find` and `get` selector reads, whose wire
 * shapes overlap (`ref`/`selector` + `text` for a text read, `+ node` for an
 * attrs read, and the cheap `found`/`waitedMs`/coordinate signals). It keeps the
 * agent-actionable essentials and collapses the verbose matched `node`:
 *   • a text read drops `node` entirely — the `text` IS the answer;
 *   • an attrs read keeps a COMPACT node (semantic attributes only; geometry and
 *     internal tree/process plumbing dropped).
 * `full` returns today's shape unchanged (nothing richer is computed yet).
 */
function selectorReadView(data: DaemonResponseData, level: ResponseLevel): DaemonResponseData {
  if (level !== 'digest') return data;
  const digest: DaemonResponseData = {};
  for (const field of SELECTOR_DIGEST_SCALAR_FIELDS) {
    if (data[field] !== undefined) digest[field] = data[field];
  }
  // A text read already carries the answer in `text`, so the node is redundant
  // framing; an attrs read has no `text`, so keep a compacted node instead.
  if (typeof data.text !== 'string' && data.node && typeof data.node === 'object') {
    digest.node = compactSelectorNode(data.node as SnapshotNode);
  }
  return digest;
}

export const RESPONSE_VIEWS: Record<string, ResponseView> = {
  snapshot: snapshotView,
  screenshot: screenshotView,
  find: selectorReadView,
  get: selectorReadView,
};
