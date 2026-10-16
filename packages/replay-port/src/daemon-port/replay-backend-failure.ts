import type { ReplayDivergence } from '@agent-device/contracts/divergence';
import type { ReplayBackendActionFailure } from '@agent-device/contracts/replay-backend';
import {
  REPLAY_DIVERGENCE_SUGGESTION_LIMIT,
  createReplayDivergenceSanitizer,
  type ReplayVarScrubEntry,
} from '@agent-device/ad-replay/divergence';
import { getRequestSignal } from '@agent-device/host-kit/request';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { computeReplayRepairHint } from './repair-hint.ts';
import {
  buildReplayDivergenceSuggestionForNode,
  buildDivergenceScreen,
  captureDivergenceObservation,
  toReplayRepairHintCapture,
} from './session-replay-divergence.ts';
import { boundReplayDivergenceForSession } from './session-replay-divergence-publication.ts';
import {
  buildReplayDivergenceFailureResponseFromDescriptor,
  hoistReplayFailureCauseDiagnosticMeta,
} from './session-replay-runtime-failure-response.ts';
import { rankAndDedupeReplaySuggestions } from './session-replay-suggestion-ranking.ts';

/**
 * Builds the REPLAY_DIVERGENCE response for one failed backend step: the post-failure screen
 * capture, the engine's suggested nodes ranked and deduped, the bounded divergence report, and
 * the resume contract. The backend names what failed; this owns how the daemon reports it.
 */
export async function buildReplayBackendActionFailureResponse(
  failure: ReplayBackendActionFailure,
): Promise<DaemonResponse> {
  const { req, sessionStore, observationStore, logPath, captureAction } = failure;
  const requestSignal = getRequestSignal(req.meta?.requestId);
  const cause = hoistReplayFailureCauseDiagnosticMeta(failure.error);
  const scrubVars: ReplayVarScrubEntry[] = [...failure.redactions];
  const sanitize = createReplayDivergenceSanitizer(scrubVars);
  const safeCause = {
    ...cause,
    message: sanitize(cause.message),
    ...(cause.hint ? { hint: sanitize(cause.hint) } : {}),
  };
  const session = observationStore.get();
  const observation = session
    ? await captureDivergenceObservation({
        session,
        observationStore,
        logPath,
        action: captureAction,
      })
    : {
        state: 'unavailable' as const,
        reason: 'no-session',
        hint: 'The session closed before a post-failure screen could be captured.',
      };
  const suggestions =
    session && observation.state === 'available' && !failure.isControl
      ? rankAndDedupeReplaySuggestions(
          failure
            .suggestNodes({ createdAt: Date.now(), nodes: observation.nodes })
            .map(({ node, basis }) => ({ node, nodeIndex: node.index, basis })),
          { nodes: observation.nodes, targetEvidence: undefined },
        ).map(({ node, basis }) =>
          buildReplayDivergenceSuggestionForNode({
            node,
            nodes: observation.nodes,
            session,
            action: captureAction,
            basis,
            sanitize,
          }),
        )
      : [];
  const divergence: ReplayDivergence = {
    version: 1,
    kind: 'action-failure',
    step: {
      index: failure.stepIndex,
      source: {
        path: sanitize(failure.source.path ?? failure.replayPath),
        line: failure.source.line,
      },
    },
    action: sanitize(failure.actionLabel),
    cause: {
      code: safeCause.code,
      message: safeCause.message,
      ...(safeCause.hint ? { hint: safeCause.hint } : {}),
    },
    screen: buildDivergenceScreen(observation, sanitize),
    suggestions: suggestions.slice(0, REPLAY_DIVERGENCE_SUGGESTION_LIMIT),
    suggestionCount: suggestions.length,
    resume: failure.resume,
    repairHint: computeReplayRepairHint({
      kind: 'action-failure',
      targetEvidence: undefined,
      capture: toReplayRepairHintCapture(observation),
    }),
  };
  const bounded = boundReplayDivergenceForSession({
    sessionStore,
    observationStore,
    divergence,
    responseLevel: req.meta?.responseLevel,
    evidence: observation.state === 'available' ? observation.evidence : undefined,
    ...(requestSignal ? { signal: requestSignal } : {}),
  });
  return buildReplayDivergenceFailureResponseFromDescriptor({
    error: safeCause,
    actionLabel: failure.actionLabel,
    action: failure.action,
    positionals: [...captureAction.positionals],
    step: failure.stepIndex,
    replayPath: failure.replayPath,
    artifactPaths: [...failure.artifactPaths],
    snapshotDiagnostics: failure.snapshotDiagnostics,
    divergence: bounded,
    scrubVars,
    warnings: failure.warnings,
  });
}
