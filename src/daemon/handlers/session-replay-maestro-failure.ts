import {
  isMaestroControlCommandDescriptor,
  type MaestroEngineEvent,
} from '../../compat/maestro/engine-types.ts';
import { formatMaestroCommandProgress } from '../../compat/maestro/progress.ts';
import type { MaestroCommand, MaestroSelector } from '../../compat/maestro/program-ir.ts';
import { evaluateMaestroReplayResume } from '../../compat/maestro/replay-plan.ts';
import type { MaestroReplayPlan } from '../../compat/maestro/replay-plan-types.ts';
import { matchesMaestroTypedSelector } from '../../compat/maestro/runtime-target-policy.ts';
import { rankMaestroCandidates } from '../../compat/maestro/runtime-target-ranking.ts';
import type { DaemonError } from '../../kernel/contracts.ts';
import type { SnapshotNode } from '../../kernel/snapshot.ts';
import {
  REPLAY_DIVERGENCE_SUGGESTION_LIMIT,
  createReplayDivergenceSanitizer,
  type ReplayDivergence,
  type ReplayDivergenceSuggestionBasis,
  type ReplayVarScrubEntry,
} from '../../replay/divergence.ts';
import { formatScriptArg } from '../../replay/script-utils.ts';
import type { SnapshotDiagnosticsSummary } from '../../snapshot-diagnostics.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import type { ReplayReportAction } from './session-replay-report-action.ts';
import {
  boundReplayDivergenceForSession,
  buildReplayDivergenceSuggestionForNode,
  buildDivergenceScreen,
  captureDivergenceObservation,
  toReplayRepairHintCapture,
  type DivergenceFieldSanitizer,
} from './session-replay-divergence.ts';
import { computeReplayRepairHint } from './session-replay-repair-hint.ts';
import { rankAndDedupeReplaySuggestions } from './session-replay-suggestion-ranking.ts';
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

export type MaestroFailureReportAction = Pick<
  ReplayReportAction,
  'command' | 'positionals' | 'flags'
>;

export type MaestroFailureReportProjection = {
  readonly authoredCommand: MaestroEngineEvent['command'];
  readonly source: MaestroEngineEvent['source'];
  readonly progress: ReturnType<typeof formatMaestroCommandProgress>;
  readonly action: MaestroFailureReportAction;
};

export function buildTypedMaestroFailureReportProjection(
  event: MaestroFailedEngineEvent,
  req: DaemonRequest,
): MaestroFailureReportProjection {
  const progress = formatMaestroCommandProgress(event.command);
  return {
    authoredCommand: event.command,
    source: event.source,
    progress,
    action: {
      command: reportCommandForCapture(event.command.kind),
      positionals: safeProgressPositionals(event.command.kind, progress.value),
      flags: req.flags ?? {},
    },
  };
}

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
  const report = buildTypedMaestroFailureReportProjection(event, req);
  const cause = hoistReplayFailureCauseDiagnosticMeta(params.error);
  const scrubVars = [
    ...collectExpandedScrubVars(event.expandedVariables),
    ...collectMaestroTextScrubVars(report.authoredCommand),
  ].sort((left, right) => right.value.length - left.value.length);
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
    session &&
    observation.state === 'available' &&
    !isMaestroControlCommandDescriptor(report.authoredCommand)
      ? collectTypedMaestroSuggestions({
          command: report.authoredCommand,
          platform: plan.platform,
          action: report.action,
          session,
          nodes: observation.nodes,
          sanitize,
        })
      : [];
  const resume = evaluateMaestroReplayResume(plan, {
    from: event.stepIndex,
    planDigest: plan.digest,
  });
  const actionLabel = [report.authoredCommand.kind, formatMaestroActionValue(report.progress.value)]
    .filter(Boolean)
    .join(' ');
  const divergence: ReplayDivergence = {
    version: 1,
    kind: 'action-failure',
    step: {
      index: event.stepIndex,
      source: {
        path: sanitize(report.source.path ?? replayPath),
        line: report.source.line,
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
    resume: resume.allowed
      ? { allowed: true, from: event.stepIndex, planDigest: plan.digest }
      : {
          allowed: false,
          from: event.stepIndex,
          planDigest: plan.digest,
          reason: resume.reason,
        },
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
  });
  return buildReplayDivergenceFailureResponseFromDescriptor({
    error: safeCause,
    actionLabel,
    action: report.authoredCommand.kind,
    positionals: [...report.action.positionals],
    step: event.stepIndex,
    replayPath,
    artifactPaths: [...event.artifactPaths],
    snapshotDiagnostics: params.snapshotDiagnostics,
    divergence: bounded,
    scrubVars,
  });
}

function formatMaestroActionValue(value: string | undefined): string {
  if (!value || value === '<text>') return value ?? '';
  return formatScriptArg(value);
}

function collectTypedMaestroSuggestions(params: {
  command: MaestroCommand;
  platform: MaestroReplayPlan['platform'];
  action: MaestroFailureReportAction;
  session: SessionState;
  nodes: SnapshotNode[];
  sanitize: DivergenceFieldSanitizer;
}) {
  const query = typedSuggestionQuery(params.command);
  if (!query || (params.platform !== 'android' && params.platform !== 'ios')) return [];
  const snapshot = { createdAt: Date.now(), nodes: params.nodes };
  const candidates = collectTypedMaestroCandidates(snapshot, query, params.platform);
  return rankAndDedupeReplaySuggestions(
    candidates.map((node) => ({
      node,
      nodeIndex: node.index,
      basis: suggestionBasis(query.selector, node),
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

type TypedSuggestionBasis = Extract<ReplayDivergenceSuggestionBasis, 'id' | 'label' | 'other'>;

function collectTypedMaestroCandidates(
  snapshot: { nodes: SnapshotNode[]; createdAt: number },
  query: TypedSuggestionQuery,
  platform: Extract<MaestroReplayPlan['platform'], 'android' | 'ios'>,
): SnapshotNode[] {
  return rankMaestroCandidates(snapshot, query.selector, platform, query.childOf).ranked;
}

type TypedSuggestionQuery = {
  selector: MaestroSelector;
  index?: number;
  childOf?: MaestroSelector;
};

function typedSuggestionQuery(command: MaestroCommand): TypedSuggestionQuery | undefined {
  if (isTargetInteraction(command)) return targetInteractionSuggestion(command);
  if (isObservationCommand(command)) return observationSuggestion(command);
  if (command.kind === 'swipe' && command.gesture.kind === 'target') {
    return { selector: command.gesture.from };
  }
  return undefined;
}

type TargetInteractionCommand = Extract<
  MaestroCommand,
  { kind: 'tapOn' | 'doubleTapOn' | 'longPressOn' }
>;

function isTargetInteraction(command: MaestroCommand): command is TargetInteractionCommand {
  return (
    command.kind === 'tapOn' || command.kind === 'doubleTapOn' || command.kind === 'longPressOn'
  );
}

function targetInteractionSuggestion(
  command: TargetInteractionCommand,
): TypedSuggestionQuery | undefined {
  if (command.target.space !== 'target') return undefined;
  if (command.kind === 'tapOn') {
    return {
      selector: command.target.selector,
      index: command.index,
      childOf: command.childOf,
    };
  }
  return { selector: command.target.selector };
}

type ObservationCommand = Extract<
  MaestroCommand,
  { kind: 'assertVisible' | 'assertNotVisible' | 'extendedWaitUntil' | 'scrollUntilVisible' }
>;

function isObservationCommand(command: MaestroCommand): command is ObservationCommand {
  return (
    command.kind === 'assertVisible' ||
    command.kind === 'assertNotVisible' ||
    command.kind === 'extendedWaitUntil' ||
    command.kind === 'scrollUntilVisible'
  );
}

function observationSuggestion(command: ObservationCommand): TypedSuggestionQuery | undefined {
  switch (command.kind) {
    case 'assertVisible':
    case 'assertNotVisible':
      return { selector: command.target };
    case 'extendedWaitUntil':
      return command.visible
        ? { selector: command.visible }
        : command.notVisible
          ? { selector: command.notVisible }
          : undefined;
    case 'scrollUntilVisible':
      return { selector: command.element };
  }
}

function suggestionBasis(selector: MaestroSelector, node: SnapshotNode): TypedSuggestionBasis {
  if (selector.id !== undefined) return 'id';
  if (
    selector.text !== undefined &&
    matchesMaestroTypedSelector(
      { ...node, label: undefined, value: undefined },
      { text: selector.text },
    )
  ) {
    return 'id';
  }
  if (selector.text !== undefined || selector.label !== undefined) return 'label';
  return 'other';
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

function collectExpandedScrubVars(values: Readonly<Record<string, string>>): ReplayVarScrubEntry[] {
  return Object.entries(values)
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value.length - left.value.length);
}

function collectMaestroTextScrubVars(
  command: MaestroEngineEvent['command'],
): ReplayVarScrubEntry[] {
  if (command.kind !== 'inputText' || command.text.length === 0) {
    return [];
  }
  return [{ name: `${command.kind}.text`, value: command.text }];
}
