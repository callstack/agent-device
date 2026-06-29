import { dispatchCommand, type CommandFlags } from '../core/dispatch.ts';
import { GESTURE_SUBCOMMAND_ERROR } from '../command-catalog.ts';
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
import { shouldGuardAndroidBlockingDialog } from './daemon-command-registry.ts';

const GESTURE_PLATFORM_COMMANDS: Readonly<Record<string, string>> = {
  pan: 'pan',
  fling: 'fling',
  swipe: 'swipe-preset',
  pinch: 'pinch',
  rotate: 'rotate-gesture',
  transform: 'transform-gesture',
};

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
  const commandResolution = resolveDispatchCommand(req);
  if (!commandResolution.ok) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        message: commandResolution.message,
      },
    };
  }
  const { platformCommand, dispatchRequest, recordedCommand } = commandResolution;

  const readinessResponse = await ensureGenericCommandReady(session, platformCommand);
  if (readinessResponse) return readinessResponse;
  const preflightReadiness = await ensureNoAndroidBlockingDialogReady(session, platformCommand);
  if ('response' in preflightReadiness) return preflightReadiness.response;

  const { resolvedPositionals, resolvedOut, recordedPositionals, recordedFlags } =
    resolveCommandPositionals(dispatchRequest);

  const actionStartedAt = Date.now();
  const dispatchContext = {
    ...contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
    surface: session.surface,
  };
  let data = await executeGenericPlatformCommand({
    session,
    sessionName: params.sessionName,
    logPath,
    command: platformCommand,
    request: dispatchRequest,
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
  const actionRecordedPositionals =
    recordedCommand === platformCommand ? recordedPositionals : (req.positionals ?? []);
  const actionRecordedFlags =
    recordedCommand === platformCommand ? recordedFlags : (req.flags ?? {});
  recordVisualizationAndAction({
    session,
    sessionStore,
    command: platformCommand,
    recordedCommand,
    resolvedPositionals,
    recordedPositionals: actionRecordedPositionals,
    recordedFlags: actionRecordedFlags,
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
  const { session, command, request, positionals, out, dispatchContext } = params;
  if (command !== 'screenshot') {
    return await dispatchCommand(session.device, command, positionals, out, {
      ...dispatchContext,
    });
  }
  const data = await dispatchScreenshotViaRuntime({
    session,
    sessionName: params.sessionName,
    outPath: positionals[0] ?? out,
    outputPlacement: resolveScreenshotOutputPlacement(request),
    dispatchContext,
  });
  if (request.flags?.overlayRefs && typeof data?.path === 'string') {
    await applyScreenshotOverlay(session, data, params.logPath);
  }
  return data;
}

type DispatchCommandResolution =
  | {
      ok: true;
      platformCommand: string;
      dispatchRequest: DaemonRequest;
      recordedCommand: string;
    }
  | { ok: false; message: string };

function resolveDispatchCommand(req: DaemonRequest): DispatchCommandResolution {
  if (
    req.command === 'pan' ||
    req.command === 'fling' ||
    req.command === 'rotate-gesture' ||
    req.command === 'transform-gesture'
  ) {
    return {
      ok: false,
      message:
        'Use gesture pan, gesture fling, gesture swipe, gesture rotate, or gesture transform.',
    };
  }
  if (req.command !== 'gesture') {
    return {
      ok: true,
      platformCommand: req.command,
      dispatchRequest: req,
      recordedCommand: req.command,
    };
  }
  const [subcommand, ...positionals] = req.positionals ?? [];
  const platformCommand = subcommand ? GESTURE_PLATFORM_COMMANDS[subcommand] : undefined;
  if (!platformCommand) {
    return { ok: false, message: GESTURE_SUBCOMMAND_ERROR };
  }
  return {
    ok: true,
    platformCommand,
    dispatchRequest: { ...req, command: platformCommand, positionals },
    recordedCommand: req.command,
  };
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
  recordedCommand: string;
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
    recordedCommand,
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
    command: recordedCommand,
    positionals: recordedPositionals,
    flags: recordedFlags,
    result: data ?? {},
  });
}
