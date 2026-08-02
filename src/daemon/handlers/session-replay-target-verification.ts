import type { ResponseLevel } from '@agent-device/kernel/contracts';
import type { DaemonError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { displayLabel, formatRole } from '../../snapshot/snapshot-lines.ts';
import {
  annotationLocalIdentity,
  collectReplayScrubbableVarValues,
  formatDivergenceActionLabel,
  resolveReplayAction,
  type LocalIdentity,
  type ReplayVarScope,
} from '@agent-device/ad-script';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import {
  deriveReplayTargetGuardMismatchEvidence,
  deriveWaitLandmarkMismatchEvidence,
  planPostResolutionTargetVerification,
  planPreDispatchTargetVerification,
  type ReplayPostDispatchMismatchEvidence,
  type ReplaySelectorPort,
} from '@agent-device/ad-replay';
import {
  createReplayDivergenceSanitizer,
  type ReplayDivergence,
  type ReplayDivergenceTargetBindingKind,
  type ReplayDivergenceTargetCandidate,
  type ReplayDivergenceTargetIdentity,
} from '@agent-device/contracts/divergence';
import {
  readNodeStructuralDenotation,
  REPLAY_TARGET_GUARD_MISMATCH_REASON,
  WAIT_LANDMARK_MISMATCH_REASON,
  type ReplayTargetGuardDenotation,
} from '../../replay/target-identity-node.ts';
import { resolveTargetIdentityVerification } from '../../core/command-descriptor/registry.ts';
import { parseWaitPositionals } from '../../core/wait-positionals.ts';
import type { DaemonResponse, SessionAction } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import type { ReplayResumeStamper } from '../session-replay-coordinator.ts';
import type { InternalObservationEvidence } from '../internal-observation.ts';
import { boundedLocalIdentity } from '../session-target-evidence.ts';
import {
  buildDivergenceScreen,
  captureDivergenceObservation,
  resolveSuggestionMatchingConfig,
  toReplayRepairHintCapture,
} from './session-replay-divergence.ts';
import { boundReplayDivergenceForSession } from './session-replay-divergence-publication.ts';
import {
  computeReplayRepairHint,
  type ReplayRepairHintCapture,
} from './session-replay-repair-hint.ts';
import { buildReplayDivergenceFailureResponse } from './session-replay-runtime-failure-response.ts';
import { buildAndPersistReplayDivergenceResume } from './session-replay-resume.ts';
import { classifyReplayTarget } from './session-replay-target-classification.ts';
import { extractReplayTargetToken, readRefLabel } from './session-replay-target-token.ts';

// ---------------------------------------------------------------------------
// Daemon-level orchestration: capture, session, wire shaping.
// ---------------------------------------------------------------------------

/**
 * Post-resolution guard payload for a verified action: dispatch re-resolves
 * with its own occlusion/visibility guards, and its winner must carry
 * `expected` (the verified member's identity) or the interaction layer
 * refuses pre-action (`assertExpectedResolvedTarget`, resolution.ts).
 * `matchCount` is verification's recorded-selector match count, carried so
 * the resulting identity-mismatch divergence satisfies decision 3's
 * matchCount presence rule.
 */
export type ReplayVerifiedTargetGuard = {
  expected: ReplayTargetGuardDenotation;
  matchCount: number;
};

export type ReplayTargetVerificationOutcome =
  | {
      verified: true;
      guard?: ReplayVerifiedTargetGuard;
      /**
       * #1349 post-resolution phase (`wait`): the recorded landmark to thread
       * into the command's own resolution (`internal.replayLandmarkGuard`).
       * `verified: true` here means only "nothing to refuse pre-dispatch" —
       * the identity check runs inside the wait's polling loop, and the step
       * loop converts its timeout refusal into an identity-mismatch
       * divergence (`buildWaitLandmarkMismatchResponse`).
       */
      deferredLandmark?: TargetAnnotationV1;
    }
  | { verified: false; response: DaemonResponse };

type TargetBindingDivergenceContext = {
  recorded: TargetAnnotationV1;
  action: SessionAction;
  step: number;
  sourcePath: string;
  sourceLine: number;
  replayPath: string;
  artifactPaths: string[];
  sessionName: string;
  sessionStore: SessionStore;
  /** #1478 P4b: the request's bound resume-stamping capability — never a second-constructed coordinator. */
  resumeStamper: ReplayResumeStamper;
  responseLevel: ResponseLevel | undefined;
  scrubVars: ReturnType<typeof collectReplayScrubbableVarValues>;
  /** ADR 0012 step 5: the full top-level plan + its digest, for `resume`. */
  planActions: SessionAction[];
  planDigest: string;
  signal?: AbortSignal;
};

type TargetBindingDivergenceBuilt = {
  kind: ReplayDivergenceTargetBindingKind;
  matchCount: number | undefined;
  observed: LocalIdentity | undefined;
  candidateNodes: SnapshotNode[];
  mismatches: string[];
  causeCode: string;
  causeMessage: string;
  causeHint?: string;
  screen: ReplayDivergence['screen'];
  publicationEvidence?: InternalObservationEvidence;
  /** ADR 0012 decision 6, R3: the same capture `screen` was built from, for the `repairHint` container test. */
  repairCapture: ReplayRepairHintCapture;
};

/** The one wire-shaping path for every target-binding divergence (pre-action and post-resolution guard). */
function buildTargetBindingDivergenceResponse(
  context: TargetBindingDivergenceContext,
  built: TargetBindingDivergenceBuilt,
): DaemonResponse {
  const {
    recorded,
    action,
    step,
    sourcePath,
    sourceLine,
    replayPath,
    artifactPaths,
    sessionName,
    sessionStore,
    resumeStamper,
    responseLevel,
    scrubVars,
    planActions,
    planDigest,
  } = context;
  const sanitize = createReplayDivergenceSanitizer(scrubVars);
  const targetBinding = {
    classification: built.kind,
    ...(built.matchCount !== undefined ? { matchCount: built.matchCount } : {}),
    recorded: sanitizeIdentity(annotationLocalIdentity(recorded), sanitize),
    ...(built.observed ? { observed: sanitizeIdentity(built.observed, sanitize) } : {}),
    mismatches: built.mismatches.slice(0, 5).map((entry) => sanitize(entry)),
    candidates: built.candidateNodes.slice(0, 5).map((node) => describeCandidate(node, sanitize)),
  };
  // Computed before `resume` so its `from` ordinal (decision 6, R2:
  // `record-and-heal` resumes at `step + 1`) agrees with the hint.
  const repairHint = computeReplayRepairHint({
    kind: built.kind,
    targetEvidence: recorded,
    capture: built.repairCapture,
  });
  const resume = buildAndPersistReplayDivergenceResume({
    failedIndex: step,
    actions: planActions,
    planDigest,
    repairHint,
    resumeStamper,
  });

  const divergence: ReplayDivergence = {
    version: 1,
    kind: built.kind,
    step: { index: step, source: { path: sanitize(sourcePath), line: sourceLine } },
    action: sanitize(formatDivergenceActionLabel(action)),
    cause: {
      code: built.causeCode,
      message: sanitize(built.causeMessage),
      ...(built.causeHint ? { hint: sanitize(built.causeHint) } : {}),
    },
    screen: built.screen,
    suggestions: [],
    suggestionCount: 0,
    // ADR 0012 migration step 5 (PR #1211 machinery): a target-binding
    // divergence fires PRE-ACTION, so the failed step itself was never
    // executed — resuming AT `step` re-runs exactly the action that did not
    // send (unless `repairHint` is `record-and-heal`, in which case the agent
    // performs it manually and `buildReplayDivergenceResume` targets `step +
    // 1` instead). Generic `.ad` actions have no runtime variable producers
    // or control wrappers, so the reported ordinal is resumable. This is the
    // only resume site for target-binding divergences.
    resume,
    repairHint,
    targetBinding,
  };
  const bounded = boundReplayDivergenceForSession({
    sessionStore,
    sessionName,
    divergence,
    responseLevel,
    evidence: built.publicationEvidence,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const cause: DaemonError = { code: built.causeCode, message: built.causeMessage };
  return buildReplayDivergenceFailureResponse({
    error: cause,
    action,
    step,
    replayPath,
    artifactPaths,
    divergence: bounded,
    scrubVars,
  });
}

type ReplayTargetDivergenceParams = {
  action: SessionAction;
  scope: ReplayVarScope;
  sourcePath: string;
  sourceLine: number;
  replayPath: string;
  step: number;
  sessionName: string;
  sessionStore: SessionStore;
  /** #1478 P4b: the request's bound resume-stamping capability — never a second-constructed coordinator. */
  resumeStamper: ReplayResumeStamper;
  logPath: string;
  artifactPaths: string[];
  responseLevel: ResponseLevel | undefined;
  planActions: SessionAction[];
  planDigest: string;
  signal?: AbortSignal;
  port: ReplaySelectorPort;
};

export async function verifyReplayActionTarget(
  params: ReplayTargetDivergenceParams,
): Promise<ReplayTargetVerificationOutcome> {
  const {
    action,
    scope,
    sourcePath,
    sourceLine,
    replayPath,
    step,
    sessionName,
    sessionStore,
    resumeStamper,
    logPath,
    artifactPaths,
    responseLevel,
    planActions,
    planDigest,
    signal,
    port,
  } = params;

  const recorded = action.targetEvidence;
  if (!recorded) return { verified: true };

  const session = sessionStore.get(sessionName);
  if (!session) return { verified: true };

  // Resolved ONLY to extract the match token below — never serialized onto
  // the wire (the response is always built from the ORIGINAL `action`, like
  // every other replay divergence, so an expanded `${VAR}` never leaks
  // through an un-scrubbed positional).
  const resolvedAction = resolveReplayAction(action, scope, { file: sourcePath, line: sourceLine });

  const scrubVars = collectReplayScrubbableVarValues(scope);
  const sanitize = createReplayDivergenceSanitizer(scrubVars);
  const context: TargetBindingDivergenceContext = {
    recorded,
    action,
    step,
    sourcePath,
    sourceLine,
    replayPath,
    artifactPaths,
    sessionName,
    sessionStore,
    resumeStamper,
    responseLevel,
    scrubVars,
    planActions,
    planDigest,
    signal,
  };
  const buildRecordedUnverifiableResponse = async (): Promise<DaemonResponse> => {
    // Decision 3 path 1: a recorded-`unverifiable` annotation fires before
    // any resolution — matchCount is omitted (never computed).
    const observation = await captureDivergenceObservation({
      session,
      sessionName,
      sessionStore,
      logPath,
      action,
    });
    return buildTargetBindingDivergenceResponse(context, {
      kind: 'identity-unverifiable',
      matchCount: undefined,
      observed: undefined,
      candidateNodes: [],
      mismatches: [],
      causeCode: 'IDENTITY_UNVERIFIABLE',
      causeMessage:
        'The recorded target evidence could not verify itself when it was captured (a structural capture anomaly), so replay cannot trust it before acting.',
      screen: buildDivergenceScreen(observation, sanitize),
      publicationEvidence: publicationEvidenceFrom(observation),
      repairCapture: toReplayRepairHintCapture(observation),
    });
  };

  // #1349 post-resolution phase (`wait`): NEVER the generic pre-dispatch
  // resolution below — an absent landmark is a wait's expected starting
  // condition, so refusing on the current screen would break polling. Only
  // path 1 (recorded-`unverifiable`, no resolution involved) refuses up
  // front; a verifiable landmark is deferred into the wait's own loop.
  if (resolveTargetIdentityVerification(action.command) === 'post-resolution') {
    const parsed = parseWaitPositionals(resolvedAction.positionals ?? []);
    const plan = planPostResolutionTargetVerification({
      recorded,
      isSelectorWait: parsed?.kind === 'selector',
    });
    switch (plan.kind) {
      case 'skip':
        return { verified: true };
      case 'recorded-unverifiable':
        return { verified: false, response: await buildRecordedUnverifiableResponse() };
      case 'deferred-landmark':
        return { verified: true, deferredLandmark: plan.landmark };
    }
  }

  // A malformed recorded selector is not this module's concern — the real
  // dispatch will parse (and fail) it the same way an unannotated action
  // would. `resolveRecordedTarget`'s early parse gate is the exact same
  // `tryParseSelectorChain` check this used to run directly (empty `nodes`
  // is safe: a parse failure short-circuits before any resolution work).
  const preDispatchPlan = planPreDispatchTargetVerification({
    recorded,
    token: extractReplayTargetToken(resolvedAction, port),
    platform: session.device.platform,
    port,
  });
  if (preDispatchPlan.kind === 'skip') return { verified: true };
  if (preDispatchPlan.kind === 'recorded-unverifiable') {
    return { verified: false, response: await buildRecordedUnverifiableResponse() };
  }
  const token = preDispatchPlan.token;

  // #1385: this is the pre-dispatch gate a step right after `open --relaunch`
  // can race — the app may still be launching/mounting when this capture
  // lands, producing a transient `capture-failed` / `sparse-snapshot`
  // verdict that is not a real divergence. Bounded retry rides out that
  // transition instead of failing closed on the first unlucky capture.
  const observation = await captureDivergenceObservation({
    session,
    sessionName,
    sessionStore,
    logPath,
    action,
    retryLaunchRace: true,
  });
  if (observation.state !== 'available') {
    return {
      verified: false,
      response: buildTargetBindingDivergenceResponse(context, {
        kind: 'identity-unverifiable',
        matchCount: undefined,
        observed: undefined,
        candidateNodes: [],
        mismatches: [],
        causeCode: 'IDENTITY_UNVERIFIABLE',
        causeMessage: `Could not capture a fresh snapshot to verify the recorded target before acting (${observation.reason}).`,
        causeHint: observation.hint,
        screen: buildDivergenceScreen(observation, sanitize),
        repairCapture: toReplayRepairHintCapture(observation),
      }),
    };
  }

  const config = resolveSuggestionMatchingConfig(action);
  const classification = classifyReplayTarget({
    recorded,
    token,
    nodes: observation.nodes,
    platform: session.device.platform,
    refLabel: readRefLabel(action),
    requireRect: config.requiresRect,
    allowDisambiguation: config.allowDisambiguation,
    port,
  });

  if (classification.verified) {
    return {
      verified: true,
      guard: {
        // Carry BOTH the verified member's local identity AND its structural
        // denotation (document order + sibling), so dispatch's guard refuses a
        // different duplicate that shares the same {id, role, label}.
        expected: {
          identity: boundedLocalIdentity(classification.winnerNode),
          structural: readNodeStructuralDenotation(classification.winnerNode, observation.nodes),
        },
        matchCount: classification.matchCount,
      },
    };
  }

  return {
    verified: false,
    response: buildTargetBindingDivergenceResponse(context, {
      kind: classification.kind,
      matchCount: classification.matchCount,
      observed: classification.observedNode
        ? boundedLocalIdentity(classification.observedNode)
        : undefined,
      candidateNodes: classification.candidateNodes,
      mismatches: classification.mismatches,
      causeCode: classification.causeCode,
      causeMessage: classification.causeMessage,
      screen: buildDivergenceScreen(observation, sanitize),
      publicationEvidence: observation.evidence,
      repairCapture: toReplayRepairHintCapture(observation),
    }),
  };
}

// ---------------------------------------------------------------------------
// Post-resolution guard (coordinator addition to step 4): dispatch's own
// resolution runs guards verification does not replicate (occlusion
// filtering, visibility-preferring disambiguation), so its winner can differ
// from the verified member even after verification passed. The interaction
// layer cross-checks the two identities pre-action
// (`assertExpectedResolvedTarget`, resolution.ts) and refuses with the
// marker below; the replay loop converts that refusal into an
// identity-mismatch target-binding divergence here.
// ---------------------------------------------------------------------------

export function isReplayTargetGuardMismatchResponse(response: DaemonResponse): boolean {
  return !response.ok && response.error.details?.reason === REPLAY_TARGET_GUARD_MISMATCH_REASON;
}

type PostDispatchMismatchParams = ReplayTargetDivergenceParams & {
  failedResponse: DaemonResponse;
};

/**
 * The shared post-dispatch identity-mismatch shaping: both refusal markers —
 * the guard mismatch and wait's landmark refusal — arrive as a failed dispatch
 * response whose details carry the observed evidence, and both become the same
 * bounded identity-mismatch divergence around their marker-specific evidence.
 */
async function buildPostDispatchIdentityMismatchResponse(
  params: PostDispatchMismatchParams,
  deriveEvidence: (
    recorded: TargetAnnotationV1,
    details: Record<string, unknown> | undefined,
  ) => ReplayPostDispatchMismatchEvidence,
): Promise<DaemonResponse> {
  const { action, scope, failedResponse, sessionName, sessionStore, logPath } = params;
  // The refusal markers are only ever attached to an annotated action; fall
  // back to the original failure if the invariant is somehow violated.
  const recorded = action.targetEvidence;
  if (!recorded) return failedResponse;

  const scrubVars = collectReplayScrubbableVarValues(scope);
  const sanitize = createReplayDivergenceSanitizer(scrubVars);
  const details = failedResponse.ok ? undefined : failedResponse.error.details;
  const evidence = deriveEvidence(recorded, details);

  const session = sessionStore.get(sessionName);
  const observation = session
    ? await captureDivergenceObservation({ session, sessionName, sessionStore, logPath, action })
    : ({
        state: 'unavailable',
        reason: 'no-session',
        hint: 'The session closed before a post-failure screen could be captured.',
      } as const);

  return buildTargetBindingDivergenceResponse(
    {
      recorded,
      action,
      step: params.step,
      sourcePath: params.sourcePath,
      sourceLine: params.sourceLine,
      replayPath: params.replayPath,
      artifactPaths: params.artifactPaths,
      sessionName,
      sessionStore,
      resumeStamper: params.resumeStamper,
      responseLevel: params.responseLevel,
      scrubVars,
      planActions: params.planActions,
      planDigest: params.planDigest,
      signal: params.signal,
    },
    {
      kind: 'identity-mismatch',
      matchCount: evidence.matchCount,
      observed: evidence.observed,
      candidateNodes: [],
      mismatches: evidence.mismatches,
      causeCode: 'IDENTITY_MISMATCH',
      causeMessage: evidence.causeMessage,
      screen: buildDivergenceScreen(observation, sanitize),
      publicationEvidence: publicationEvidenceFrom(observation),
      repairCapture: toReplayRepairHintCapture(observation),
    },
  );
}

function publicationEvidenceFrom(
  observation: Awaited<ReturnType<typeof captureDivergenceObservation>>,
): InternalObservationEvidence | undefined {
  return observation.state === 'available' ? observation.evidence : undefined;
}

export async function buildReplayTargetGuardMismatchResponse(
  params: PostDispatchMismatchParams & { guard: ReplayVerifiedTargetGuard },
): Promise<DaemonResponse> {
  return await buildPostDispatchIdentityMismatchResponse(params, (recorded, details) =>
    deriveReplayTargetGuardMismatchEvidence(recorded, details, params.guard.matchCount),
  );
}

// ---------------------------------------------------------------------------
// #1349 deferred (post-resolution) landmark verification for `wait`: the
// polling loop refuses at its deadline when selector candidates appeared but
// none carried the recorded landmark identity; the replay loop converts that
// refusal into an identity-mismatch target-binding divergence here. A plain
// wait timeout (the selector never matched at all) is NOT this marker — it
// stays an ordinary action-failure divergence, because "the landmark never
// appeared" needs a state repair, not an identity repair.
// ---------------------------------------------------------------------------

export function isWaitLandmarkMismatchResponse(response: DaemonResponse): boolean {
  return !response.ok && response.error.details?.reason === WAIT_LANDMARK_MISMATCH_REASON;
}

export async function buildWaitLandmarkMismatchResponse(
  params: PostDispatchMismatchParams,
): Promise<DaemonResponse> {
  return await buildPostDispatchIdentityMismatchResponse(
    params,
    deriveWaitLandmarkMismatchEvidence,
  );
}

function sanitizeIdentity(
  identity: ReplayDivergenceTargetIdentity,
  sanitize: (value: string, limit?: number) => string,
): ReplayDivergenceTargetIdentity {
  return {
    ...(identity.id !== undefined ? { id: sanitize(identity.id) } : {}),
    role: sanitize(identity.role),
    ...(identity.label !== undefined ? { label: sanitize(identity.label) } : {}),
  };
}

function describeCandidate(
  node: SnapshotNode,
  sanitize: (value: string, limit?: number) => string,
): ReplayDivergenceTargetCandidate {
  const role = formatRole(node.type ?? 'Element');
  const label = displayLabel(node, role);
  return {
    ...(node.ref ? { ref: node.ref } : {}),
    role: sanitize(role),
    ...(label ? { label: sanitize(label) } : {}),
  };
}
