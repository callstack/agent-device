import type { MaestroEngineEvent } from '../../compat/maestro/engine-types.ts';
import { formatMaestroCommandProgress } from '../../compat/maestro/progress.ts';
import { evaluateMaestroReplayResume } from '../../compat/maestro/replay-plan.ts';
import type { MaestroReplayPlan } from '../../compat/maestro/replay-plan-types.ts';
import type { DaemonError } from '../../kernel/contracts.ts';
import {
  REPLAY_DIVERGENCE_SUGGESTION_LIMIT,
  createReplayDivergenceSanitizer,
  type ReplayDivergence,
  type ReplayVarScrubEntry,
} from '../../replay/divergence.ts';
import { formatScriptArg } from '../../replay/script-utils.ts';
import type { SnapshotDiagnosticsSummary } from '../../snapshot-diagnostics.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import {
  boundReplayDivergenceForSession,
  buildDivergenceScreen,
  captureDivergenceObservation,
  collectReplayDivergenceSuggestions,
} from './session-replay-divergence.ts';
import {
  buildReplayDivergenceFailureResponseFromDescriptor,
  hoistReplayFailureCauseDiagnosticMeta,
} from './session-replay-runtime-failure-response.ts';

export type MaestroFailedEngineEvent = MaestroEngineEvent & {
  readonly durationMs: number;
  readonly error: unknown;
  readonly artifactPaths: readonly string[];
  readonly expandedVariables: Readonly<Record<string, string>>;
};

export async function buildTypedMaestroFailureResponse(params: {
  readonly error: DaemonError;
  readonly event: MaestroFailedEngineEvent;
  readonly plan: MaestroReplayPlan;
  readonly replayPath: string;
  readonly req: DaemonRequest;
  readonly sessionName: string;
  readonly sessionStore: SessionStore;
  readonly logPath: string;
  readonly snapshotDiagnostics?: SnapshotDiagnosticsSummary;
}): Promise<DaemonResponse> {
  const { event, plan, replayPath, req, sessionName, sessionStore, logPath } = params;
  const cause = hoistReplayFailureCauseDiagnosticMeta(params.error);
  const scrubVars = collectExpandedScrubVars(event.expandedVariables);
  const sanitize = createReplayDivergenceSanitizer(scrubVars);
  const diagnosticAction = diagnosticActionForEvent(event, req);
  const session = sessionStore.get(sessionName);
  const observation = session
    ? await captureDivergenceObservation({
        session,
        sessionName,
        sessionStore,
        logPath,
        action: diagnosticAction,
      })
    : {
        state: 'unavailable' as const,
        reason: 'no-session',
        hint: 'The session closed before a post-failure screen could be captured.',
      };
  const suggestions = session
    ? collectReplayDivergenceSuggestions({
        action: diagnosticAction,
        session,
        nodes: observation.state === 'available' ? observation.nodes : [],
        sanitize,
      })
    : [];
  const resume = evaluateMaestroReplayResume(plan, {
    from: event.stepIndex,
    planDigest: plan.digest,
  });
  const progress = formatMaestroCommandProgress(event.command);
  const actionLabel = [event.command.kind, progress.value ? formatScriptArg(progress.value) : '']
    .filter(Boolean)
    .join(' ');
  const divergence: ReplayDivergence = {
    version: 1,
    kind: 'action-failure',
    step: {
      index: event.stepIndex,
      source: {
        path: sanitize(event.source.path ?? replayPath),
        line: event.source.line,
      },
    },
    action: sanitize(actionLabel),
    cause: {
      code: cause.code,
      message: sanitize(cause.message),
      ...(cause.hint ? { hint: sanitize(cause.hint) } : {}),
    },
    screen: buildDivergenceScreen(observation, sanitize),
    suggestions: suggestions.slice(0, REPLAY_DIVERGENCE_SUGGESTION_LIMIT),
    suggestionCount: suggestions.length,
    resume: resume.allowed
      ? { allowed: true, from: event.stepIndex, planDigest: plan.digest }
      : {
          allowed: false,
          from: event.stepIndex,
          planDigest: plan.digest,
          reason: resume.reason,
        },
  };
  const bounded = boundReplayDivergenceForSession({
    sessionStore,
    sessionName,
    divergence,
    responseLevel: req.meta?.responseLevel,
  });
  return buildReplayDivergenceFailureResponseFromDescriptor({
    error: cause,
    actionLabel,
    action: event.command.kind,
    positionals: safeProgressPositionals(event.command.kind, progress.value),
    step: event.stepIndex,
    replayPath,
    artifactPaths: [...event.artifactPaths],
    snapshotDiagnostics: params.snapshotDiagnostics,
    divergence: bounded,
    scrubVars,
  });
}

function diagnosticActionForEvent(
  event: MaestroEngineEvent,
  req: DaemonRequest,
): SessionAction {
  const progress = formatMaestroCommandProgress(event.command);
  const command = diagnosticCommand(event.command.kind);
  return {
    ts: Date.now(),
    command,
    positionals: safeProgressPositionals(event.command.kind, progress.value),
    flags: req.flags ?? {},
  };
}

function diagnosticCommand(command: string): string {
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
  if (!value || command === 'inputText' || command === 'pasteText') return [];
  return [value];
}

function collectExpandedScrubVars(
  values: Readonly<Record<string, string>>,
): ReplayVarScrubEntry[] {
  return Object.entries(values)
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value.length - left.value.length);
}
