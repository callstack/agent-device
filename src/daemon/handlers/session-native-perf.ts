import path from 'node:path';
import {
  isPerfKind,
  isPerfSubject,
  PERF_KIND_ERROR_MESSAGE,
  PERF_SUBJECT_ERROR_MESSAGE,
} from '../../contracts/perf.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import {
  startAndroidPerfettoTrace,
  startAndroidSimpleperfProfile,
  stopAndroidPerfettoTrace,
  stopAndroidSimpleperfProfile,
  writeAndroidSimpleperfReport,
  type AndroidNativePerfKind,
  type AndroidNativePerfSession,
} from '../../platforms/android/perf.ts';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { errorResponse, type DaemonFailureResponse } from './response.ts';

export async function handleNativePerfCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  session: SessionState;
  androidAdbExecutor?: AndroidAdbExecutor;
  area: 'cpu' | 'trace';
}): Promise<DaemonResponse> {
  const request = resolveNativePerfRequest(params.req, params.area);
  if (!request.ok) return request;
  const { session } = params;
  if (session.device.platform !== 'android') {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      'Android native perf collectors are supported only on Android sessions.',
    );
  }
  if (!session.appBundleId) {
    return errorResponse(
      'COMMAND_FAILED',
      'No Android app package is associated with this session.',
      {
        hint: 'Run open <app> first so perf can resolve the package and process identity.',
      },
    );
  }

  try {
    const data =
      request.area === 'cpu'
        ? await runAndroidCpuProfileCommand(params, session, session.appBundleId, request)
        : await runAndroidTraceCommand(params, session, session.appBundleId, request);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

type NativePerfRequest =
  | {
      ok: true;
      area: 'cpu';
      subject: 'profile';
      action: 'start' | 'stop' | 'report';
      kind: 'simpleperf';
      outPath?: string;
    }
  | {
      ok: true;
      area: 'trace';
      action: 'start' | 'stop';
      kind: 'perfetto';
      outPath?: string;
    };

type NativePerfHandlerParams = {
  sessionName: string;
  sessionStore: SessionStore;
  req: DaemonRequest;
  session: SessionState;
  androidAdbExecutor?: AndroidAdbExecutor;
};

function resolveNativePerfRequest(
  req: DaemonRequest,
  area: 'cpu' | 'trace',
): NativePerfRequest | DaemonFailureResponse {
  const outPath = readNativePerfOutPath(req, area);
  return area === 'cpu'
    ? resolveCpuProfileRequest(req, outPath)
    : resolveTraceRequest(req, outPath);
}

function resolveCpuProfileRequest(
  req: DaemonRequest,
  outPath: string | undefined,
): NativePerfRequest | DaemonFailureResponse {
  const subject = readPositional(req, 1);
  const action = readPositional(req, 2);
  const kind = readPositional(req, 3);
  if (!isPerfSubject(subject)) return errorResponse('INVALID_ARGS', PERF_SUBJECT_ERROR_MESSAGE);
  if (!isCpuProfileAction(action)) {
    return errorResponse('INVALID_ARGS', 'perf cpu profile action must be start, stop, or report');
  }
  if (kind !== 'simpleperf') {
    return errorResponse('INVALID_ARGS', 'perf cpu profile requires --kind simpleperf');
  }
  return { ok: true, area: 'cpu', subject, action, kind, outPath };
}

function resolveTraceRequest(
  req: DaemonRequest,
  outPath: string | undefined,
): NativePerfRequest | DaemonFailureResponse {
  const action = readPositional(req, 1);
  const kind = readPositional(req, 2);
  if (!isTraceAction(action)) {
    return errorResponse('INVALID_ARGS', 'perf trace action must be start or stop');
  }
  if (!isPerfKind(kind)) return errorResponse('INVALID_ARGS', PERF_KIND_ERROR_MESSAGE);
  if (kind !== 'perfetto') {
    return errorResponse('INVALID_ARGS', 'perf trace requires --kind perfetto');
  }
  return { ok: true, area: 'trace', action, kind, outPath };
}

function readPositional(req: DaemonRequest, index: number): string {
  return (req.positionals?.[index] ?? '').toLowerCase();
}

function isCpuProfileAction(action: string): action is 'start' | 'stop' | 'report' {
  return action === 'start' || action === 'stop' || action === 'report';
}

function isTraceAction(action: string): action is 'start' | 'stop' {
  return action === 'start' || action === 'stop';
}

function storeNativePerfSession(
  params: NativePerfHandlerParams,
  result: AndroidNativePerfSession & Record<string, unknown>,
): Record<string, unknown> {
  params.sessionStore.set(params.sessionName, {
    ...params.session,
    nativePerf: { android: result },
  });
  return compactNativePerfResponse(result);
}

function resolveNativePerfOutPath(
  params: { sessionName: string; sessionStore: SessionStore; req: DaemonRequest },
  requestedPath: string | undefined,
  fallbackFileName: string,
): string {
  if (requestedPath) return SessionStore.expandHome(requestedPath, params.req.meta?.cwd);
  return pathJoinSessionArtifact(params.sessionStore, params.sessionName, fallbackFileName);
}

function readNativePerfOutPath(req: DaemonRequest, area: 'cpu' | 'trace'): string | undefined {
  if (typeof req.flags?.out === 'string' && req.flags.out.length > 0) return req.flags.out;
  const positionals = req.positionals ?? [];
  const outIndex = area === 'cpu' ? 5 : 4;
  const outPath = positionals[outIndex];
  return outPath ? outPath : undefined;
}

async function runAndroidCpuProfileCommand(
  params: NativePerfHandlerParams,
  session: SessionState,
  packageName: string,
  request: Extract<NativePerfRequest, { area: 'cpu' }>,
): Promise<Record<string, unknown>> {
  if (request.action === 'start') {
    assertNoActiveAndroidNativePerfSession(session);
    const outPath = resolveNativePerfOutPath(params, request.outPath, 'cpu.perf.data');
    const result = await startAndroidSimpleperfProfile(session.device, packageName, outPath, {
      adb: params.androidAdbExecutor,
    });
    return storeNativePerfSession(params, result);
  }

  const active = requireAndroidNativePerfSession(session, 'cpu-profile', request.kind);
  if (request.action === 'report') {
    await assertStoppedSimpleperfProfile(active);
    const outPath = resolveNativePerfOutPath(params, request.outPath, 'cpu-report.json');
    return await writeAndroidSimpleperfReport(session.device, active, outPath, {
      adb: params.androidAdbExecutor,
    });
  }

  const outPath = resolveNativePerfStopOutPath(params, request.outPath, active);
  const result = await stopAndroidSimpleperfProfile(session.device, active, outPath, {
    adb: params.androidAdbExecutor,
  });
  return storeNativePerfSession(params, result);
}

async function runAndroidTraceCommand(
  params: NativePerfHandlerParams,
  session: SessionState,
  packageName: string,
  request: Extract<NativePerfRequest, { area: 'trace' }>,
): Promise<Record<string, unknown>> {
  if (request.action === 'start') {
    assertNoActiveAndroidNativePerfSession(session);
    const outPath = resolveNativePerfOutPath(params, request.outPath, 'app.perfetto-trace');
    const result = await startAndroidPerfettoTrace(session.device, packageName, outPath, {
      adb: params.androidAdbExecutor,
    });
    return storeNativePerfSession(params, result);
  }

  const active = requireAndroidNativePerfSession(session, 'trace', request.kind);
  const outPath = resolveNativePerfStopOutPath(params, request.outPath, active);
  const result = await stopAndroidPerfettoTrace(session.device, active, outPath, {
    adb: params.androidAdbExecutor,
  });
  return storeNativePerfSession(params, result);
}

function assertStoppedSimpleperfProfile(active: AndroidNativePerfSession): void {
  if (active.state !== 'running') return;
  throw new AppError(
    'COMMAND_FAILED',
    'Stop the Android Simpleperf CPU profile before generating a report.',
    {
      hint: 'Run perf cpu profile stop --kind simpleperf, then retry perf cpu profile report --kind simpleperf.',
    },
  );
}

function assertNoActiveAndroidNativePerfSession(session: SessionState): void {
  const active = session.nativePerf?.android;
  if (active?.state !== 'running') return;
  throw new AppError(
    'COMMAND_FAILED',
    `Android ${active.kind} ${active.type} is already running for this session.`,
    {
      hint:
        active.type === 'cpu-profile'
          ? 'Run perf cpu profile stop --kind simpleperf before starting another Android native perf capture.'
          : 'Run perf trace stop --kind perfetto before starting another Android native perf capture.',
    },
  );
}

function resolveNativePerfStopOutPath(
  params: { sessionName: string; sessionStore: SessionStore; req: DaemonRequest },
  requestedPath: string | undefined,
  active: AndroidNativePerfSession,
): string {
  return requestedPath
    ? resolveNativePerfOutPath(params, requestedPath, active.outPath)
    : active.outPath;
}

function pathJoinSessionArtifact(
  sessionStore: SessionStore,
  sessionName: string,
  fallbackFileName: string,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(sessionStore.ensureSessionDir(sessionName), `${timestamp}-${fallbackFileName}`);
}

function compactNativePerfResponse(result: AndroidNativePerfSession & Record<string, unknown>) {
  return {
    action: result.action,
    platform: 'android',
    type: result.type,
    kind: result.kind,
    packageName: result.packageName,
    appPid: result.appPid,
    profilerPid: result.profilerPid,
    state: result.state,
    startedAt: new Date(result.startedAt).toISOString(),
    stoppedAt:
      typeof result.stoppedAt === 'number' ? new Date(result.stoppedAt).toISOString() : undefined,
    durationMs: result.durationMs,
    outPath: result.outPath,
    sizeBytes: result.sizeBytes,
    remotePath: result.remotePath,
    method: result.method,
    summary: result.summary,
    message: result.message,
  };
}

function requireAndroidNativePerfSession(
  session: SessionState,
  type: AndroidNativePerfSession['type'],
  kind: AndroidNativePerfKind,
): AndroidNativePerfSession {
  const active = session.nativePerf?.android;
  if (active?.type === type && active.kind === kind) return active;
  throw new AppError('COMMAND_FAILED', `No Android ${kind} ${type} is active for this session.`, {
    hint:
      type === 'cpu-profile'
        ? 'Run perf cpu profile start --kind simpleperf first, then stop or report in the same session.'
        : 'Run perf trace start --kind perfetto first, then stop in the same session.',
  });
}
