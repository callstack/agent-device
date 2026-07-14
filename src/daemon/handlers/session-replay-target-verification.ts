import type { ResponseLevel, DaemonError } from '../../kernel/contracts.ts';
import type { SnapshotNode } from '../../kernel/snapshot.ts';
import { displayLabel, formatRole } from '../../snapshot/snapshot-lines.ts';
import { formatDivergenceActionLabel } from '../../replay/script-utils.ts';
import {
  collectReplayScrubbableVarValues,
  resolveReplayAction,
  type ReplayVarScope,
} from '../../replay/vars.ts';
import type { LocalIdentity, TargetAnnotationV1 } from '../../replay/target-identity.ts';
import {
  createReplayDivergenceSanitizer,
  type ReplayDivergence,
  type ReplayDivergenceTargetBindingKind,
  type ReplayDivergenceTargetCandidate,
  type ReplayDivergenceTargetIdentity,
} from '../../replay/divergence.ts';
import {
  readNodeStructuralDenotation,
  REPLAY_TARGET_GUARD_MISMATCH_REASON,
  type ReplayTargetGuardDenotation,
} from '../../replay/target-identity-node.ts';
import type { DaemonResponse, SessionAction } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { boundedLocalIdentity } from '../session-target-evidence.ts';
import { tryParseSelectorChain } from '../../selectors/index.ts';
import {
  buildDivergenceScreen,
  boundReplayDivergenceForSession,
  captureDivergenceObservation,
  resolveSuggestionMatchingConfig,
  toReplayRepairHintCapture,
} from './session-replay-divergence.ts';
import {
  computeReplayRepairHint,
  type ReplayRepairHintCapture,
} from './session-replay-repair-hint.ts';
import { buildReplayDivergenceFailureResponse } from './session-replay-runtime-failure-response.ts';
import {
  buildReplayDivergenceResume,
  stampPendingRecordAndHealWatermark,
} from './session-replay-resume.ts';
import {
  classifyReplayTarget,
  identityFieldMismatches,
} from './session-replay-target-classification.ts';
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
  | { verified: true; guard?: ReplayVerifiedTargetGuard }
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
  responseLevel: ResponseLevel | undefined;
  scrubVars: ReturnType<typeof collectReplayScrubbableVarValues>;
  /** ADR 0012 step 5: the full top-level plan + its digest, for `resume`. */
  planActions: SessionAction[];
  planDigest: string;
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
    responseLevel,
    scrubVars,
    planActions,
    planDigest,
  } = context;
  const sanitize = createReplayDivergenceSanitizer(scrubVars);
  const targetBinding = {
    classification: built.kind,
    ...(built.matchCount !== undefined ? { matchCount: built.matchCount } : {}),
    recorded: sanitizeIdentity(identityFromAnnotation(recorded), sanitize),
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
  // Fetched before the resume so its existence can gate the empty-tail
  // `alternateFrom` (the watermark stamped below needs a live session).
  const session = sessionStore.get(sessionName);
  const resume = buildReplayDivergenceResume({
    failedIndex: step,
    actions: planActions,
    planDigest,
    repairHint,
    sessionExists: session !== undefined,
  });
  if (session) {
    stampPendingRecordAndHealWatermark({
      session,
      resume,
      repairHint,
      failedIndex: step,
      actions: planActions,
    });
    sessionStore.set(sessionName, session);
  }

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
    // 1` instead). `buildReplayDivergenceResume` runs the same skip-safety
    // preflight as an action-failure divergence (allowed unless a skipped
    // step produces outputEnv or the range crosses runtime control flow).
    // This is the only resume site for target-binding divergences.
    resume,
    repairHint,
    targetBinding,
  };
  const bounded = boundReplayDivergenceForSession({
    sessionStore,
    sessionName,
    divergence,
    responseLevel,
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

export async function verifyReplayActionTarget(params: {
  action: SessionAction;
  scope: ReplayVarScope;
  sourcePath: string;
  sourceLine: number;
  replayPath: string;
  step: number;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  artifactPaths: string[];
  responseLevel: ResponseLevel | undefined;
  planActions: SessionAction[];
  planDigest: string;
}): Promise<ReplayTargetVerificationOutcome> {
  const {
    action,
    scope,
    sourcePath,
    sourceLine,
    replayPath,
    step,
    sessionName,
    sessionStore,
    logPath,
    artifactPaths,
    responseLevel,
    planActions,
    planDigest,
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
  const token = extractReplayTargetToken(resolvedAction);
  if (token === undefined) return { verified: true };
  if (!token.startsWith('@') && !tryParseSelectorChain(token)) {
    // A malformed recorded selector is not this module's concern — the real
    // dispatch will parse (and fail) it the same way an unannotated action
    // would.
    return { verified: true };
  }

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
    responseLevel,
    scrubVars,
    planActions,
    planDigest,
  };

  // Decision 3 path 1: a recorded-`unverifiable` annotation fires before any
  // resolution — matchCount is omitted (never computed).
  if (recorded.verification === 'unverifiable') {
    const observation = await captureDivergenceObservation({
      session,
      sessionName,
      sessionStore,
      logPath,
      action,
    });
    return {
      verified: false,
      response: buildTargetBindingDivergenceResponse(context, {
        kind: 'identity-unverifiable',
        matchCount: undefined,
        observed: undefined,
        candidateNodes: [],
        mismatches: [],
        causeCode: 'IDENTITY_UNVERIFIABLE',
        causeMessage:
          'The recorded target evidence could not verify itself when it was captured (a structural capture anomaly), so replay cannot trust it before acting.',
        screen: buildDivergenceScreen(observation, sanitize),
        repairCapture: toReplayRepairHintCapture(observation),
      }),
    };
  }

  const observation = await captureDivergenceObservation({
    session,
    sessionName,
    sessionStore,
    logPath,
    action,
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

export async function buildReplayTargetGuardMismatchResponse(params: {
  action: SessionAction;
  scope: ReplayVarScope;
  guard: ReplayVerifiedTargetGuard;
  failedResponse: DaemonResponse;
  sourcePath: string;
  sourceLine: number;
  replayPath: string;
  step: number;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  artifactPaths: string[];
  responseLevel: ResponseLevel | undefined;
  planActions: SessionAction[];
  planDigest: string;
}): Promise<DaemonResponse> {
  const {
    action,
    scope,
    guard,
    failedResponse,
    sourcePath,
    sourceLine,
    replayPath,
    step,
    sessionName,
    sessionStore,
    logPath,
    artifactPaths,
    responseLevel,
    planActions,
    planDigest,
  } = params;
  // The guard is only ever attached to an annotated action; fall back to the
  // original failure if the invariant is somehow violated.
  const recorded = action.targetEvidence;
  if (!recorded) return failedResponse;

  const scrubVars = collectReplayScrubbableVarValues(scope);
  const sanitize = createReplayDivergenceSanitizer(scrubVars);
  const details = failedResponse.ok ? undefined : failedResponse.error.details;
  const observed = readGuardMismatchObservedIdentity(details?.observed);
  // The guard fires even when local identity is identical (a same-identity
  // duplicate resolved by structural position) — surface the structural
  // difference so `mismatches` is never empty on a real divergence.
  const structuralMismatch = describeStructuralMismatch(
    details?.expectedStructural,
    details?.observedStructural,
  );

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
      step,
      sourcePath,
      sourceLine,
      replayPath,
      artifactPaths,
      sessionName,
      sessionStore,
      responseLevel,
      scrubVars,
      planActions,
      planDigest,
    },
    {
      kind: 'identity-mismatch',
      matchCount: guard.matchCount,
      observed,
      candidateNodes: [],
      mismatches: [
        ...(observed ? identityFieldMismatches(recorded, observed) : []),
        ...(structuralMismatch ? [structuralMismatch] : []),
      ],
      causeCode: 'IDENTITY_MISMATCH',
      causeMessage:
        'Dispatch resolution (with occlusion/visibility guards) resolved a different element than pre-action verification isolated; the action was not sent.',
      screen: buildDivergenceScreen(observation, sanitize),
      repairCapture: toReplayRepairHintCapture(observation),
    },
  );
}

function readGuardMismatchObservedIdentity(value: unknown): LocalIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.role !== 'string') return undefined;
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    role: record.role,
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
  };
}

/** A `position:` mismatch line from the guard's structural denotations, when both are present and differ. */
function describeStructuralMismatch(expected: unknown, observed: unknown): string | undefined {
  const e = readStructuralDenotation(expected);
  const o = readStructuralDenotation(observed);
  if (!e || !o) return undefined;
  if (e.documentOrder === o.documentOrder && e.sibling === o.sibling) return undefined;
  return `position: recorded=doc${e.documentOrder}/sibling${e.sibling} observed=doc${o.documentOrder}/sibling${o.sibling}`;
}

function readStructuralDenotation(
  value: unknown,
): { documentOrder: number; sibling: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.documentOrder !== 'number' || typeof record.sibling !== 'number') {
    return undefined;
  }
  return { documentOrder: record.documentOrder, sibling: record.sibling };
}

function identityFromAnnotation(recorded: TargetAnnotationV1): ReplayDivergenceTargetIdentity {
  return {
    ...(recorded.id !== undefined ? { id: recorded.id } : {}),
    role: recorded.role,
    ...(recorded.label !== undefined ? { label: recorded.label } : {}),
  };
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
