import type { CommandFlags } from '@agent-device/contracts/command';
import type { SettleObservation } from '@agent-device/contracts/interaction';
import { commandSupportsSettleObservation } from '../core/command-descriptor/registry.ts';
import { dispatchCommand } from '../core/dispatch.ts';
import { requireCommandSupported } from './handlers/response.ts';
import { SessionStore } from './session-store.ts';
import type { DaemonCommandContext } from './context.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { buildSnapshotState, captureSnapshotData } from './handlers/snapshot-capture.ts';
import { setSessionSnapshot } from './session-snapshot.ts';
import {
  dispatchScreenshotViaRuntime,
  type ScreenshotOutputPlacement,
} from './screenshot-runtime.ts';
import {
  ensureAndroidBlockingSystemDialogReady,
  recoverAndroidBlockingSystemDialog,
} from './android-system-dialog.ts';
import { annotateScreenshotWithRefs } from './screenshot-overlay.ts';
import { markDeferredInteractionOutcome } from './deferred-interaction-outcome.ts';
import {
  augmentScrollVisualizationResult,
  recordTouchVisualizationEvent,
} from './recording-gestures.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { retiredScreenshotMaxSizeFlagError } from '@agent-device/contracts/capture';
import { expireRefFrame } from './ref-frame.ts';
import {
  resolveRefFrameEffect,
  shouldGuardAndroidBlockingDialog,
} from './daemon-command-registry.ts';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import {
  assertSupportedScreenshotPixelDensity,
  readScreenshotResultMetadata,
} from '../utils/screenshot-density.ts';
import { buildActionEventResult } from './session-event-action-presentation.ts';

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
  executePlatformCommand: typeof executeGenericPlatformCommand;
}): Promise<DaemonResponse> {
  const { req, session, logPath, sessionStore, contextFromFlags } = params;
  const platformCommand = req.command;

  const readinessResponse = await ensureGenericCommandReady(session, platformCommand);
  if (readinessResponse) return readinessResponse;
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

  const { resolvedPositionals, resolvedOut, recordedPositionals, recordedFlags } =
    resolveCommandPositionals(req);

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
  let data = await params.executePlatformCommand({
    session,
    sessionName: params.sessionName,
    logPath,
    command: platformCommand,
    request: req,
    positionals: resolvedPositionals,
    out: resolvedOut,
    dispatchContext,
  });
  const postflightReadiness = await ensureNoAndroidBlockingDialogReady(
    session,
    platformCommand,
    'after-command',
  );
  if ('response' in postflightReadiness) return postflightReadiness.response;
  if (
    'status' in preflightReadiness &&
    preflightReadiness.status === 'recovered' &&
    (!data || typeof data === 'object')
  ) {
    data ??= {};
    data.warning = preflightReadiness.warning;
  }

  const actionFinishedAt = Date.now();
  recordVisualizationAndAction({
    session,
    sessionStore,
    command: platformCommand,
    resolvedPositionals,
    recordedPositionals,
    recordedFlags,
    data,
    actionStartedAt,
    actionFinishedAt,
    flags: req.flags ?? {},
    clientArtifactPaths: req.meta?.clientArtifactPaths,
  });

  markDeferredInteractionOutcome({
    session,
    command: platformCommand,
    positionals: resolvedPositionals,
    flags: req.flags,
  });

  // Strictly after the deferred-outcome markers so settle's first capture folds
  // in the #1542 post-gesture stabilization, and after the recorded action so
  // the session history keeps the ACTION's own timing rather than the
  // observation wait that followed it.
  if (settlePlan.observe) {
    const settle = await settlePlan.observe();
    if (settle) data = { ...(data ?? {}), settle };
  }

  return { ok: true, data: data ?? {} };
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

async function ensureNoAndroidBlockingDialogReady(
  session: SessionState,
  platformCommand: string,
  phase: 'before-command' | 'after-command' = 'before-command',
): Promise<
  { status: 'clear' } | { status: 'recovered'; warning: string } | { response: DaemonResponse }
> {
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
): Promise<DaemonResponse | null> {
  const unsupported =
    platformCommand === 'viewport'
      ? null
      : requireCommandSupported(platformCommand, session.device, { hint: true });
  if (unsupported) return unsupported;
  if (
    session.device.platform !== 'android' ||
    isActiveProviderDevice(session.device) ||
    !session.screenRecording ||
    platformCommand === 'record' ||
    (await recoverAndroidBlockingSystemDialog({ session })).status !== 'failed'
  ) {
    return null;
  }
  return {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'Android system dialog blocked the recording session',
    },
  };
}

export async function executeGenericPlatformCommand(params: {
  session: SessionState;
  sessionName: string;
  logPath: string;
  command: string;
  request: DaemonRequest;
  positionals: string[];
  out: string | undefined;
  dispatchContext: DaemonCommandContext;
}): Promise<Record<string, unknown> | void> {
  const { session, command, positionals, out, dispatchContext } = params;
  if (command === 'screenshot') {
    return await executeScreenshotPlatformCommand(params);
  }
  return await dispatchCommand(session.device, command, positionals, out, {
    ...dispatchContext,
  });
}

async function executeScreenshotPlatformCommand(params: {
  session: SessionState;
  sessionName: string;
  logPath: string;
  request: DaemonRequest;
  positionals: string[];
  out: string | undefined;
  dispatchContext: DaemonCommandContext;
}): Promise<Record<string, unknown>> {
  const { session, request, positionals, out, dispatchContext } = params;
  const retiredMaxSize = retiredScreenshotMaxSizeFlagError('screenshot', request.flags);
  if (retiredMaxSize) throw new AppError('INVALID_ARGS', retiredMaxSize);
  assertSupportedScreenshotPixelDensity(session.device, request.flags?.screenshotPixelDensity);
  const data = await dispatchScreenshotViaRuntime({
    session,
    sessionName: params.sessionName,
    outPath: positionals[0] ?? out,
    outputPlacement: resolveScreenshotOutputPlacement(request),
    dispatchContext,
  });
  if (typeof data.path !== 'string') {
    return data;
  }
  if (request.flags?.overlayRefs) {
    await applyScreenshotOverlay(session, data, params.logPath);
  }
  Object.assign(
    data,
    await readScreenshotResultMetadata({
      device: session.device,
      path: data.path,
      requestedPixelDensity: request.flags?.screenshotPixelDensity,
      scale: request.flags?.screenshotScale,
    }),
  );
  return data;
}

function resolveScreenshotOutputPlacement(req: DaemonRequest): ScreenshotOutputPlacement {
  if (req.command !== 'screenshot') return 'default';
  if ((req.positionals ?? [])[0]) return 'positional';
  if (req.flags?.out) return 'out';
  return 'default';
}

function resolveCommandPositionals(req: DaemonRequest): {
  resolvedPositionals: string[];
  resolvedOut: string | undefined;
  recordedPositionals: string[];
  recordedFlags: Record<string, unknown>;
} {
  return req.command === 'screenshot'
    ? resolveScreenshotCommandPositionals(req)
    : resolveDefaultCommandPositionals(req);
}

function resolveDefaultCommandPositionals(req: DaemonRequest): {
  resolvedPositionals: string[];
  resolvedOut: string | undefined;
  recordedPositionals: string[];
  recordedFlags: Record<string, unknown>;
} {
  const positionals = req.positionals ?? [];
  return {
    resolvedPositionals: positionals,
    resolvedOut: req.flags?.out,
    recordedPositionals: positionals,
    recordedFlags: req.flags ?? {},
  };
}

function resolveScreenshotCommandPositionals(req: DaemonRequest): {
  resolvedPositionals: string[];
  resolvedOut: string | undefined;
  recordedPositionals: string[];
  recordedFlags: Record<string, unknown>;
} {
  const positionals = req.positionals ?? [];
  const resolvedPositionals = resolveScreenshotPositionals(positionals, req.meta?.cwd);
  const resolvedOut = resolveScreenshotOut(req.flags?.out, req.meta?.cwd);
  const recordedPositionals = resolvedPositionals;
  const recordedFlags = resolvedOut
    ? { ...(req.flags ?? {}), out: resolvedOut }
    : (req.flags ?? {});
  return { resolvedPositionals, resolvedOut, recordedPositionals, recordedFlags };
}

function resolveScreenshotPositionals(positionals: string[], cwd: string | undefined): string[] {
  const outPath = positionals[0];
  if (!outPath) return positionals;
  return [SessionStore.expandHome(outPath, cwd), ...positionals.slice(1)];
}

function resolveScreenshotOut(
  out: string | undefined,
  cwd: string | undefined,
): string | undefined {
  return out ? SessionStore.expandHome(out, cwd) : out;
}

async function applyScreenshotOverlay(
  session: SessionState,
  data: Record<string, unknown>,
  logPath: string,
): Promise<void> {
  const overlaySnapshotFlags = {
    snapshotInteractiveOnly: true,
  } satisfies CommandFlags;
  const overlaySnapshotData = await captureSnapshotData({
    device: session.device,
    session,
    flags: overlaySnapshotFlags,
    logPath,
    snapshotScope: undefined,
  });
  const overlaySnapshot = buildSnapshotState(overlaySnapshotData, overlaySnapshotFlags);
  setSessionSnapshot(session, overlaySnapshot);
  const overlayRefs = await annotateScreenshotWithRefs({
    screenshotPath: data.path as string,
    snapshot: overlaySnapshot,
  });
  data.overlayRefs = overlayRefs;
}

function recordVisualizationAndAction(params: {
  session: SessionState;
  sessionStore: SessionStore;
  command: string;
  resolvedPositionals: string[];
  recordedPositionals: string[];
  recordedFlags: Record<string, unknown>;
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
    recordedPositionals,
    recordedFlags,
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
    positionals: recordedPositionals,
    flags: recordedFlags,
    result: buildActionEventResult({ command, meta: { clientArtifactPaths } }, data ?? {}),
  });
}
