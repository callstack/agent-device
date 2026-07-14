import { dispatchCommand, type CommandFlags } from '../core/dispatch.ts';
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
import {
  isNavigationSensitiveAction,
  markAndroidSnapshotFreshness,
} from './android-snapshot-freshness.ts';
import {
  augmentScrollVisualizationResult,
  recordTouchVisualizationEvent,
} from './recording-gestures.ts';
import { markPostGestureStabilization } from './post-gesture-stabilization.ts';
import { normalizeError } from '../kernel/errors.ts';
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
}): Promise<DaemonResponse> {
  const { req, session, logPath, sessionStore, contextFromFlags } = params;
  const platformCommand = req.command;

  const readinessResponse = await ensureGenericCommandReady(session, platformCommand);
  if (readinessResponse) return readinessResponse;
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
  // tv-remote/app-switcher/viewport/focus, ...). The daemon effect classification
  // is the honesty guard that decides which of these mutate; expire the frame
  // before dispatching so a later ref cannot reuse it. Read-only generic leaves
  // (screenshot) are classified `preserve` and leave the frame untouched.
  if (resolveRefFrameEffect(req) === 'may-invalidate') {
    expireRefFrame(session);
  }
  let data = await executeGenericPlatformCommand({
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
  });

  if (isNavigationSensitiveAction(platformCommand)) {
    markAndroidSnapshotFreshness(session, platformCommand);
  }
  markPostGestureStabilization(session, platformCommand, resolvedPositionals, req.flags);

  return { ok: true, data: data ?? {} };
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
  const unsupported = requireCommandSupported(platformCommand, session.device, { hint: true });
  if (unsupported) return unsupported;
  if (
    session.device.platform !== 'android' ||
    isActiveProviderDevice(session.device) ||
    !session.recording ||
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

async function executeGenericPlatformCommand(params: {
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
      maxSize: request.flags?.screenshotMaxSize,
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
    result: data ?? {},
  });
}
