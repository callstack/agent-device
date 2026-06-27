import { asAppError, normalizeError } from '../../utils/errors.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import {
  startAppleXctracePerfCapture,
  stopAppleXctracePerfCapture,
  writeAppleXctracePerfReport,
  type AppleXctracePerfMode,
  type AppleXctracePerfResult,
} from '../../platforms/ios/perf-xctrace.ts';
import { PERF_AREA_ERROR_MESSAGE } from '../../contracts/perf.ts';
import { errorResponse, type DaemonFailureResponse } from './response.ts';
import { recordSessionAction } from './handler-utils.ts';

type NativePerfParams = {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
};

type NativePerfRequest = {
  area: 'cpu' | 'trace';
  mode: AppleXctracePerfMode;
  action: 'start' | 'stop' | 'report';
  kind: 'xctrace';
  template?: string;
  outPath?: string;
  tracePath?: string;
};

export async function handleNativePerfCommand(
  params: NativePerfParams,
  session: SessionState,
): Promise<DaemonResponse> {
  const parsed = resolveNativePerfRequest(params.req);
  if (!parsed.ok) return parsed;
  if (session.device.platform === 'android') {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      'Android native profiling belongs to the Android perf rollout; Apple xctrace perf supports iOS and macOS sessions only.',
    );
  }
  if (session.device.platform !== 'ios' && session.device.platform !== 'macos') {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      `Apple xctrace perf is not supported on ${session.device.platform}.`,
    );
  }
  if (!session.appBundleId) {
    return errorResponse(
      'INVALID_ARGS',
      'Apple xctrace perf requires an active app session. Run open <app> first.',
    );
  }

  try {
    if (parsed.action === 'start') {
      return await handleNativePerfStart(params, session, parsed);
    }
    if (parsed.action === 'stop') {
      return await handleNativePerfStop(params, session, parsed);
    }
    return await handleNativePerfReport(params, session, parsed);
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function resolveNativePerfRequest(
  req: DaemonRequest,
): ({ ok: true } & NativePerfRequest) | DaemonFailureResponse {
  const positionals = req.positionals ?? [];
  const area = positionals[0]?.toLowerCase();
  if (area === 'cpu') return resolveNativeCpuPerfRequest(positionals);
  if (area === 'trace') return resolveNativeTracePerfRequest(positionals);
  return errorResponse('INVALID_ARGS', PERF_AREA_ERROR_MESSAGE);
}

function resolveNativeCpuPerfRequest(
  positionals: string[],
): ({ ok: true } & NativePerfRequest) | DaemonFailureResponse {
  if (positionals[1]?.toLowerCase() !== 'profile') {
    return errorResponse('INVALID_ARGS', 'perf cpu requires profile');
  }
  const action = readNativePerfAction(positionals[2], 'perf cpu profile', true);
  if (!action.ok) return action;
  const kind = readXctraceKind(positionals[3]);
  if (!kind.ok) return kind;
  return {
    ok: true,
    area: 'cpu',
    mode: 'cpu-profile',
    action: action.value,
    kind: 'xctrace',
    template: positionals[4] || undefined,
    outPath: positionals[5] || undefined,
    tracePath: positionals[6] || undefined,
  };
}

function resolveNativeTracePerfRequest(
  positionals: string[],
): ({ ok: true } & NativePerfRequest) | DaemonFailureResponse {
  const action = readNativePerfAction(positionals[1], 'perf trace', false);
  if (!action.ok) return action;
  const kind = readXctraceKind(positionals[2]);
  if (!kind.ok) return kind;
  return {
    ok: true,
    area: 'trace',
    mode: 'trace',
    action: action.value,
    kind: 'xctrace',
    template: positionals[3] || undefined,
    outPath: positionals[4] || undefined,
    tracePath: positionals[5] || undefined,
  };
}

function readNativePerfAction(
  value: string | undefined,
  label: string,
  allowReport: boolean,
): { ok: true; value: NativePerfRequest['action'] } | DaemonFailureResponse {
  const action = value?.toLowerCase();
  if (action === 'start' || action === 'stop' || (allowReport && action === 'report')) {
    return { ok: true, value: action };
  }
  return errorResponse(
    'INVALID_ARGS',
    allowReport ? `${label} requires start, stop, or report` : `${label} requires start or stop`,
  );
}

function readXctraceKind(value: string | undefined): { ok: true } | DaemonFailureResponse {
  return value?.toLowerCase() === 'xctrace'
    ? { ok: true }
    : errorResponse('INVALID_ARGS', 'perf native collection currently supports --kind xctrace');
}

async function handleNativePerfStart(
  params: NativePerfParams,
  session: SessionState,
  request: NativePerfRequest,
): Promise<DaemonResponse> {
  if (session.applePerf?.active) {
    return errorResponse('INVALID_ARGS', 'Apple xctrace perf capture already in progress');
  }
  const template = request.template ?? defaultAppleXctraceTemplate(request.mode);
  const outPath = resolveNativePerfOutPath(params, request);
  const capture = await startAppleXctracePerfCapture({
    device: session.device,
    appBundleId: session.appBundleId as string,
    mode: request.mode,
    template,
    outPath,
  });
  session.applePerf = { ...(session.applePerf ?? {}), active: capture };
  params.sessionStore.set(params.sessionName, session);
  const data = compactNativePerfResult('started', capture);
  recordNativePerfAction(params, session, data);
  return { ok: true, data };
}

async function handleNativePerfStop(
  params: NativePerfParams,
  session: SessionState,
  request: NativePerfRequest,
): Promise<DaemonResponse> {
  const capture = session.applePerf?.active;
  if (!capture) {
    return errorResponse('INVALID_ARGS', 'no active Apple xctrace perf capture');
  }
  const outPath = request.outPath
    ? SessionStore.expandHome(request.outPath, params.req.meta?.cwd)
    : capture.outPath;
  let result: AppleXctracePerfResult;
  try {
    result = await stopAppleXctracePerfCapture(capture, outPath);
  } catch (error) {
    if (didCleanupNativePerfCapture(error)) {
      clearNativePerfCapture(params, session);
    }
    throw error;
  }
  storeStoppedNativePerfCapture(params, session, result);
  const data = compactNativePerfResult('stopped', result);
  recordNativePerfAction(params, session, data);
  return { ok: true, data };
}

function clearNativePerfCapture(params: NativePerfParams, session: SessionState): void {
  session.applePerf = {
    ...(session.applePerf ?? {}),
    active: undefined,
  };
  params.sessionStore.set(params.sessionName, session);
}

function didCleanupNativePerfCapture(error: unknown): boolean {
  return asAppError(error).details?.captureCleanedUp === true;
}

function storeStoppedNativePerfCapture(
  params: NativePerfParams,
  session: SessionState,
  result: AppleXctracePerfResult,
): void {
  session.applePerf = {
    ...(session.applePerf ?? {}),
    active: undefined,
    lastMode: result.mode,
    ...lastNativePerfArtifactState(result),
  };
  params.sessionStore.set(params.sessionName, session);
}

function lastNativePerfArtifactState(result: AppleXctracePerfResult): Record<string, string> {
  return result.mode === 'cpu-profile'
    ? { lastProfileTracePath: result.outPath, lastProfileTemplate: result.template }
    : { lastTracePath: result.outPath };
}

async function handleNativePerfReport(
  params: NativePerfParams,
  session: SessionState,
  request: NativePerfRequest,
): Promise<DaemonResponse> {
  if (request.mode !== 'cpu-profile') {
    return errorResponse('INVALID_ARGS', 'perf trace does not support report');
  }
  if (session.applePerf?.active) {
    return errorResponse(
      'INVALID_ARGS',
      'perf cpu profile report requires a stopped profile trace; stop the active capture first.',
    );
  }
  const outPath = resolveNativePerfOutPath(params, request);
  const tracePath = resolveNativePerfReportTracePath(session, request);
  if (!tracePath.ok) {
    return tracePath;
  }
  const report = await writeAppleXctracePerfReport({
    tracePath: SessionStore.expandHome(tracePath.value, params.req.meta?.cwd),
    outPath,
    mode: request.mode,
    template: session.applePerf?.lastProfileTemplate ?? request.template,
    appBundleId: session.appBundleId,
  });
  const data = { perf: 'reported', ...report };
  recordNativePerfAction(params, session, data);
  return { ok: true, data };
}

function resolveNativePerfReportTracePath(
  session: SessionState,
  request: NativePerfRequest,
): { ok: true; value: string } | DaemonFailureResponse {
  const tracePath =
    request.tracePath ??
    session.applePerf?.lastProfileTracePath ??
    session.applePerf?.active?.outPath;
  if (tracePath) return { ok: true, value: tracePath };
  return errorResponse(
    'INVALID_ARGS',
    'perf cpu profile report requires a stopped profile trace or tracePath option',
  );
}

function recordNativePerfAction(
  params: NativePerfParams,
  session: SessionState,
  data: Record<string, unknown>,
): void {
  recordSessionAction(params.sessionStore, session, params.req, 'perf', data);
}

function resolveNativePerfOutPath(params: NativePerfParams, request: NativePerfRequest): string {
  if (request.outPath) return SessionStore.expandHome(request.outPath, params.req.meta?.cwd);
  const sessionDir = params.sessionStore.ensureSessionDir(params.sessionName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const extension = request.action === 'report' ? 'json' : 'trace';
  return `${sessionDir}/perf-${request.mode}-${timestamp}.${extension}`;
}

function defaultAppleXctraceTemplate(mode: AppleXctracePerfMode): string {
  return mode === 'cpu-profile' ? 'Time Profiler' : 'Animation Hitches';
}

function compactNativePerfResult(
  state: 'started' | 'stopped',
  result: {
    kind: 'xctrace';
    mode: AppleXctracePerfMode;
    template: string;
    outPath: string;
    appBundleId: string;
    deviceId: string;
    platform: string;
    targetPids: number[];
    targetProcesses: string[];
    startedAt: string;
    endedAt?: string;
  },
): Record<string, unknown> {
  return {
    perf: state,
    kind: result.kind,
    mode: result.mode,
    template: result.template,
    outPath: result.outPath,
    appBundleId: result.appBundleId,
    deviceId: result.deviceId,
    platform: result.platform,
    targetPids: result.targetPids,
    targetProcesses: result.targetProcesses,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  };
}
