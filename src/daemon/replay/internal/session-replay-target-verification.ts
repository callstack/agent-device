import type { SessionAction } from '@agent-device/contracts/session';
import type { ResponseLevel } from '@agent-device/kernel/contracts';
import type { DaemonError } from '@agent-device/kernel/errors';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { displayLabel, formatRole } from '../../../snapshot/snapshot-lines.ts';
import {
  annotationLocalIdentity,
  formatDivergenceActionLabel,
  readNodeStructuralDenotation,
  type LocalIdentity,
} from '@agent-device/ad-script';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import type {
  AdReplayScrubValue,
  AdReplayTargetBindingEvidence,
  AdReplayTargetClassification,
  AdReplayVerificationEntry,
} from '@agent-device/ad-replay';
import {
  createReplayDivergenceSanitizer,
  type ReplayDivergence,
  type ReplayDivergenceTargetBindingKind,
  type ReplayDivergenceTargetCandidate,
  type ReplayDivergenceTargetIdentity,
} from '@agent-device/contracts/divergence';
import {
  REPLAY_TARGET_GUARD_MISMATCH_REASON,
  WAIT_LANDMARK_MISMATCH_REASON,
} from '@agent-device/contracts/replay';
import { resolveTargetIdentityVerification } from '../../../core/command-descriptor/registry.ts';
import { parseWaitPositionals } from '../../../core/wait-positionals.ts';
import type { DaemonResponse, SessionState } from '../../types.ts';
import type { ReplayResumeStamper } from '../../session-replay-coordinator.ts';
import type { InternalObservationEvidence } from '../../internal-observation.ts';
import { boundedLocalIdentity } from '../../session-target-evidence.ts';
import {
  buildDivergenceScreen,
  captureDivergenceObservation,
  resolveSuggestionMatchingConfig,
  toReplayRepairHintCapture,
  type DivergenceObservation,
} from './session-replay-divergence.ts';
import { boundReplayDivergenceForSession } from './session-replay-divergence-publication.ts';
import type { ReplaySessionObservationStore, ReplaySessionStore } from './command-types.ts';
import {
  computeReplayRepairHint,
  type ReplayRepairHintCapture,
} from './session-replay-repair-hint.ts';
import { buildReplayDivergenceFailureResponse } from './session-replay-runtime-failure-response.ts';
import { buildAndPersistReplayDivergenceResume } from './session-replay-resume.ts';
import { classifyReplayTarget } from './session-replay-target-classification.ts';
import { extractReplayTargetToken, readRefLabel } from './session-replay-target-token.ts';

// ---------------------------------------------------------------------------
// #1555 review R3 ("target verification must happen INSIDE the engine"): the
// verify-then-dispatch DECISION flow (the four `@agent-device/ad-replay`
// policy functions, `planPostResolutionTargetVerification` /
// `planPreDispatchTargetVerification` / `deriveReplayTargetGuardMismatchEvidence`
// / `deriveWaitLandmarkMismatchEvidence`) lives entirely inside the engine's
// step loop (`packages/ad-replay/src/internal/verify-dispatch.ts`,
// `verifyAndDispatchStep`) — this module never imports those four DECISION
// functions. It does import the package's neutral VOCABULARY types
// (`AdReplayVerificationEntry`/`AdReplayTargetClassification`/
// `AdReplayTargetBindingEvidence`, #1555 structural-quality review, "typed
// façade replaces the zero-type rule") so the values it builds/routes are the
// engine's own shapes, not a hand-shadowed daemon twin. This module
// implements only the narrow `AdReplayStepRuntime` capabilities the engine
// loop drives:
//
//  - `resolveTargetVerificationEntry` — routing (registry lookup, session
//    read, wait-form parse, token extraction) for `beginTargetVerification`.
//  - `classifyPreDispatchTarget` — tree matching for `classifyTarget`.
//  - `buildRecordedUnverifiableFailureResponse` /
//    `buildTargetBindingFailureResponse` /
//    `buildPostDispatchTargetBindingFailureResponse` — capture + wire-shaping
//    for the `build*Failure` capabilities.
//  - `isReplayTargetGuardMismatchResponse` / `isWaitLandmarkMismatchResponse`
//    — post-dispatch refusal-marker detection for `dispatchStep`.
//
// `session-replay-runtime-engine-adapter.ts`'s `createAdReplayStepRuntime` is
// the thin adapter that wires these into the `AdReplayStepRuntime` object and
// supplies the per-request context (resume stamper, artifact accumulator,
// side-map response holder) these functions need but do not own — as of the
// #1555 review's second pass, that context no longer includes a
// `ReplayVarScope`: the engine builds and owns the scope itself.
// ---------------------------------------------------------------------------

/**
 * #1555 structural-quality review ("unify on the engine's types"): this
 * module used to declare its own `ReplayVerifiedTargetGuard` — structurally
 * identical to (but a separate nominal declaration from) the guard shape
 * `@agent-device/ad-replay` defines — so it now reaches that shape through
 * the engine's own `AdReplayTargetClassification`/`AdReplayDispatchGuard`
 * instead of maintaining a shadow copy that could silently drift (the guard
 * type is a member of both, so the engine's façade need not name it
 * separately). `ReplayTargetGuardDenotation`
 * (`@agent-device/contracts/replay`) stays the concrete producer type for
 * `expected`; it is structurally assignable to that guard's `expected`
 * (both `{ identity: LocalIdentity; structural: { documentOrder: number;
 * sibling: number } }`) without a name-level dependency between the two
 * files.
 */

export type TargetBindingDivergenceContext = {
  recorded: TargetAnnotationV1;
  action: SessionAction;
  step: number;
  sourcePath: string;
  sourceLine: number;
  replayPath: string;
  artifactPaths: string[];
  sessionName: string;
  sessionStore: ReplaySessionStore;
  observationStore: ReplaySessionObservationStore;
  /** #1478 P4b: the request's bound resume-stamping capability — never a second-constructed coordinator. */
  resumeStamper: ReplayResumeStamper;
  responseLevel: ResponseLevel | undefined;
  /**
   * #1555 structural-quality review ("scrub values — one name"): the
   * engine's own `AdReplayScrubValue` shape — never a second, separately-
   * named `ReturnType<typeof collectReplayScrubbableVarValues>` derivation
   * for the identical concept. Readonly-compatible with the engine's
   * `readonly AdReplayScrubValue[]` capability parameters, so no daemon call
   * site needs a `[...scrubVars]` copy to satisfy this field.
   */
  scrubVars: readonly AdReplayScrubValue[];
  /** ADR 0012 step 5: the full top-level plan + its digest, for `resume`. */
  planActions: SessionAction[];
  planDigest: string;
  signal?: AbortSignal;
};

type TargetBindingDivergenceBuilt = {
  kind: ReplayDivergenceTargetBindingKind;
  matchCount: number | undefined;
  observed: LocalIdentity | undefined;
  candidateNodes: readonly SnapshotNode[];
  mismatches: readonly string[];
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
    observationStore: context.observationStore,
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

/**
 * #1555 structural-quality review ("make the engine evidence types
 * readonly-compatible with daemon consumers so no copy translator is
 * needed"): this module used to declare its own `TargetBindingFailureEvidence`
 * — structurally identical to `@agent-device/ad-replay`'s
 * `AdReplayTargetBindingEvidence` except for mutable vs. readonly array
 * fields — so a `toDaemonEvidence` translator in
 * `session-replay-runtime-engine-adapter.ts` had to copy every call. Every
 * builder below now accepts the engine's own (readonly) evidence type
 * directly; `TargetBindingDivergenceBuilt` above is readonly-compatible too,
 * so the adapter passes the engine's value straight through.
 */

/** Assembles a target-binding divergence from already-computed `evidence` and a capture `observation`. */
export function buildTargetBindingFailureResponse(
  context: TargetBindingDivergenceContext,
  evidence: AdReplayTargetBindingEvidence,
  observation: DivergenceObservation,
): DaemonResponse {
  const sanitize = createReplayDivergenceSanitizer(context.scrubVars);
  return buildTargetBindingDivergenceResponse(context, {
    kind: evidence.kind,
    matchCount: evidence.matchCount,
    observed: evidence.observed,
    candidateNodes: evidence.candidateNodes,
    mismatches: evidence.mismatches,
    causeCode: evidence.causeCode,
    causeMessage: evidence.causeMessage,
    ...(evidence.causeHint !== undefined ? { causeHint: evidence.causeHint } : {}),
    screen: buildDivergenceScreen(observation, sanitize),
    publicationEvidence: publicationEvidenceFrom(observation),
    repairCapture: toReplayRepairHintCapture(observation),
  });
}

async function captureFreshObservation(params: {
  session: SessionState | undefined;
  sessionName: string;
  observationStore: ReplaySessionObservationStore;
  logPath: string;
  action: SessionAction;
  unavailableHint: string;
}): Promise<DivergenceObservation> {
  const { session, sessionName, observationStore, logPath, action, unavailableHint } = params;
  return session
    ? await captureDivergenceObservation({
        session,
        sessionName,
        observationStore,
        logPath,
        action,
      })
    : { state: 'unavailable', reason: 'no-session', hint: unavailableHint };
}

/**
 * Decision 3 path 1: a recorded-`unverifiable` annotation fires before any
 * resolution — matchCount is omitted (never computed). Its own fresh capture,
 * independent of any earlier pre-dispatch capture (this path never reaches
 * one).
 */
export async function buildRecordedUnverifiableFailureResponse(
  context: TargetBindingDivergenceContext,
  params: {
    session: SessionState | undefined;
    sessionName: string;
    observationStore: ReplaySessionObservationStore;
    logPath: string;
    action: SessionAction;
  },
): Promise<DaemonResponse> {
  const observation = await captureFreshObservation({
    ...params,
    unavailableHint:
      'The session closed before a screen could be captured to verify the recorded target evidence.',
  });
  return buildTargetBindingFailureResponse(
    context,
    {
      kind: 'identity-unverifiable',
      matchCount: undefined,
      observed: undefined,
      candidateNodes: [],
      mismatches: [],
      causeCode: 'IDENTITY_UNVERIFIABLE',
      causeMessage:
        'The recorded target evidence could not verify itself when it was captured (a structural capture anomaly), so replay cannot trust it before acting.',
    },
    observation,
  );
}

/**
 * Post-dispatch identity-mismatch shaping (the guard mismatch and wait's
 * landmark mismatch): its own FRESH capture — the screen may have changed
 * since dispatch, so this never reuses the pre-dispatch capture.
 */
export async function buildPostDispatchTargetBindingFailureResponse(
  context: TargetBindingDivergenceContext,
  evidence: AdReplayTargetBindingEvidence,
  params: {
    session: SessionState | undefined;
    sessionName: string;
    observationStore: ReplaySessionObservationStore;
    logPath: string;
    action: SessionAction;
  },
): Promise<DaemonResponse> {
  const observation = await captureFreshObservation({
    ...params,
    unavailableHint: 'The session closed before a post-failure screen could be captured.',
  });
  return buildTargetBindingFailureResponse(context, evidence, observation);
}

function publicationEvidenceFrom(
  observation: DivergenceObservation,
): InternalObservationEvidence | undefined {
  return observation.state === 'available' ? observation.evidence : undefined;
}

// ---------------------------------------------------------------------------
// `beginTargetVerification` routing: which verification phase (if any) one
// step's recorded target evidence enters. Mirrors the pre-#1555-R3 daemon
// orchestrator's own routing exactly — only called when
// `action.targetEvidence` is present (the engine checks that itself).
//
// #1555 structural-quality review ("unify on the engine's types"): returns
// `@agent-device/ad-replay`'s own `AdReplayVerificationEntry` directly — this
// module used to declare a separate, structurally-identical
// `TargetVerificationEntry`.
// ---------------------------------------------------------------------------

/**
 * #1349 post-resolution phase (`wait`): NEVER the generic pre-dispatch
 * resolution — an absent landmark is a wait's expected starting condition.
 * Otherwise the ordinary pre-dispatch gate: the resolved-target token (scope
 * var-substituted, matching what the real dispatch would resolve) and the
 * session's platform.
 *
 * #1555 review P1 (second pass, "move variable semantics/planning behind the
 * replay entrypoint"): `resolvedAction` arrives already interpolated — the
 * engine's own ONE resolution of this step (`runAdReplay`), never a second,
 * daemon-side `resolveReplayAction` call over a `scope` this module used to
 * hold. `action` (the recorded original) is used only for the command-kind
 * check below; `resolvedAction` is used only to extract the match
 * token/wait-form below, never serialized onto the wire (a target-binding
 * response is always built from the ORIGINAL `action`, like every other
 * replay divergence, so an expanded `${VAR}` never leaks through an
 * un-scrubbed positional).
 */
export function resolveTargetVerificationEntry(params: {
  action: SessionAction;
  resolvedAction: SessionAction;
  sessionStore: ReplaySessionStore;
  targetRole?: 'source' | 'destination';
}): AdReplayVerificationEntry {
  const { action, resolvedAction, sessionStore, targetRole } = params;
  const session = sessionStore.get();
  if (!session) return { kind: 'inactive' };
  if (resolveTargetIdentityVerification(action.command) === 'post-resolution') {
    const parsed = parseWaitPositionals(resolvedAction.positionals ?? []);
    return { kind: 'post-resolution', isSelectorWait: parsed?.kind === 'selector' };
  }
  return {
    kind: 'pre-dispatch',
    // A malformed recorded selector is not this module's concern — the real
    // dispatch will parse (and fail) it the same way an unannotated action
    // would; `extractReplayTargetToken` returning a token here is not proof
    // it parses (the engine's pre-dispatch plan runs that check itself).
    token: extractReplayTargetToken(resolvedAction, targetRole),
    platform: session.device.platform,
  };
}

// ---------------------------------------------------------------------------
// `classifyTarget`: resolves the recorded target against an already-captured
// tree using the SAME lookup/matching a real dispatch would.
//
// #1555 structural-quality review ("unify on the engine's types"): returns
// `@agent-device/ad-replay`'s own `AdReplayTargetClassification` directly —
// this module used to declare a separate, structurally-identical
// `TargetClassificationOutcome` (with its own `ReplayVerifiedTargetGuard`
// for the verified branch).
// ---------------------------------------------------------------------------

export function classifyPreDispatchTarget(params: {
  recorded: TargetAnnotationV1;
  token: string;
  action: SessionAction;
  nodes: SnapshotNode[];
  platform: Platform | PublicPlatform;
}): AdReplayTargetClassification {
  const { recorded, token, action, nodes, platform } = params;
  const config = resolveSuggestionMatchingConfig(action);
  const classification = classifyReplayTarget({
    recorded,
    token,
    nodes,
    platform,
    refLabel: readRefLabel(action),
    requireRect: config.requiresRect,
    allowDisambiguation: config.allowDisambiguation,
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
          structural: readNodeStructuralDenotation(classification.winnerNode, nodes),
        },
        matchCount: classification.matchCount,
      },
    };
  }
  return {
    verified: false,
    kind: classification.kind,
    matchCount: classification.matchCount,
    observed: classification.observedNode
      ? boundedLocalIdentity(classification.observedNode)
      : undefined,
    candidateNodes: classification.candidateNodes,
    mismatches: classification.mismatches,
    causeCode: classification.causeCode,
    causeMessage: classification.causeMessage,
  };
}

// ---------------------------------------------------------------------------
// Post-resolution guard (coordinator addition to step 4): dispatch's own
// resolution runs guards verification does not replicate (occlusion
// filtering, visibility-preferring disambiguation), so its winner can differ
// from the verified member even after verification passed. The interaction
// layer cross-checks the two identities pre-action
// (`assertExpectedResolvedTarget`, resolution.ts) and refuses with the
// marker below; `dispatchStep` detects the refusal and reports it to the
// engine as a neutral `guard-mismatch`/`landmark-mismatch` outcome.
// ---------------------------------------------------------------------------

export function isReplayTargetGuardMismatchResponse(response: DaemonResponse): boolean {
  return !response.ok && response.error.details?.reason === REPLAY_TARGET_GUARD_MISMATCH_REASON;
}

/**
 * #1349: `wait`'s post-resolution landmark timeout refusal — candidates
 * matched the recorded selector during polling, but none carried the
 * recorded landmark identity. `dispatchStep` detects this the same way as
 * the guard-mismatch marker above.
 */
export function isWaitLandmarkMismatchResponse(response: DaemonResponse): boolean {
  return !response.ok && response.error.details?.reason === WAIT_LANDMARK_MISMATCH_REASON;
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
