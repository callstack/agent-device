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
    // #1076 versioned refs: the one-number generation is the pinning signal for
    // the refs above — cheap, and dropping it would strand auto-pinning clients.
    ...(data.refsGeneration !== undefined ? { refsGeneration: data.refsGeneration } : {}),
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
 * Token-cheap digest shared by the `find` and `get` commands. The ONLY token
 * sink in their results is the verbose matched `node`, which appears solely on a
 * selector READ (text / attrs). The view is deliberately CONSERVATIVE: it acts
 * only on a result that carries such a `node` and otherwise returns the data
 * UNCHANGED — so the cheap exists/wait/click results AND the mutating
 * `find fill` / `find focus` / `find type` interaction responses (which can
 * carry agent-critical signals like `warning` / `message`) are never silently
 * narrowed.
 *
 *   • a text read drops the redundant `node` — the `text` IS the answer;
 *   • an attrs read compacts the `node` to its semantic attributes only;
 *
 * In both cases every OTHER (cheap) field is preserved verbatim. `default` and
 * `full` return today's shape unchanged (nothing richer is computed yet).
 */
function selectorReadView(data: DaemonResponseData, level: ResponseLevel): DaemonResponseData {
  if (level !== 'digest') return data;
  const node = data.node;
  if (!node || typeof node !== 'object') return data;
  // A text read already carries the answer in `text`, so the node is redundant
  // framing — drop only the node and keep every other (cheap) field.
  if (typeof data.text === 'string') {
    const { node: _node, ...rest } = data;
    return rest;
  }
  // An attrs read: compact only the verbose node, keeping every other cheap field.
  return { ...data, node: compactSelectorNode(node as SnapshotNode) };
}

/**
 * Token-cheap settle digest for interaction commands (#1101). CONSERVATIVE:
 * only acts on a result that carries a `settle.diff` payload (the `--settle`
 * opt-in) and otherwise returns the data UNCHANGED, so plain interaction
 * responses stay byte-identical at every level. The digest keeps the verdict
 * fields and the changed-line COUNTS (`diff.summary`) plus `refsGeneration`,
 * and drops the diff line texts — the changed-count summary is the digest
 * answer; the lines are the default-level payload. `full` returns today's
 * shape unchanged (nothing richer is computed yet).
 */
function interactionSettleView(data: DaemonResponseData, level: ResponseLevel): DaemonResponseData {
  if (level !== 'digest') return data;
  const settle = data.settle;
  if (!settle || typeof settle !== 'object' || Array.isArray(settle)) return data;
  const { diff, ...rest } = settle as Record<string, unknown>;
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return data;
  const diffRecord = diff as Record<string, unknown>;
  const summary = diffRecord.summary;
  const refs = readSettleDigestRefs(diffRecord.lines);
  return {
    ...data,
    settle: {
      ...rest,
      ...(refs.length > 0 ? { refs } : {}),
      diff: { summary },
    },
  };
}

type DigestRef = { ref: string };

function readSettleDigestRefs(lines: unknown): DigestRef[] {
  if (!Array.isArray(lines)) return [];
  return lines.flatMap(readSettleDigestRef).slice(0, DIGEST_REF_LIMIT);
}

function readSettleDigestRef(line: unknown): DigestRef[] {
  const record = readObjectRecord(line);
  if (record?.kind !== 'added') return [];
  return readDigestRef(record.ref);
}

function readDigestRef(ref: unknown): DigestRef[] {
  return typeof ref === 'string' && ref.length > 0 ? [{ ref }] : [];
}

function readObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export const RESPONSE_VIEWS: Record<string, ResponseView> = {
  snapshot: snapshotView,
  screenshot: screenshotView,
  find: selectorReadView,
  get: selectorReadView,
  press: interactionSettleView,
  click: interactionSettleView,
  fill: interactionSettleView,
  longpress: interactionSettleView,
};
