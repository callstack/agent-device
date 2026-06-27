import {
  isPerfAction,
  isPerfArea,
  isPerfKind,
  isPerfMemoryKind,
  PERF_ACTION_ERROR_MESSAGE,
  PERF_AREA_ERROR_MESSAGE,
  PERF_KIND_ERROR_MESSAGE,
  PERF_MEMORY_KIND_ERROR_MESSAGE,
  type PerfAction,
  type PerfArea,
  type PerfKind,
} from '../../contracts/perf.ts';
import { AppError, normalizeError } from '../../utils/errors.ts';
import { resolveWebProvider } from '../../platforms/web/provider.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import type { DaemonRequest, DaemonResponse, DaemonResponseData, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import {
  appendAppLogMarker,
  clearAppLogFiles,
  getAppLogPathMetadata,
  readSessionNetworkCapture,
  resolveLogBackend,
  runAppLogDoctor,
  startAppLog,
  stopAppLog,
} from '../app-log.ts';
import {
  buildPerfFramesResponseData,
  buildPerfMemoryResponseData,
  buildPerfResponseData,
} from './session-perf.ts';
import { handleNativePerfCommand as handleAndroidNativePerfCommand } from './session-native-perf.ts';
import { errorResponse, requireCommandSupported, type DaemonFailureResponse } from './response.ts';
import { handleNativePerfCommand as handleAppleNativePerfCommand } from './session-perf-xctrace.ts';
import { NETWORK_INCLUDE_MODES, type NetworkIncludeMode } from '../../contracts.ts';
import type { LogBackend } from '../network-log.ts';
import {
  LOG_ACTION_VALUES as LOG_ACTIONS,
  type LogAction as LogsAction,
} from '../../contracts/logs.ts';

const LOG_ACTIONS_MESSAGE = `logs requires ${LOG_ACTIONS.slice(0, -1).join(', ')}, or ${LOG_ACTIONS.at(-1)}`;
const NETWORK_ACTIONS = ['dump', 'log'] as const;
const NETWORK_ACTIONS_MESSAGE = `network requires ${NETWORK_ACTIONS.join(' or ')}`;
const NETWORK_INCLUDE_MESSAGE = `network include mode must be one of: ${NETWORK_INCLUDE_MODES.join(', ')}`;

type ObservabilityParams = {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  androidAdbExecutor?: AndroidAdbExecutor;
};
type LogsHandlerParams = ObservabilityParams & {
  session: SessionState;
  restart: boolean;
};

const LOG_ACTION_HANDLERS: Record<
  LogsAction,
  (params: LogsHandlerParams) => Promise<DaemonResponse> | DaemonResponse
> = {
  path: ({ session, sessionName, sessionStore }) =>
    handleLogsPath(session, sessionName, sessionStore),
  doctor: ({ session, sessionName, sessionStore }) =>
    handleLogsDoctor(session, sessionName, sessionStore),
  mark: ({ req, sessionName, sessionStore }) => handleLogsMark(req, sessionName, sessionStore),
  clear: ({ session, sessionName, sessionStore, restart }) =>
    handleLogsClear(session, sessionName, sessionStore, restart),
  start: ({ session, sessionName, sessionStore }) =>
    handleLogsStart(session, sessionName, sessionStore),
  stop: ({ session, sessionName, sessionStore }) =>
    handleLogsStop(session, sessionName, sessionStore),
};

function resolveSessionLogBackendLabel(session: SessionState): LogBackend {
  return session.appLog?.backend ?? resolveLogBackend(session.device);
}

export async function handleSessionObservabilityCommands(
  params: ObservabilityParams,
): Promise<DaemonResponse | null> {
  const { req } = params;

  if (req.command === 'perf') {
    return handlePerfCommand(params);
  }
  if (req.command === 'logs') {
    return handleLogsCommand(params);
  }
  if (req.command === 'network') {
    return handleNetworkCommand(params);
  }

  return null;
}

// ---------------------------------------------------------------------------
// perf
// ---------------------------------------------------------------------------

async function handlePerfCommand(params: ObservabilityParams): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore, androidAdbExecutor } = params;
  const session = sessionStore.get(sessionName);
  if (!session) {
    return errorResponse('SESSION_NOT_FOUND', 'perf requires an active session. Run open first.');
  }

  const area = (req.positionals?.[0] ?? 'metrics').toLowerCase();
  if (isNativePerfArea(area)) {
    if (session.device.platform === 'android') {
      return await handleAndroidNativePerfCommand({
        req,
        sessionName,
        sessionStore,
        session,
        androidAdbExecutor,
        area,
      });
    }
    return await handleAppleNativePerfCommand(params, session);
  }

  const request = resolvePerfCommandRequest(req);
  if (!request.ok) return request;
  if (request.native) {
    return await handleAppleNativePerfCommand(params, session);
  }

  try {
    return {
      ok: true,
      data: await buildPerfCommandData(params, session, request),
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function isNativePerfArea(area: string): area is 'cpu' | 'trace' {
  return area === 'cpu' || area === 'trace';
}

type PerfCommandRequest =
  | {
      ok: true;
      native: true;
    }
  | {
      ok: true;
      native: false;
      area: 'metrics' | 'frames' | 'memory';
      action: 'sample' | 'snapshot';
      kind?: PerfKind;
      out?: string;
    };

function resolvePerfCommandRequest(req: DaemonRequest): PerfCommandRequest | DaemonFailureResponse {
  const area = readPerfArea(req.positionals?.[0]);
  if (!area) {
    return errorResponse('INVALID_ARGS', PERF_AREA_ERROR_MESSAGE);
  }
  if (area === 'cpu' || area === 'trace') {
    return { ok: true, native: true };
  }

  const action = readPerfAction(req.positionals?.[1]);
  if (!action) {
    return errorResponse('INVALID_ARGS', PERF_ACTION_ERROR_MESSAGE);
  }

  const kindResult = readPerfKind(req.flags?.kind);
  if (kindResult instanceof AppError) {
    return { ok: false, error: normalizeError(kindResult) };
  }
  const validationError =
    validatePerfAreaAction(area, action) ?? validatePerfFlags(req, area, action, kindResult);
  if (validationError) return validationError;

  return {
    ok: true,
    native: false,
    area,
    action: action as 'sample' | 'snapshot',
    kind: kindResult,
    out: readOptionalStringFlag(req.flags?.out),
  };
}

async function buildPerfCommandData(
  params: ObservabilityParams,
  session: SessionState,
  request: Extract<PerfCommandRequest, { native: false }>,
): Promise<DaemonResponseData> {
  const { sessionName, sessionStore, androidAdbExecutor } = params;
  if (request.area === 'memory') {
    return await buildPerfMemoryResponseData(session, {
      action: toPerfMemoryAction(request.action),
      kind: request.kind,
      out: request.out,
      cwd: params.req.meta?.cwd,
      sessionName,
      sessionStore,
      androidAdb: androidAdbExecutor,
    });
  }
  if (request.area === 'frames') {
    return await buildPerfFramesResponseData(session, { androidAdb: androidAdbExecutor });
  }
  return await buildPerfResponseData(session, { androidAdb: androidAdbExecutor });
}

function readPerfArea(value: unknown): PerfArea | undefined {
  const area = (value ?? 'metrics').toString().toLowerCase();
  return isPerfArea(area) ? area : undefined;
}

function readPerfAction(value: unknown): PerfAction | undefined {
  const action = (value ?? 'sample').toString().toLowerCase();
  return isPerfAction(action) ? action : undefined;
}

function readPerfKind(value: unknown): PerfKind | undefined | AppError {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isPerfKind(value)) {
    return new AppError('INVALID_ARGS', PERF_KIND_ERROR_MESSAGE);
  }
  return value;
}

function validatePerfAreaAction(
  area: Exclude<PerfArea, 'cpu' | 'trace'>,
  action: PerfAction,
): DaemonFailureResponse | undefined {
  if (area === 'memory') {
    return isPerfMemoryAction(action)
      ? undefined
      : errorResponse('INVALID_ARGS', 'perf memory requires sample or snapshot');
  }
  if (action === 'sample') return undefined;
  return errorResponse('INVALID_ARGS', 'perf metrics and perf frames only support sample');
}

function isPerfMemoryAction(action: PerfAction): action is 'sample' | 'snapshot' {
  return action === 'sample' || action === 'snapshot';
}

function toPerfMemoryAction(action: PerfAction): 'sample' | 'snapshot' {
  if (isPerfMemoryAction(action)) return action;
  throw new AppError('INVALID_ARGS', 'perf memory requires sample or snapshot');
}

function validatePerfFlags(
  req: DaemonRequest,
  area: Exclude<PerfArea, 'cpu' | 'trace'>,
  action: PerfAction,
  kind: PerfKind | undefined,
): DaemonFailureResponse | undefined {
  return (
    validatePerfOutFlag(req.flags?.out, area, action) ?? validatePerfKindFlag(kind, area, action)
  );
}

function validatePerfOutFlag(
  out: unknown,
  area: Exclude<PerfArea, 'cpu' | 'trace'>,
  action: PerfAction,
): DaemonFailureResponse | undefined {
  if (!out || (area === 'memory' && action === 'snapshot')) return undefined;
  return errorResponse('INVALID_ARGS', '--out is only supported with perf memory snapshot');
}

function validatePerfKindFlag(
  kind: PerfKind | undefined,
  area: Exclude<PerfArea, 'cpu' | 'trace'>,
  action: PerfAction,
): DaemonFailureResponse | undefined {
  if (!kind) return undefined;
  if (area !== 'memory' || action !== 'snapshot') {
    return errorResponse('INVALID_ARGS', '--kind is only supported with perf memory snapshot');
  }
  if (isPerfMemoryKind(kind)) return undefined;
  return errorResponse('INVALID_ARGS', PERF_MEMORY_KIND_ERROR_MESSAGE);
}

function readOptionalStringFlag(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

async function handleLogsCommand(params: ObservabilityParams): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  if (!session) {
    return errorResponse('SESSION_NOT_FOUND', 'logs requires an active session');
  }
  const unsupported = requireCommandSupported('logs', session.device);
  if (unsupported) return unsupported;

  const request = resolveLogsCommandRequest(req);
  if (!request.ok) return request;
  return await LOG_ACTION_HANDLERS[request.action]({
    ...params,
    session,
    restart: request.restart,
  });
}

function resolveLogsCommandRequest(
  req: DaemonRequest,
): { ok: true; action: LogsAction; restart: boolean } | DaemonFailureResponse {
  const action = (req.positionals?.[0] ?? 'path').toLowerCase();
  const restart = Boolean(req.flags?.restart);
  if (!LOG_ACTIONS.includes(action as LogsAction)) {
    return errorResponse('INVALID_ARGS', LOG_ACTIONS_MESSAGE);
  }
  if (restart && action !== 'clear') {
    return errorResponse('INVALID_ARGS', 'logs --restart is only supported with logs clear');
  }
  return { ok: true, action: action as LogsAction, restart };
}

function handleLogsPath(
  session: SessionState,
  sessionName: string,
  sessionStore: SessionStore,
): DaemonResponse {
  const logPath = sessionStore.resolveAppLogPath(sessionName);
  const metadata = getAppLogPathMetadata(logPath);
  return {
    ok: true,
    data: {
      path: logPath,
      active: Boolean(session.appLog),
      state: session.appLog?.getState() ?? 'inactive',
      backend: resolveSessionLogBackendLabel(session),
      sizeBytes: metadata.sizeBytes,
      modifiedAt: metadata.modifiedAt,
      startedAt: session.appLog?.startedAt
        ? new Date(session.appLog.startedAt).toISOString()
        : undefined,
      hint: 'Grep the file for token-efficient debugging, e.g. grep -n "Error\\|Exception" <path>',
    },
  };
}

async function handleLogsDoctor(
  session: SessionState,
  sessionName: string,
  sessionStore: SessionStore,
): Promise<DaemonResponse> {
  const logPath = sessionStore.resolveAppLogPath(sessionName);
  const doctor = await runAppLogDoctor(session.device, session.appBundleId);
  return {
    ok: true,
    data: {
      path: logPath,
      active: Boolean(session.appLog),
      state: session.appLog?.getState() ?? 'inactive',
      checks: doctor.checks,
      notes: doctor.notes,
    },
  };
}

function handleLogsMark(
  req: DaemonRequest,
  sessionName: string,
  sessionStore: SessionStore,
): DaemonResponse {
  const marker = req.positionals?.slice(1).join(' ') ?? '';
  const logPath = sessionStore.resolveAppLogPath(sessionName);
  appendAppLogMarker(logPath, marker);
  return { ok: true, data: { path: logPath, marked: true } };
}

async function handleLogsClear(
  session: SessionState,
  sessionName: string,
  sessionStore: SessionStore,
  restart: boolean,
): Promise<DaemonResponse> {
  if (session.appLog && !restart) {
    return errorResponse(
      'INVALID_ARGS',
      'logs clear requires logs to be stopped first; run logs stop',
    );
  }
  const logPath = sessionStore.resolveAppLogPath(sessionName);
  if (!restart) {
    return { ok: true, data: clearAppLogFiles(logPath) };
  }
  const appBundleId = session.appBundleId;
  if (!appBundleId) {
    return errorResponse(
      'INVALID_ARGS',
      'logs clear --restart requires an app session; run open <app> first',
    );
  }

  if (session.appLog) {
    await stopAppLog(session.appLog);
  }
  const cleared = clearAppLogFiles(logPath);
  const appLogPidPath = sessionStore.resolveAppLogPidPath(sessionName);
  try {
    const appLogStream = await startAppLog(session.device, appBundleId, logPath, appLogPidPath);
    sessionStore.set(sessionName, {
      ...session,
      appLog: {
        platform: session.device.platform,
        backend: appLogStream.backend,
        outPath: logPath,
        startedAt: appLogStream.startedAt,
        getState: appLogStream.getState,
        stop: appLogStream.stop,
        wait: appLogStream.wait,
      },
    });
    return { ok: true, data: { ...cleared, restarted: true } };
  } catch (err) {
    sessionStore.set(sessionName, { ...session, appLog: undefined });
    return { ok: false, error: normalizeError(err) };
  }
}

async function handleLogsStart(
  session: SessionState,
  sessionName: string,
  sessionStore: SessionStore,
): Promise<DaemonResponse> {
  if (session.appLog) {
    return errorResponse('INVALID_ARGS', 'app log already streaming; run logs stop first');
  }
  if (!session.appBundleId) {
    return errorResponse(
      'INVALID_ARGS',
      'logs start requires an app session; run open <app> first',
    );
  }

  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  const appLogPidPath = sessionStore.resolveAppLogPidPath(sessionName);
  try {
    const appLogStream = await startAppLog(
      session.device,
      session.appBundleId,
      appLogPath,
      appLogPidPath,
    );
    sessionStore.set(sessionName, {
      ...session,
      appLog: {
        platform: session.device.platform,
        backend: appLogStream.backend,
        outPath: appLogPath,
        startedAt: appLogStream.startedAt,
        getState: appLogStream.getState,
        stop: appLogStream.stop,
        wait: appLogStream.wait,
      },
    });
    return { ok: true, data: { path: appLogPath, started: true } };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
}

async function handleLogsStop(
  session: SessionState,
  sessionName: string,
  sessionStore: SessionStore,
): Promise<DaemonResponse> {
  if (!session.appLog) {
    return errorResponse('INVALID_ARGS', 'no app log stream active');
  }
  const outPath = session.appLog.outPath;
  await stopAppLog(session.appLog);
  sessionStore.set(sessionName, { ...session, appLog: undefined });
  return { ok: true, data: { path: outPath, stopped: true } };
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

async function handleNetworkCommand(params: ObservabilityParams): Promise<DaemonResponse> {
  const request = resolveNetworkCommandRequest(params);
  if (!request.ok) return request;
  const { include, maxEntries, session } = request;

  if (session.device.platform === 'web') {
    return await handleWebNetworkCommand({ include, maxEntries });
  }

  const capture = await readSessionNetworkCapture({
    device: session.device,
    appBundleId: session.appBundleId,
    appLogState: session.appLog?.getState(),
    appLogStartedAt: session.appLog?.startedAt,
    appLogPath: params.sessionStore.resolveAppLogPath(params.sessionName),
    maxEntries,
    include,
    maxPayloadChars: 2048,
    maxScanLines: 4000,
  });

  return {
    ok: true,
    data: {
      ...capture.dump,
      active: Boolean(session.appLog),
      state: session.appLog?.getState() ?? 'inactive',
      backend: capture.backend,
      notes: capture.notes,
    },
  };
}

async function handleWebNetworkCommand(params: {
  include: NetworkIncludeMode;
  maxEntries: number;
}): Promise<DaemonResponse> {
  const provider = resolveWebProvider();
  if (!provider.dumpNetwork) {
    return errorResponse('UNSUPPORTED_OPERATION', 'network is not supported by this web provider');
  }
  try {
    const result = await provider.dumpNetwork({
      include: params.include,
      limit: params.maxEntries,
    });
    return {
      ok: true,
      data: {
        entries: result.entries,
        active: true,
        state: 'active',
        backend: result.backend ?? 'agent-browser',
        include: params.include,
        matchedLines: result.entries.length,
        scannedLines: result.entries.length,
        limits: {
          maxEntries: params.maxEntries,
          maxPayloadChars: 2048,
          maxScanLines: result.entries.length,
        },
        notes: result.notes,
      },
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function resolveNetworkCommandRequest(
  params: ObservabilityParams,
):
  | { ok: true; session: SessionState; maxEntries: number; include: NetworkIncludeMode }
  | DaemonFailureResponse {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  if (!session) {
    return errorResponse('SESSION_NOT_FOUND', 'network requires an active session');
  }
  const unsupported = requireCommandSupported('network', session.device);
  if (unsupported) return unsupported;

  const action = (req.positionals?.[0] ?? 'dump').toLowerCase();
  if (!NETWORK_ACTIONS.includes(action as (typeof NETWORK_ACTIONS)[number])) {
    return errorResponse('INVALID_ARGS', NETWORK_ACTIONS_MESSAGE);
  }

  const maxEntries = req.positionals?.[1] ? Number.parseInt(req.positionals[1], 10) : 25;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 200) {
    return errorResponse('INVALID_ARGS', 'network dump limit must be an integer in range 1..200');
  }

  const includeValidation = resolveNetworkIncludeMode(req);
  if (!includeValidation.ok) return includeValidation;
  return { ok: true, session, maxEntries, include: includeValidation.include };
}

function resolveNetworkIncludeMode(
  req: DaemonRequest,
): { ok: true; include: NetworkIncludeMode } | DaemonFailureResponse {
  const positionalInclude = req.positionals?.[2]?.toLowerCase();
  const flagInclude = req.flags?.networkInclude;
  if (positionalInclude && flagInclude && positionalInclude !== flagInclude) {
    return errorResponse(
      'INVALID_ARGS',
      'network include mode was provided both positionally and via --include with different values',
    );
  }
  const requestedInclude = (flagInclude ?? positionalInclude ?? 'summary').toLowerCase();
  if (!NETWORK_INCLUDE_MODES.includes(requestedInclude as (typeof NETWORK_INCLUDE_MODES)[number])) {
    return errorResponse('INVALID_ARGS', NETWORK_INCLUDE_MESSAGE);
  }
  return { ok: true, include: requestedInclude as NetworkIncludeMode };
}
