import type { MaestroFailedAction } from '@agent-device/maestro';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { DaemonError } from '@agent-device/kernel/errors';
import type { SnapshotDiagnosticsSummary } from '@agent-device/contracts/capture';
import {
  REPLAY_DIVERGENCE_SUGGESTION_LIMIT,
  createReplayDivergenceSanitizer,
  type ReplayDivergence,
  type ReplayVarScrubEntry,
} from '@agent-device/contracts/divergence';
import { formatScriptArg } from '@agent-device/ad-script';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import type { ReplayReportAction } from './session-replay-report-action.ts';
import { rankAndDedupeReplaySuggestions } from './session-replay-suggestion-ranking.ts';
import {
  buildReplayDivergenceSuggestionForNode,
  buildDivergenceScreen,
  captureDivergenceObservation,
  toReplayRepairHintCapture,
  type DivergenceFieldSanitizer,
} from './session-replay-divergence.ts';
import { boundReplayDivergenceForSession } from './session-replay-divergence-publication.ts';
import { computeReplayRepairHint } from './session-replay-repair-hint.ts';
import {
  buildReplayDivergenceFailureResponseFromDescriptor,
  hoistReplayFailureCauseDiagnosticMeta,
} from './session-replay-runtime-failure-response.ts';
import { adaptMaestroFailureSnapshot } from '../adapters/maestro/failure-snapshot.ts';

export type MaestroFailureReportAction = Pick<
  ReplayReportAction,
  'command' | 'positionals' | 'flags'
>;

export type MaestroFailureReportProjection = {
  readonly command: { readonly kind: string };
  readonly source: MaestroFailedAction['source'];
  readonly progress: { readonly command: string; readonly value?: string };
  readonly action: MaestroFailureReportAction;
};

export function buildTypedMaestroFailureReportProjection(
  failure: MaestroFailedAction,
  req: DaemonRequest,
): MaestroFailureReportProjection {
  const progress = {
    command: failure.action,
    ...(failure.value ? { value: failure.value } : {}),
  };
  return {
    command: { kind: failure.action },
    source: failure.source,
    progress,
    action: {
      command: reportCommandForCapture(failure.action),
      positionals: safeProgressPositionals(failure.action, failure.value),
      flags: req.flags ?? {},
    },
  };
}

export async function buildTypedMaestroFailureResponse(params: {
  readonly error: DaemonError;
  readonly failure: MaestroFailedAction;
  readonly replayPath: string;
  readonly req: DaemonRequest;
  readonly sessionName: string;
  readonly sessionStore: SessionStore;
  readonly logPath: string;
  readonly snapshotDiagnostics?: SnapshotDiagnosticsSummary;
}): Promise<DaemonResponse> {
  const { failure, replayPath, req, sessionName, sessionStore, logPath } = params;
  const requestSignal = getRequestSignal(req.meta?.requestId);
  const report = buildTypedMaestroFailureReportProjection(failure, req);
  const cause = hoistReplayFailureCauseDiagnosticMeta(params.error);
  const scrubVars: ReplayVarScrubEntry[] = [...failure.redactions];
  const sanitize = createReplayDivergenceSanitizer(scrubVars);
  const safeCause = {
    ...cause,
    message: sanitize(cause.message),
    ...(cause.hint ? { hint: sanitize(cause.hint) } : {}),
  };
  const session = sessionStore.get(sessionName);
  const observation = session
    ? await captureDivergenceObservation({
        session,
        sessionName,
        sessionStore,
        logPath,
        action: report.action,
      })
    : {
        state: 'unavailable' as const,
        reason: 'no-session',
        hint: 'The session closed before a post-failure screen could be captured.',
      };
  const suggestions =
    session && observation.state === 'available' && !failure.isControl
      ? collectTypedMaestroSuggestions({
          failure,
          action: report.action,
          session,
          nodes: observation.nodes,
          sanitize,
        })
      : [];
  const actionLabel = [failure.action, formatMaestroActionValue(failure.value)]
    .filter(Boolean)
    .join(' ');
  const divergence: ReplayDivergence = {
    version: 1,
    kind: 'action-failure',
    step: {
      index: failure.stepIndex,
      source: {
        path: sanitize(failure.source.path ?? replayPath),
        line: failure.source.line,
      },
    },
    action: sanitize(actionLabel),
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
    sessionName,
    divergence,
    responseLevel: req.meta?.responseLevel,
    evidence: observation.state === 'available' ? observation.evidence : undefined,
    ...(requestSignal ? { signal: requestSignal } : {}),
  });
  return buildReplayDivergenceFailureResponseFromDescriptor({
    error: safeCause,
    actionLabel,
    action: failure.action,
    positionals: [...report.action.positionals],
    step: failure.stepIndex,
    replayPath,
    artifactPaths: [...failure.artifactPaths],
    snapshotDiagnostics: params.snapshotDiagnostics,
    divergence: bounded,
    scrubVars,
  });
}

function collectTypedMaestroSuggestions(params: {
  failure: MaestroFailedAction;
  action: MaestroFailureReportAction;
  session: SessionState;
  nodes: SnapshotNode[];
  sanitize: DivergenceFieldSanitizer;
}) {
  const snapshot = { createdAt: Date.now(), nodes: params.nodes };
  return rankAndDedupeReplaySuggestions(
    adaptMaestroFailureSnapshot(params.failure, snapshot).map(({ node, basis }) => ({
      node,
      nodeIndex: node.index,
      basis,
    })),
  ).map(({ node, basis }) =>
    buildReplayDivergenceSuggestionForNode({
      node,
      nodes: params.nodes,
      session: params.session,
      action: params.action,
      basis,
      sanitize: params.sanitize,
    }),
  );
}

function formatMaestroActionValue(value: string | undefined): string {
  if (!value || value === '<text>') return value ?? '';
  return formatScriptArg(value);
}

function reportCommandForCapture(command: string): string {
  if (command === 'tapOn' || command === 'doubleTapOn') return 'click';
  if (command === 'longPressOn') return 'longpress';
  if (
    command === 'assertVisible' ||
    command === 'assertNotVisible' ||
    command === 'extendedWaitUntil' ||
    command === 'scrollUntilVisible'
  ) {
    return 'wait';
  }
  return command;
}

function safeProgressPositionals(command: string, value: string | undefined): string[] {
  if (!value || command === 'inputText') return [];
  return [value];
}
