import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type {
  ReplayObservationAuthority,
  ReplayObservationCapture,
  ReplayObservationEvidence,
  ReplayRefPublicationProjection,
  ReplayRefPublicationResult,
} from '@agent-device/contracts/replay';
import { readSessionRuntimeRevision, refFrame } from './ref-frame.ts';
import type { RefFrame } from './ref-frame-slot.ts';
import { markSessionPartialRefsIssued, setSessionSnapshot } from './session-snapshot.ts';
import type { SessionRef, SessionState } from './session-state.ts';
import type { SessionStore } from './session-store.ts';

type InternalObservationLineage = Readonly<{
  ref: SessionRef;
  snapshot: SnapshotState;
  snapshotGeneration: number;
  runtimeRevision: number;
  refFrame: RefFrame;
}>;

const evidenceLineage = new WeakMap<object, InternalObservationLineage>();

type BoundInternalObservationSession = Readonly<{
  sessionStore: SessionStore;
  ref: SessionRef | undefined;
  signal?: AbortSignal;
}>;

/**
 * Bind observation authority to one already admitted, locked session. Callers
 * cannot address another session through the resulting capability, and engines
 * receive only opaque evidence values rather than this authority.
 */
export function bindInternalObservationAuthority(
  params: BoundInternalObservationSession,
): ReplayObservationAuthority {
  return {
    store: (snapshot) => storeInternalObservation(params, snapshot),
    finalize: (evidence, projection) =>
      finalizeClientRefPublication({
        ...params,
        evidence,
        projection,
      }),
  };
}

/**
 * Daemon-private capture finalization: update operational observation state
 * without activating, replacing, or expiring client ref authority.
 */
function storeInternalObservation(
  params: Pick<BoundInternalObservationSession, 'sessionStore' | 'ref'>,
  snapshot: SnapshotState,
): ReplayObservationCapture {
  const { sessionStore, ref } = params;
  if (!ref) {
    throw new Error('Internal observation session is no longer available.');
  }
  const session = sessionStore.requireCurrent(ref);
  setSessionSnapshot(session, snapshot);
  const snapshotGeneration = session.snapshotGeneration;
  if (snapshotGeneration === undefined) {
    throw new Error('Internal observation did not establish a snapshot generation.');
  }

  const evidence = {} as ReplayObservationEvidence;
  evidenceLineage.set(evidence, {
    ref,
    snapshot,
    snapshotGeneration,
    runtimeRevision: readSessionRuntimeRevision(session),
    refFrame: refFrame(session),
  });
  return { evidence, refsGeneration: snapshotGeneration };
}

/**
 * Paired synchronous publication finalizer. It activates exactly the refs
 * exposed by the already-projected inline response or successfully written
 * overflow artifact, and only while capture lineage is still current.
 *
 * No asynchronous work may occur after this returns `published: true` and
 * before the response returns to the client.
 */
function finalizeClientRefPublication(params: {
  sessionStore: SessionStore;
  ref: SessionRef | undefined;
  evidence: ReplayObservationEvidence;
  projection: ReplayRefPublicationProjection;
  signal?: AbortSignal;
}): ReplayRefPublicationResult {
  const lineage = evidenceLineage.get(params.evidence);
  // Evidence is a one-shot capability. Consume it before every outcome,
  // including empty, cancelled, invalid, and stale attempts, so request-end
  // finalization can never be retried into publication.
  evidenceLineage.delete(params.evidence);
  const refs = normalizeRefBodies(params.projection.refs);
  if (refs.size === 0) return { published: false, reason: 'empty' };
  if (params.signal?.aborted === true) return { published: false, reason: 'cancelled' };

  const session = lineage && resolveCurrentLineage(params, lineage);
  if (!lineage || !session) {
    return { published: false, reason: 'stale-capture' };
  }
  if (
    params.projection.refsGeneration !== lineage.snapshotGeneration ||
    !areProjectedRefsFromSnapshot(refs, lineage.snapshot)
  ) {
    return { published: false, reason: 'invalid-projection' };
  }

  markSessionPartialRefsIssued(session, refs);
  return {
    published: true,
    refsGeneration: lineage.snapshotGeneration,
    refCount: refs.size,
  };
}

function resolveCurrentLineage(
  params: Pick<BoundInternalObservationSession, 'sessionStore' | 'ref'>,
  lineage: InternalObservationLineage,
): SessionState | undefined {
  if (!params.ref || params.ref.lifetime !== lineage.ref.lifetime) return undefined;
  const current = params.sessionStore.resolveCurrent(params.ref);
  return current &&
    current.snapshot === lineage.snapshot &&
    current.snapshotGeneration === lineage.snapshotGeneration &&
    readSessionRuntimeRevision(current) === lineage.runtimeRevision &&
    refFrame(current) === lineage.refFrame
    ? current
    : undefined;
}

function normalizeRefBodies(refs: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const ref of refs) {
    const withoutAt = ref.startsWith('@') ? ref.slice(1) : ref;
    const suffix = withoutAt.indexOf('~');
    const body = suffix === -1 ? withoutAt : withoutAt.slice(0, suffix);
    if (body.length > 0) normalized.add(body);
  }
  return normalized;
}

function areProjectedRefsFromSnapshot(refs: ReadonlySet<string>, snapshot: SnapshotState): boolean {
  const capturedRefs = new Set(
    snapshot.nodes.flatMap((node) => (typeof node.ref === 'string' ? [node.ref] : [])),
  );
  return [...refs].every((ref) => capturedRefs.has(ref));
}
