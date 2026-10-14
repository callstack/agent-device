import { collectMaestroFailureSuggestions, type MaestroFailedAction } from '@agent-device/maestro';
import type { DaemonError } from '@agent-device/kernel/errors';
import type { SnapshotDiagnosticsSummary } from '@agent-device/contracts/capture';
import { formatScriptArg } from '@agent-device/ad-script';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type {
  ReplayBackendActionFailure,
  ReplaySessionObservation,
  ReplaySessionStore,
} from '@agent-device/contracts/replay-backend';
import { type DaemonResponse } from '@agent-device/kernel/contracts';
import { buildReplayBackendActionFailureResponse } from './replay-backend-failure.ts';

export type MaestroFailureReportAction = ReplayBackendActionFailure['captureAction'];

export type MaestroFailureReportProjection = {
  readonly command: { readonly kind: string };
  readonly source: MaestroFailedAction['source'];
  readonly progress: { readonly command: string; readonly value?: string };
  readonly action: MaestroFailureReportAction;
};

export function buildTypedMaestroFailureReportProjection(
  failure: MaestroFailedAction,
  req: DaemonWireRequest,
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
  readonly req: DaemonWireRequest;
  readonly sessionStore: ReplaySessionStore;
  readonly observationStore: ReplaySessionObservation;
  readonly logPath: string;
  readonly snapshotDiagnostics?: SnapshotDiagnosticsSummary;
}): Promise<DaemonResponse> {
  const { failure, req } = params;
  const report = buildTypedMaestroFailureReportProjection(failure, req);
  return await buildReplayBackendActionFailureResponse({
    error: params.error,
    req,
    sessionStore: params.sessionStore,
    observationStore: params.observationStore,
    logPath: params.logPath,
    replayPath: params.replayPath,
    stepIndex: failure.stepIndex,
    source: failure.source,
    action: failure.action,
    actionLabel: [failure.action, formatMaestroActionValue(failure.value)]
      .filter(Boolean)
      .join(' '),
    captureAction: report.action,
    isControl: failure.isControl,
    redactions: failure.redactions,
    resume: failure.resume,
    artifactPaths: failure.artifactPaths,
    warnings: failure.warnings,
    snapshotDiagnostics: params.snapshotDiagnostics,
    suggestNodes: (snapshot) => collectMaestroFailureSuggestions(failure, snapshot),
  });
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
