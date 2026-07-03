import { createHash } from 'node:crypto';

/**
 * Stable, order-independent digest over an accessibility node array.
 *
 * Used to give agents cheap post-action evidence (see #1047) without paying the
 * token cost of a full follow-up snapshot: the daemon computes this digest from a
 * capture it already has to take, and returns only the ~50-byte digest string plus
 * a couple of counts instead of the serialized node tree.
 *
 * The digest is a multiset hash over each node's (type, label, identifier) tuple —
 * order-independent so it does not flip on harmless re-ordering (for example list
 * virtualization or AX tree re-traversal), but sensitive to any node being added,
 * removed, or relabeled. It intentionally ignores rects/indices/other volatile
 * fields so it doesn't false-positive on scroll offsets or layout jitter alone.
 *
 * Combination is done with XOR (commutative, so node order never matters) over a
 * fixed-size per-node hash, then folded through one more hash together with the
 * node count so two different multisets that happen to XOR to the same value
 * (extremely unlikely, but XOR alone is not collision-safe) still produce
 * different digests.
 */

export type AxDigestNode = {
  type?: string;
  label?: string;
  identifier?: string;
};

export type AxDigestResult = {
  digest: string;
  nodeCount: number;
};

const DIGEST_PREFIX = 'ax1:';
const PER_NODE_HASH_BYTES = 16;

export function computeAxDigest(nodes: readonly AxDigestNode[]): AxDigestResult {
  const combined = Buffer.alloc(PER_NODE_HASH_BYTES);
  for (const node of nodes) {
    xorInPlace(combined, hashNode(node));
  }
  const finalized = createHash('sha256')
    .update(combined)
    .update('\0')
    .update(String(nodes.length))
    .digest('hex')
    .slice(0, 16);
  return { digest: `${DIGEST_PREFIX}${finalized}`, nodeCount: nodes.length };
}

function hashNode(node: AxDigestNode): Buffer {
  return createHash('sha256')
    .update(node.type ?? '')
    .update('\0')
    .update(node.label ?? '')
    .update('\0')
    .update(node.identifier ?? '')
    .digest()
    .subarray(0, PER_NODE_HASH_BYTES);
}

function xorInPlace(target: Buffer, other: Buffer): void {
  for (let i = 0; i < target.length; i += 1) {
    target[i] = (target[i] ?? 0) ^ (other[i] ?? 0);
  }
}

/**
 * Node shape the evidence helpers below need beyond the digest tuple: `hittable`
 * to derive `interactiveNodeCount`, and `bundleId`/`appName` to derive
 * `foregroundApp` — both already present on `SnapshotNode` when the platform
 * backend reports them, so reading them here costs nothing extra.
 */
export type AxEvidenceNode = AxDigestNode & {
  hittable?: boolean;
  bundleId?: string;
  appName?: string;
};

export type AxEvidenceSummary = {
  digest: string;
  nodeCount: number;
  interactiveNodeCount: number;
  foregroundApp?: string;
};

/**
 * Summarizes one capture into the pieces `evidence` needs (see
 * src/contracts/interaction.ts: `InteractionEvidence`), without ever requiring
 * the caller to serialize the node array itself. `interactiveNodeCount` counts
 * nodes the platform did not mark `hittable: false` within the given capture —
 * cheap since it's a filter over nodes already in hand, no extra signal needed.
 * `foregroundApp` is only populated when the capture already carries an app
 * scope on its nodes (`bundleId`/`appName`); this never triggers a separate
 * appstate lookup.
 */
export function summarizeAxEvidence(nodes: readonly AxEvidenceNode[]): AxEvidenceSummary {
  const { digest, nodeCount } = computeAxDigest(nodes);
  const interactiveNodeCount = nodes.reduce(
    (count, node) => (node.hittable === false ? count : count + 1),
    0,
  );
  const foregroundApp = resolveForegroundApp(nodes);
  return {
    digest,
    nodeCount,
    interactiveNodeCount,
    ...(foregroundApp ? { foregroundApp } : {}),
  };
}

function resolveForegroundApp(nodes: readonly AxEvidenceNode[]): string | undefined {
  for (const node of nodes) {
    if (node.bundleId) return node.bundleId;
  }
  for (const node of nodes) {
    if (node.appName) return node.appName;
  }
  return undefined;
}
