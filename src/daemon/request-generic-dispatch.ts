import type { CommandFlags } from '@agent-device/contracts/command';
import type { SettleObservation } from '@agent-device/contracts/interaction';
import {
  commandSupportsSettleObservation,
  commandUsesDeviceRuntimeExecution,
} from '../core/command-descriptor/registry.ts';
import { dispatchCommand } from '../core/dispatch.ts';
import { requireCommandSupported } from './handlers/response.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonCommandContext } from './context.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import {
  ensureAndroidBlockingSystemDialogReady,
  recoverAndroidBlockingSystemDialog,
} from './android-system-dialog.ts';
import { markDeferredInteractionOutcome } from './deferred-interaction-outcome.ts';
import {
  augmentScrollVisualizationResult,
  recordTouchVisualizationEvent,
} from './recording-gestures.ts';
import { normalizeError } from '@agent-device/kernel/errors';
import { expireRefFrame } from './ref-frame.ts';
import {
  resolveRefFrameEffect,
  shouldGuardAndroidBlockingDialog,
} from './daemon-command-registry.ts';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import { buildActionEventResult } from './session-event-action-presentation.ts';

export type GenericPlatformExecutionParams = {
  session: SessionState;
  sessionName: string;
  logPath: string;
  command: string;
  request: DaemonRequest;
  positionals: string[];
  out: string | undefined;
  dispatchContext: DaemonCommandContext;
};

/**
 * What actually performs a generic leaf's platform work. Legacy leaves get
 * {@link executeGenericPlatformCommand}; a command migrated onto a request-bound device runtime
 * supplies its own already-admitted, already-bound closure instead (ADR 0019).
 */
export type GenericPlatformExecution = (
  params: GenericPlatformExecutionParams,
) => Promise<Record<string, unknown> | void>;

/**
 * What the session action records for this request. A runtime-owned leaf may normalize its
 * arguments (a screenshot destination is a user-typed path) and records the normalized form.
 */
export type RecordedGenericRequest = Readonly<{
  positionals: string[];
  flags: Record<string, unknown>;
}>;

/** What a runtime-owned generic leaf resolves to before the dispatcher runs: a refusal, or the
 * bound execution plus whatever the session action should record for it. */
export type ResolvedGenericExecution =
  | Readonly<{ ok: false; response: DaemonResponse }>
  | Readonly<{ ok: true; execute: GenericPlatformExecution; recorded?: RecordedGenericRequest }>;

export async function dispatchGenericCommand(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  contextFromFlags: (
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ) => DaemonCommandContext;
  executePlatformCommand: GenericPlatformExecution;
  recordedRequest?: RecordedGenericRequest;
}): Promise<DaemonResponse> {
  const { req, session, logPath, sessionStore, contextFromFlags } = params;
  const platformCommand = req.command;

  const commandReadiness = await ensureGenericCommandReady(session, platformCommand);
  if (commandReadiness.response) return commandReadiness.response;
  // #1638: freeze the settled diff's baseline before anything can mutate the
  // screen or the stored snapshot — including the Android dialog preflight.
  const settlePlan = await planGenericSettleObservation({
    req,
    session,
    sessionName: params.sessionName,
    logPath,
    sessionStore,
    contextFromFlags,
    command: platformCommand,
    flags: req.flags,
  });
  if ('response' in settlePlan) return settlePlan.response;
  const preflightReadiness = await ensureNoAndroidBlockingDialogReady(session, platformCommand);
  if ('response' in preflightReadiness) return preflightReadiness.response;

  const resolvedPositionals = req.positionals ?? [];
  const recorded = params.recordedRequest ?? {
    positionals: resolvedPositionals,
    flags: req.flags ?? {},
  };

  const actionStartedAt = Date.now();
  const dispatchContext = {
    ...contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
    surface: session.surface,
  };
  // ADR 0014 side-effect seam for generic-route leaves (back/home/rotate/scroll/
  // tv-remote/app-switcher/viewport/focus). Effect classification
  // is the honesty guard that decides which of these mutate; expire the frame
  // before dispatching so a later ref cannot reuse it. Read-only generic leaves
  // (screenshot) are classified `preserve` and leave the frame untouched.
  if (resolveRefFrameEffect(req) === 'may-invalidate') {
    expireRefFrame(session);
  }
  const data = await params.executePlatformCommand({
    session,
    sessionName: params.sessionName,
    logPath,
    command: platformCommand,
    request: req,
    positionals: resolvedPositionals,
    out: req.flags?.out,
    dispatchContext,
  });
  return await finalizeGenericCommand({
    req,
    session,
    sessionStore,
    command: platformCommand,
    resolvedPositionals,
    recorded,
    data,
    actionStartedAt,
    readinessWarnings: [
      commandReadiness.warning,
      preflightReadiness.status === 'recovered' ? preflightReadiness.warning : undefined,
    ],
    observeSettle: settlePlan.observe,
  });
}

/**
 * Everything a generic leaf owes after its platform work returns: the post-command dialog check,
 * the recovered-dialog warning, the recorded action, deferred interaction markers, and the opt-in
 * settle observation — in that order, because each one depends on the previous having happened.
 */
async function finalizeGenericCommand(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionStore: SessionStore;
  command: string;
  resolvedPositionals: string[];
  recorded: RecordedGenericRequest;
  data: Record<string, unknown> | void;
  actionStartedAt: number;
  readinessWarnings: readonly (string | undefined)[];
  observeSettle?: () => Promise<SettleObservation | undefined>;
}): Promise<DaemonResponse> {
  const { req, session, sessionStore, command } = params;
  const postflightReadiness = await ensureNoAndroidBlockingDialogReady(
    session,
    command,
    'after-command',
  );
  if ('response' in postflightReadiness) return postflightReadiness.response;

  let data = withReadinessWarnings(params.data, params.readinessWarnings);
  recordVisualizationAndAction({
    session,
    sessionStore,
    command,
    resolvedPositionals: params.resolvedPositionals,
    recorded: params.recorded,
    data,
    actionStartedAt: params.actionStartedAt,
    actionFinishedAt: Date.now(),
    flags: req.flags ?? {},
    clientArtifactPaths: req.meta?.clientArtifactPaths,
  });

  markDeferredInteractionOutcome({
    session,
    command,
    positionals: params.resolvedPositionals,
    flags: req.flags,
  });

  // Strictly after the deferred-outcome markers so settle's first capture folds
  // in the #1542 post-gesture stabilization, and after the recorded action so
  // the session history keeps the ACTION's own timing rather than the
  // observation wait that followed it.
  if (params.observeSettle) {
    const settle = await params.observeSettle();
    if (settle) data = { ...(data ?? {}), settle };
  }

  return { ok: true, data: data ?? {} };
}

/** Readiness warnings are disclosed on the result they made possible without clobbering its data. */
function withReadinessWarnings(
  data: Record<string, unknown> | void,
  warnings: readonly (string | undefined)[],
): Record<string, unknown> | void {
  const appendedWarnings = warnings.filter(
    (warning): warning is string => typeof warning === 'string' && warning.length > 0,
  );
  if (appendedWarnings.length === 0) return data;
  if (data && typeof data !== 'object') return data;
  const existingWarnings =
    data && typeof data.warning === 'string' && data.warning.length > 0 ? [data.warning] : [];
  return { ...(data ?? {}), warning: [...existingWarnings, ...appendedWarnings].join(' ') };
}

/**
 * `--settle` (#1638) is opt-in and its observation runs the interaction
 * runtime — a subgraph this dispatcher otherwise never touches, and one that a
 * static edge would fold into the daemon-server type cycle. Reach it through a
 * lazy seam instead, gated on the caller actually passing a settle flag, and
 * hold only the returned closure so no type edge exists either. A scroll/back
 * without settle, and every non-settle generic leaf, load nothing.
 */
async function planGenericSettleObservation(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  contextFromFlags: (
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ) => DaemonCommandContext;
  command: string;
  flags: CommandFlags | undefined;
}): Promise<
  { response: DaemonResponse } | { observe?: () => Promise<SettleObservation | undefined> }
> {
  if (!commandSupportsSettleObservation(params.command) || !usesSettleFlags(params.flags)) {
    return {};
  }
  const settle = await import('./generic-settle.ts');
  return settle.planGenericSettleObservation(params);
}

/** Any settle flag at all — `--settle-quiet` alone still owes the caller its rejection. */
function usesSettleFlags(flags: CommandFlags | undefined): boolean {
  return flags?.settle === true || flags?.settleQuietMs !== undefined;
}

type AndroidDialogReadiness =
  | { status: 'clear' }
  | { status: 'recovered'; warning: string }
  | { response: DaemonResponse };

type GenericCommandReadiness = {
  response?: DaemonResponse;
  warning?: string;
};

async function ensureNoAndroidBlockingDialogReady(
  session: SessionState,
  platformCommand: string,
  phase: 'before-command' | 'after-command' = 'before-command',
): Promise<AndroidDialogReadiness> {
  if (session.device.platform !== 'android' || !shouldGuardAndroidBlockingDialog(platformCommand)) {
    return { status: 'clear' };
  }
  if (isActiveProviderDevice(session.device)) {
    return { status: 'clear' };
  }
  try {
    return await ensureAndroidBlockingSystemDialogReady({
      session,
      command: platformCommand,
      phase,
    });
  } catch (error) {
    return { response: { ok: false, error: normalizeError(error) } };
  }
}

async function ensureGenericCommandReady(
  session: SessionState,
  platformCommand: string,
): Promise<GenericCommandReadiness> {
  // A device-runtime command has no capability bucket: its exact owner facts already admitted it
  // (or refused it) before this route was reached.
  const unsupported = commandUsesDeviceRuntimeExecution(platformCommand)
    ? null
    : requireCommandSupported(platformCommand, session.device, { hint: true });
  if (unsupported) return { response: unsupported };
  if (
    session.device.platform !== 'android' ||
    isActiveProviderDevice(session.device) ||
    !session.screenRecording ||
    platformCommand === 'record'
  ) {
    return {};
  }
  const recovery = await recoverAndroidBlockingSystemDialog({ session });
  if (recovery.status !== 'failed') {
    return recovery.status === 'unknown' ? { warning: recovery.warning } : {};
  }
  return {
    response: {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'Android system dialog blocked the recording session',
      },
    },
  };
}

export const executeGenericPlatformCommand: GenericPlatformExecution = async (params) => {
  const { session, command, positionals, out, dispatchContext } = params;
  return await dispatchCommand(session.device, command, positionals, out, {
    ...dispatchContext,
  });
};

function recordVisualizationAndAction(params: {
  session: SessionState;
  sessionStore: SessionStore;
  command: string;
  resolvedPositionals: string[];
  recorded: RecordedGenericRequest;
  data: Record<string, unknown> | void;
  actionStartedAt: number;
  actionFinishedAt: number;
  flags: Record<string, unknown>;
  clientArtifactPaths: Record<string, string> | undefined;
}): void {
  const {
    session,
    sessionStore,
    command,
    resolvedPositionals,
    recorded,
    data,
    actionStartedAt,
    actionFinishedAt,
    flags,
    clientArtifactPaths,
  } = params;
  const visualizationData = augmentScrollVisualizationResult(
    session,
    command,
    resolvedPositionals,
    data as Record<string, unknown> | void,
  );
  recordTouchVisualizationEvent(
    session,
    command,
    resolvedPositionals,
    visualizationData as Record<string, unknown> | void,
    flags,
    actionStartedAt,
    actionFinishedAt,
  );
  sessionStore.recordAction(session, {
    command,
    positionals: recorded.positionals,
    flags: recorded.flags,
    result: buildActionEventResult({ command, meta: { clientArtifactPaths } }, data ?? {}),
  });
}
