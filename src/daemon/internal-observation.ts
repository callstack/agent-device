import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { readSessionRuntimeRevision } from './ref-frame.ts';
import { markSessionPartialRefsIssued, setSessionSnapshot } from './session-snapshot.ts';
import type { SessionState } from './types.ts';

declare const INTERNAL_OBSERVATION_EVIDENCE: unique symbol;

/**
 * Opaque capture lineage that engines may carry as data but cannot use to
 * publish refs. Only the daemon-owned finalizer in this module can resolve it.
 */
export type InternalObservationEvidence = {
  readonly [INTERNAL_OBSERVATION_EVIDENCE]: true;
};

type RefFrameLineage = Readonly<{
  state: SessionState['refFrameState'];
  scope: SessionState['refFrameScope'];
  tree: SessionState['refFrameTree'];
  generation: SessionState['refFrameGeneration'];
}>;

type InternalObservationLineage = Readonly<{
  sessionName: string;
  session: SessionState;
  sessionCreatedAt: number;
  snapshot: SnapshotState;
  snapshotGeneration: number;
  runtimeRevision: number;
  refFrame: RefFrameLineage;
}>;

const evidenceLineage = new WeakMap<object, InternalObservationLineage>();

type StoredInternalObservation = Readonly<{
  evidence: InternalObservationEvidence;
  refsGeneration: number;
}>;

type ClientRefPublicationProjection = Readonly<{
  refsGeneration: number | undefined;
  refs: readonly string[];
}>;

type ClientRefPublicationResult =
  | Readonly<{ published: true; refsGeneration: number; refCount: number }>
  | Readonly<{
      published: false;
      reason: 'empty' | 'cancelled' | 'stale-capture' | 'invalid-projection';
    }>;

type InternalObservationAuthority = Readonly<{
  store(snapshot: SnapshotState): StoredInternalObservation;
  finalize(
    evidence: InternalObservationEvidence,
    projection: ClientRefPublicationProjection,
  ): ClientRefPublicationResult;
}>;

type BoundInternalObservationSession = Readonly<{
  sessionStore: InternalObservationSessionStore;
  sessionName: string;
  signal?: AbortSignal;
}>;

type InternalObservationSessionStore = Readonly<{
  get: () => SessionState | undefined;
  update: (mutate: (session: SessionState) => void) => boolean;
}>;

/**
 * Bind observation authority to one already admitted, locked session. Callers
 * cannot address another session through the resulting capability, and engines
 * receive only opaque evidence values rather than this authority.
 */
export function bindInternalObservationAuthority(
  params: BoundInternalObservationSession,
): InternalObservationAuthority {
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
  params: Pick<BoundInternalObservationSession, 'sessionStore' | 'sessionName'>,
  snapshot: SnapshotState,
): StoredInternalObservation {
  const { sessionStore, sessionName } = params;
  let storedSession: SessionState | undefined;
  if (
    !sessionStore.update((session) => {
      setSessionSnapshot(session, snapshot);
      storedSession = session;
    }) ||
    !storedSession
  ) {
    throw new Error('Internal observation session is no longer available.');
  }
  const session = storedSession;
  const snapshotGeneration = session.snapshotGeneration;
  if (snapshotGeneration === undefined) {
    throw new Error('Internal observation did not establish a snapshot generation.');
  }

  const evidence = {} as InternalObservationEvidence;
  evidenceLineage.set(evidence, {
    sessionName,
    session,
    sessionCreatedAt: session.createdAt,
    snapshot,
    snapshotGeneration,
    runtimeRevision: readSessionRuntimeRevision(session),
    refFrame: readRefFrameLineage(session),
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
  sessionStore: InternalObservationSessionStore;
  sessionName: string;
  evidence: InternalObservationEvidence;
  projection: ClientRefPublicationProjection;
  signal?: AbortSignal;
}): ClientRefPublicationResult {
  const lineage = evidenceLineage.get(params.evidence);
  // Evidence is a one-shot capability. Consume it before every outcome,
  // including empty, cancelled, invalid, and stale attempts, so request-end
  // finalization can never be retried into publication.
  evidenceLineage.delete(params.evidence);
  const refs = normalizeRefBodies(params.projection.refs);
  if (refs.size === 0) return { published: false, reason: 'empty' };
  if (params.signal?.aborted === true) return { published: false, reason: 'cancelled' };

  if (!lineage || !isCurrentLineage(params, lineage)) {
    return { published: false, reason: 'stale-capture' };
  }
  if (
    params.projection.refsGeneration !== lineage.snapshotGeneration ||
    !areProjectedRefsFromSnapshot(refs, lineage.snapshot)
  ) {
    return { published: false, reason: 'invalid-projection' };
  }

  markSessionPartialRefsIssued(lineage.session, refs);
  return {
    published: true,
    refsGeneration: lineage.snapshotGeneration,
    refCount: refs.size,
  };
}

function isCurrentLineage(
  params: Pick<BoundInternalObservationSession, 'sessionStore' | 'sessionName'>,
  lineage: InternalObservationLineage,
): boolean {
  const current = params.sessionStore.get();
  return (
    params.sessionName === lineage.sessionName &&
    current === lineage.session &&
    current.createdAt === lineage.sessionCreatedAt &&
    current.snapshot === lineage.snapshot &&
    current.snapshotGeneration === lineage.snapshotGeneration &&
    readSessionRuntimeRevision(current) === lineage.runtimeRevision &&
    sameRefFrameLineage(readRefFrameLineage(current), lineage.refFrame)
  );
}

function readRefFrameLineage(session: SessionState): RefFrameLineage {
  return {
    state: session.refFrameState,
    scope: session.refFrameScope,
    tree: session.refFrameTree,
    generation: session.refFrameGeneration,
  };
}

function sameRefFrameLineage(left: RefFrameLineage, right: RefFrameLineage): boolean {
  return (
    left.state === right.state &&
    left.scope === right.scope &&
    left.tree === right.tree &&
    left.generation === right.generation
  );
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
