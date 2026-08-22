import {
  isPerfAction,
  isPerfArea,
  isPerfKind,
  isPerfMemoryKind,
  PERF_ACTION_ERROR_MESSAGE,
  PERF_AREA_ERROR_MESSAGE,
  PERF_KIND_ERROR_MESSAGE,
  PERF_MEMORY_KIND_ERROR_MESSAGE,
  type LogBackend,
  type PerfAction,
  type PerfArea,
  type PerfKind,
} from '@agent-device/contracts/observability';
import type {
  AppLogFailure,
  AppLogRuntimeOperations,
} from '@agent-device/contracts/app-log-runtime';
import {
  type LogsRuntimePlan,
  appLogAdmissionUse,
  resolveLogsRuntimePlan,
} from '@agent-device/contracts/logs-runtime-plan';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import { uniqueStrings } from '@agent-device/kernel/collections';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import { appendAppLogMarker, clearAppLogFiles, getAppLogPathMetadata } from '../app-log.ts';
import type { AppLogAdmissionLedger } from '../app-log-admission-ledger.ts';
import { appLogResourceStore } from '../app-log-resource-store.ts';
import {
  adoptStartedSessionAppLog,
  clearSessionAppLogFailure,
  finishSessionAppLog,
  inspectSessionAppLog,
  recordSessionAppLogFailure,
} from '../app-log-session-resource.ts';
import { createNextAppLogFence } from '../app-log-start-preflight.ts';
import type { BindDeviceRuntime } from '../request-runtime-binding.ts';
import type { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, DaemonResponseData, SessionState } from '../types.ts';
import { errorResponse, type DaemonFailureResponse } from './response.ts';
import { handleAudioCommand } from './session-audio.ts';
import { handleNativePerfCommand as handleAndroidNativePerfCommand } from './session-native-perf.ts';
import { handleNativePerfCommand as handleAppleNativePerfCommand } from './session-perf-xctrace.ts';
import { buildPerfFramesResponseData, buildPerfMemoryResponseData } from './session-perf.ts';
import { buildLegacyPerfMetricsResponseData } from './session-perf-legacy.ts';
import { handleNetworkCommand } from './session-network.ts';

type ObservabilityParams = {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  androidAdbExecutor?: AndroidAdbExecutor;
  bindDevice?: BindDeviceRuntime;
  appLogAdmissionLedger?: AppLogAdmissionLedger;
  throwIfCanceled?: () => void;
};
type LogsHandlerParams = Omit<ObservabilityParams, 'bindDevice' | 'appLogAdmissionLedger'> & {
  session: SessionState;
  bindDevice: BindDeviceRuntime;
  appLogAdmissionLedger: AppLogAdmissionLedger;
};
type ExecutableLogsRuntimePlan =
  | Extract<LogsRuntimePlan, { requiresAppSession: false }>
  | (Extract<LogsRuntimePlan, { requiresAppSession: true }> & { appBundleId: string });
type SessionLogStatus = {
  active: boolean;
  state: 'active' | 'recovering' | 'ended' | 'failed' | 'inactive';
  backend: LogBackend;
  startedAt?: number;
  failureCode?: string;
  failureMessage?: string;
  hint?: string;
  notes?: string[];
};

function resolveSessionLogStatus(
  session: SessionState,
  fallbackBackend: LogBackend,
): SessionLogStatus {
  const snapshot = inspectSessionAppLog(session);
  return {
    ...snapshot,
    backend: snapshot.backend ?? fallbackBackend,
    notes:
      snapshot.state === 'failed' && session.appLogFailure
        ? [buildAppLogFailureNote(session.appLogFailure)]
        : buildAppLogStateNotes(snapshot.state),
  };
}

function buildAppLogFailureNote(failure: AppLogFailure): string {
  return failure.hint ? `${failure.message} ${failure.hint}` : failure.message;
}

function buildAppLogStateNotes(state: SessionLogStatus['state']): string[] | undefined {
  if (state === 'failed') {
    return [
      'The app log stream process exited with an error. Run logs doctor for backend diagnostics.',
    ];
  }
  if (state === 'ended') {
    return [
      'The app log stream process ended. Run logs clear --restart before the next capture window.',
    ];
  }
  return undefined;
}

function mergeLogDoctorNotes(
  doctorNotes: readonly string[],
  status: Pick<SessionLogStatus, 'notes'>,
): string[] {
  return uniqueStrings([...doctorNotes, ...(status.notes ?? [])]);
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
  if (req.command === 'events') {
    return await handleEventsCommand(params);
  }
  if (req.command === 'network') {
    return await handleNetworkCommand(params);
  }
  if (req.command === 'audio') {
    return await handleAudioCommand(params);
  }

  return null;
}

async function handleEventsCommand(params: ObservabilityParams): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  try {
    await sessionStore.flushEvents(sessionName);
    return {
      ok: true,
      data: sessionStore.readEvents(sessionName, {
        limit: req.positionals?.[0],
        cursor: req.positionals?.[1],
      }),
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
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

  const request = resolvePerfCommandRequest(req);
  if (!request.ok) return request;
  if (request.native) {
    if (session.device.platform === 'android') {
      return await handleAndroidNativePerfCommand({
        req,
        sessionName,
        sessionStore,
        session,
        androidAdbExecutor,
        area: request.area,
      });
    }
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

type PerfCommandRequest =
  | {
      ok: true;
      native: true;
      area: 'cpu' | 'trace';
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
  if (area instanceof AppError) {
    return { ok: false, error: normalizeError(area) };
  }
  if (area === 'cpu' || area === 'trace') {
    return { ok: true, native: true, area };
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
  if (request.area === 'metrics') {
    return await buildLegacyPerfMetricsResponseData(session, {
      androidAdb: androidAdbExecutor,
      sessionName,
      sessionStore,
    });
  }
  return await buildPerfFramesResponseData(session, { androidAdb: androidAdbExecutor });
}

function readPerfArea(value: unknown): PerfArea | AppError {
  if (value == null) return 'metrics';
  const area = value.toString().toLowerCase();
  return isPerfArea(area) ? area : new AppError('INVALID_ARGS', PERF_AREA_ERROR_MESSAGE);
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
  if (area === 'metrics') {
    return action === 'sample'
      ? undefined
      : errorResponse('INVALID_ARGS', 'perf metrics only supports sample');
  }
  if (area === 'memory') {
    return isPerfMemoryAction(action)
      ? undefined
      : errorResponse('INVALID_ARGS', 'perf memory requires sample or snapshot');
  }
  if (action === 'sample') return undefined;
  return errorResponse('INVALID_ARGS', 'perf frames only supports sample');
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
  try {
    const logsParams = requireLogsHandlerParams({ ...params, session });
    const admission = await logsParams.bindDevice(session.device, appLogAdmissionUse);
    const inspectFact = admission.facts.appLogInspect;
    if (!inspectFact.available) {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_OPERATION',
          message: 'logs is not supported on this device',
          hint: inspectFact.hint,
        },
      };
    }
    const plan = resolveLogsRuntimePlan({
      action: req.positionals?.[0],
      restart: Boolean(req.flags?.restart),
      marker: req.positionals?.slice(1).join(' '),
    });
    const executablePlan = requireLogsPlanSession(plan, session);
    if ('ok' in executablePlan) return executablePlan;
    return await executeLogsRuntimePlan(logsParams, executablePlan);
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

async function executeLogsRuntimePlan(
  params: LogsHandlerParams,
  plan: ExecutableLogsRuntimePlan,
): Promise<DaemonResponse> {
  switch (plan.kind) {
    case 'path': {
      const runtime = await params.bindDevice(params.session.device, plan.use);
      const inspection = await runtime.operations.appLogInspect();
      return handleLogsPath(params, inspection.backend);
    }
    case 'doctor': {
      const runtime = await params.bindDevice(params.session.device, plan.use);
      const doctor = await runtime.operations.appLogDoctor({
        appBundleId: params.session.appBundleId,
      });
      return handleLogsDoctor(params, doctor);
    }
    case 'start':
    case 'clear-restart':
      return await executeLogsStartCapablePlan(params, plan);
    case 'stop':
      await params.bindDevice(params.session.device, plan.use);
      return await handleLogsStop(params);
    case 'mark':
      await params.bindDevice(params.session.device, plan.use);
      return handleLogsMark(plan.marker, params.sessionName, params.sessionStore);
    case 'clear':
      await params.bindDevice(params.session.device, plan.use);
      return handleLogsClear(params);
  }
}

async function executeLogsStartCapablePlan(
  params: LogsHandlerParams,
  plan: Extract<ExecutableLogsRuntimePlan, { kind: 'start' | 'clear-restart' }>,
): Promise<DaemonResponse> {
  const runtime = await params.bindDevice(params.session.device, plan.use);
  return plan.kind === 'start'
    ? await handleLogsStart(params, plan.appBundleId, runtime.owner, runtime.operations.appLogStart)
    : await handleLogsClearRestart(
        params,
        plan.appBundleId,
        runtime.owner,
        runtime.operations.appLogStart,
      );
}

function requireLogsPlanSession(
  plan: LogsRuntimePlan,
  session: SessionState,
): ExecutableLogsRuntimePlan | DaemonFailureResponse {
  if (!plan.requiresAppSession) return plan;
  if (session.appBundleId) return Object.freeze({ ...plan, appBundleId: session.appBundleId });
  return errorResponse(
    'INVALID_ARGS',
    `logs ${plan.kind === 'start' ? 'start' : 'clear --restart'} requires an app session; run open <app> first`,
  );
}

function handleLogsPath(params: LogsHandlerParams, backend: LogBackend): DaemonResponse {
  const { session, sessionName, sessionStore } = params;
  const logPath = sessionStore.resolveAppLogPath(sessionName);
  const metadata = getAppLogPathMetadata(logPath);
  const status = resolveSessionLogStatus(session, backend);
  return {
    ok: true,
    data: {
      path: logPath,
      active: status.active,
      state: status.state,
      backend: status.backend,
      sizeBytes: metadata.sizeBytes,
      modifiedAt: metadata.modifiedAt,
      startedAt: status.startedAt ? new Date(status.startedAt).toISOString() : undefined,
      failureCode: status.failureCode,
      failureMessage: status.failureMessage,
      hint:
        status.hint ??
        'Grep the file for token-efficient debugging, e.g. grep -n "Error\\|Exception" <path>',
      notes: status.notes,
    },
  };
}

async function handleLogsDoctor(
  params: LogsHandlerParams,
  doctor: Readonly<{
    backend: LogBackend;
    checks: Readonly<Record<string, boolean>>;
    notes: readonly string[];
  }>,
): Promise<DaemonResponse> {
  const { session, sessionName, sessionStore } = params;
  const logPath = sessionStore.resolveAppLogPath(sessionName);
  const status = resolveSessionLogStatus(session, doctor.backend);
  return {
    ok: true,
    data: {
      path: logPath,
      active: status.active,
      state: status.state,
      backend: status.backend,
      checks: doctor.checks,
      failureCode: status.failureCode,
      failureMessage: status.failureMessage,
      hint: status.hint,
      notes: mergeLogDoctorNotes(doctor.notes, status),
    },
  };
}

function handleLogsMark(
  marker: string,
  sessionName: string,
  sessionStore: SessionStore,
): DaemonResponse {
  const logPath = sessionStore.resolveAppLogPath(sessionName);
  appendAppLogMarker(logPath, marker);
  return { ok: true, data: { path: logPath, marked: true } };
}

function handleLogsClear(params: LogsHandlerParams): DaemonResponse {
  const { session, sessionName, sessionStore } = params;
  if (session.appLog) {
    return errorResponse(
      'INVALID_ARGS',
      'logs clear requires logs to be stopped first; run logs stop',
    );
  }
  const logPath = sessionStore.resolveAppLogPath(sessionName);
  const cleared = clearAppLogFiles(logPath);
  clearSessionAppLogFailure({ session, sessionName, sessionStore });
  return { ok: true, data: cleared };
}

async function handleLogsClearRestart(
  params: LogsHandlerParams,
  appBundleId: string,
  owner: RuntimeOwnerRef,
  start: AppLogRuntimeOperations['appLogStart'],
): Promise<DaemonResponse> {
  const { session, sessionName, sessionStore } = params;
  if (session.appLog) {
    await finishSessionAppLog({
      session,
      sessionName,
      sessionStore,
      resourcePath: appLogResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName)),
    });
  }
  const logPath = sessionStore.resolveAppLogPath(sessionName);
  const cleared = clearAppLogFiles(logPath);
  const started = await startSessionAppLog(params, appBundleId, start, owner);
  return started.ok ? { ok: true, data: { ...cleared, restarted: true } } : started;
}

async function handleLogsStart(
  params: LogsHandlerParams,
  appBundleId: string,
  owner: RuntimeOwnerRef,
  start: AppLogRuntimeOperations['appLogStart'],
): Promise<DaemonResponse> {
  const { session } = params;
  if (session.appLog) {
    return errorResponse('INVALID_ARGS', 'app log already streaming; run logs stop first');
  }
  return await startSessionAppLog(params, appBundleId, start, owner);
}

async function handleLogsStop(params: LogsHandlerParams): Promise<DaemonResponse> {
  const { session, sessionName, sessionStore } = params;
  if (!session.appLog) {
    return errorResponse('INVALID_ARGS', 'no app log stream active');
  }
  const outPath = sessionStore.resolveAppLogPath(sessionName);
  await finishSessionAppLog({
    session,
    sessionName,
    sessionStore,
    resourcePath: appLogResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName)),
  });
  return { ok: true, data: { path: outPath, stopped: true } };
}

async function startSessionAppLog(
  params: LogsHandlerParams,
  appBundleId: string,
  start: AppLogRuntimeOperations['appLogStart'],
  owner: RuntimeOwnerRef,
): Promise<DaemonResponse> {
  const { session, sessionName, sessionStore } = params;
  const outputPath = sessionStore.resolveAppLogPath(sessionName);
  const resourcePath = appLogResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName));
  try {
    const fence = createNextAppLogFence({
      ledger: params.appLogAdmissionLedger,
      resourcePath,
      device: session.device,
    });
    const result = await start({
      sessionId: sessionName,
      appBundleId,
      outputPath,
      pidPath: sessionStore.resolveAppLogPidPath(sessionName),
      fence,
    });
    await adoptStartedSessionAppLog({
      admissionLedger: params.appLogAdmissionLedger,
      session,
      sessionName,
      sessionStore,
      resourcePath,
      device: session.device,
      owner,
      fence,
      pendingHandle: result.pendingHandle,
      envelope: result.envelope,
      throwIfCanceled: params.throwIfCanceled ?? (() => {}),
    });
    return { ok: true, data: { path: outputPath, started: true } };
  } catch (error) {
    const normalized = recordSessionAppLogFailure({
      session,
      sessionName,
      sessionStore,
      error,
    });
    return { ok: false, error: normalized };
  }
}
function requireLogsHandlerParams(
  params: ObservabilityParams & { session: SessionState },
): LogsHandlerParams {
  if (!params.bindDevice) {
    throw new AppError('COMMAND_FAILED', 'Device runtime gateway is not configured', {
      reason: 'runtime-gateway-missing',
    });
  }
  if (!params.appLogAdmissionLedger) {
    throw new AppError('COMMAND_FAILED', 'App-log admission ledger is not configured', {
      reason: 'runtime-gateway-missing',
    });
  }
  return {
    ...params,
    bindDevice: params.bindDevice,
    appLogAdmissionLedger: params.appLogAdmissionLedger,
  };
}
