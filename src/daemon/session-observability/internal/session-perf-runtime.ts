import path from 'node:path';
import {
  parsePerfRuntimeRequest,
  resolvePerfRuntimePlan,
  type PerfRuntimePlan,
  type PerfRuntimeRequest,
} from '@agent-device/contracts/perf-runtime-plan';
import type {
  PerfData,
  PerfNativeCaptureSnapshot,
  PerfProfileHandoff,
  PerfRuntimeOperations,
} from '@agent-device/contracts/perf-runtime';
import type { SessionAction } from '@agent-device/contracts/session';
import {
  isRemovedAggregatePerfToken,
  PERF_AGGREGATE_REMOVED_ERROR_MESSAGE,
} from '@agent-device/contracts/observability';
import { publicPlatformString } from '@agent-device/kernel/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { PerfCaptureAdmissionLedger } from '../../perf-capture-admission-ledger.ts';
import {
  adoptStartedPerfCapture,
  finishLivePerfCapture,
  perfCaptureDurableResource,
} from '../../perf-capture-session-resource.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { recordSessionAction } from '../../session-action-recorder.ts';
import { errorResponse } from '../../response.ts';
import {
  admitRuntimePlan,
  requireRuntimeBinding,
  unavailableRuntimeOperationResponse,
  unwrapAdmittedRuntimePlan,
  type AdmittedRuntimePlan,
} from '../../session-runtime-admission.ts';

export type PerfRuntimeHandlerParams = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  perfCaptureAdmissionLedger?: PerfCaptureAdmissionLedger;
  throwIfCanceled(): void;
}>;

export async function handlePerfRuntimeCommand(
  params: PerfRuntimeHandlerParams,
): Promise<DaemonResponse> {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) {
    return errorResponse('SESSION_NOT_FOUND', 'perf requires an active session. Run open first.');
  }
  try {
    if (isRemovedAggregatePerfToken(params.req.positionals?.[0])) {
      throw new AppError('INVALID_ARGS', PERF_AGGREGATE_REMOVED_ERROR_MESSAGE);
    }
    validatePerfFlagPlacement(params.req);
    const request = parsePerfRuntimeRequest({
      positionals: params.req.positionals,
      kind: readString(params.req.flags?.kind),
      outPath: readString(params.req.flags?.out),
    });
    const plan = resolvePerfRuntimePlan(request);
    if (plan.kind === 'capture-stop') {
      return recordSuccessfulPerfResponse(
        params,
        await stopPerfCapture(params, session, plan.request),
      );
    }
    const admitted = await admitRuntimePlan({
      device: session.device,
      plan,
      inspectFacts: params.inspectFacts,
    });
    if (!admitted.admitted) {
      return (
        unavailableRuntimeOperationResponse('perf', admitted.fact) ??
        errorResponse('UNSUPPORTED_OPERATION', 'perf is not supported on this device')
      );
    }
    return recordSuccessfulPerfResponse(
      params,
      await executeAdmittedPerfPlan(params, session, admitted),
    );
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function recordSuccessfulPerfResponse(
  params: PerfRuntimeHandlerParams,
  response: DaemonResponse,
): DaemonResponse {
  if (!response.ok) return response;
  const session = params.sessionStore.get(params.sessionName);
  recordSessionAction(
    params.sessionStore,
    session,
    params.req,
    'perf',
    isDataRecord(response.data) ? { ...response.data } : {},
  );
  return response;
}

// One exhaustive switch owns the typed plan-to-operation mapping; splitting it would duplicate
// the admission/runtime join this handler is meant to keep singular.
// fallow-ignore-next-line complexity
async function executeAdmittedPerfPlan(
  params: PerfRuntimeHandlerParams,
  session: SessionState,
  admission: AdmittedRuntimePlan<Exclude<PerfRuntimePlan, { kind: 'capture-stop' }>>,
): Promise<DaemonResponse> {
  const { device, plan } = unwrapAdmittedRuntimePlan(admission);
  const bindDevice = requireRuntimeBinding(params.bindDevice);
  switch (plan.kind) {
    case 'frames': {
      const runtime = await bindDevice(device, plan.use);
      const result = await runtime.operations.perfFrames({ appId: session.appBundleId });
      return { ok: true, data: buildFramesResponse(session, result) };
    }
    case 'memory-sample': {
      const runtime = await bindDevice(device, plan.use);
      const result = await runtime.operations.perfMemorySample({ appId: session.appBundleId });
      return { ok: true, data: buildMemorySampleResponse(session, result) };
    }
    case 'memory-snapshot': {
      const runtime = await bindDevice(device, plan.use);
      const result = await runtime.operations.perfMemorySnapshot({
        appId: session.appBundleId,
        kind: plan.request.kind,
        outPath: plan.request.outPath
          ? SessionStore.expandHome(plan.request.outPath, params.req.meta?.cwd)
          : undefined,
        artifactsDir: path.join(
          params.sessionStore.ensureSessionDir(params.sessionName),
          'artifacts',
        ),
      });
      return { ok: true, data: buildMemorySnapshotResponse(session, result) };
    }
    case 'capture-start': {
      const runtime = await bindDevice(device, plan.use);
      return await startPerfCapture(params, session, runtime, plan.request);
    }
    case 'profile-report': {
      const runtime = await bindDevice(device, plan.use);
      const last = session.lastPerfProfile;
      const tracePath = plan.request.tracePath ?? last?.outPath;
      if (!tracePath) {
        throw new AppError(
          'INVALID_ARGS',
          'perf cpu profile report requires a stopped profile trace or tracePath option',
        );
      }
      if (session.perfCapture) {
        throw new AppError(
          'INVALID_ARGS',
          'perf cpu profile report requires a stopped profile trace; stop the active capture first.',
        );
      }
      const outPath = resolveNativeOutPath(params, plan.request.outPath, 'cpu-report.json');
      const data = await runtime.operations.perfProfileReport({
        appId: session.appBundleId,
        kind: plan.request.kind,
        tracePath: SessionStore.expandHome(tracePath, params.req.meta?.cwd),
        outPath,
        template: plan.request.template ?? (last?.kind === 'xctrace' ? last.template : undefined),
        profile: last,
      });
      return { ok: true, data: { perf: 'reported', ...data } };
    }
  }
}

async function startPerfCapture(
  params: PerfRuntimeHandlerParams,
  session: SessionState,
  runtime: Readonly<{
    owner: Parameters<typeof adoptStartedPerfCapture>[0]['owner'];
    operations: Pick<PerfRuntimeOperations, 'perfNativeCaptureStart'>;
  }>,
  request: Extract<PerfRuntimeRequest, { area: 'cpu' | 'trace' }>,
): Promise<DaemonResponse> {
  if (session.perfCapture) {
    return errorResponse('INVALID_ARGS', 'native perf capture already in progress');
  }
  if (!session.appBundleId) {
    return errorResponse('COMMAND_FAILED', 'No app is associated with this session.', {
      hint: 'Run open <app> first so perf can resolve the app process identity.',
    });
  }
  const fallback =
    request.kind === 'xctrace'
      ? `perf-${request.area === 'cpu' ? 'cpu-profile' : 'trace'}.trace`
      : request.kind === 'perfetto'
        ? 'app.perfetto-trace'
        : 'cpu.perf.data';
  const outPath = resolveNativeOutPath(params, request.outPath, fallback);
  const resourcePath = perfCaptureDurableResource.store.resolvePath(
    params.sessionStore.resolveSessionDir(params.sessionName),
  );
  const fence = perfCaptureDurableResource.createNextFence({
    admissionLedger: requirePerfCaptureAdmissionLedger(params),
    resourcePath,
    device: session.device,
  });
  const started = await runtime.operations.perfNativeCaptureStart({
    sessionId: params.sessionName,
    appId: session.appBundleId,
    mode: request.area === 'cpu' ? 'cpu-profile' : 'trace',
    kind: request.kind,
    template: request.template,
    outPath,
    fence,
  });
  await adoptStartedPerfCapture({
    admissionLedger: requirePerfCaptureAdmissionLedger(params),
    session,
    sessionName: params.sessionName,
    sessionStore: params.sessionStore,
    device: session.device,
    owner: runtime.owner,
    fence,
    pendingHandle: started.pendingHandle,
    envelope: started.envelope,
    throwIfCanceled: params.throwIfCanceled,
  });
  return { ok: true, data: started.response };
}

function requirePerfCaptureAdmissionLedger(
  params: PerfRuntimeHandlerParams,
): PerfCaptureAdmissionLedger {
  if (params.perfCaptureAdmissionLedger) return params.perfCaptureAdmissionLedger;
  throw new AppError('COMMAND_FAILED', 'Perf capture admission ledger is not configured', {
    reason: 'runtime-gateway-missing',
  });
}

async function stopPerfCapture(
  params: PerfRuntimeHandlerParams,
  session: SessionState,
  request: Extract<PerfRuntimeRequest, { area: 'cpu' | 'trace' }>,
): Promise<DaemonResponse> {
  const capture = session.perfCapture;
  if (!capture) return errorResponse('INVALID_ARGS', 'no active native perf capture');
  const snapshot = capture.handle.inspect();
  const mismatchMessage = perfCaptureStopMismatch(snapshot, request);
  if (mismatchMessage) return errorResponse('INVALID_ARGS', mismatchMessage);
  if (request.outPath) {
    capture.handle.setOutputPath(SessionStore.expandHome(request.outPath, params.req.meta?.cwd));
  }
  const completion = await finishLivePerfCapture({
    session,
    sessionName: params.sessionName,
    sessionStore: params.sessionStore,
  });
  if (request.area === 'cpu') {
    const profile = readProfileHandoff(completion);
    const refreshed = params.sessionStore.get(params.sessionName) ?? session;
    params.sessionStore.set(params.sessionName, { ...refreshed, lastPerfProfile: profile });
  }
  return { ok: true, data: completion };
}

function readProfileHandoff(snapshot: PerfNativeCaptureSnapshot): PerfProfileHandoff {
  if (isAppleProfileHandoff(snapshot) || isAndroidProfileHandoff(snapshot)) return snapshot;
  throw new AppError('COMMAND_FAILED', 'Stopped CPU profile metadata is malformed.');
}

function isAppleProfileHandoff(
  snapshot: PerfNativeCaptureSnapshot,
): snapshot is Extract<PerfProfileHandoff, { kind: 'xctrace' }> {
  return (
    snapshot.kind === 'xctrace' &&
    snapshot.mode === 'cpu-profile' &&
    typeof snapshot.outPath === 'string' &&
    typeof snapshot.template === 'string'
  );
}

function isAndroidProfileHandoff(
  snapshot: PerfNativeCaptureSnapshot,
): snapshot is Extract<PerfProfileHandoff, { kind: 'simpleperf' }> {
  return (
    snapshot.kind === 'simpleperf' &&
    snapshot.mode === 'cpu-profile' &&
    hasStringFields(snapshot, ['outPath', 'packageName', 'appPid', 'profilerPid', 'remotePath'])
  );
}

function hasStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}

function perfCaptureStopMismatch(
  snapshot: PerfNativeCaptureSnapshot,
  request: Extract<PerfRuntimeRequest, { area: 'cpu' | 'trace' }>,
): string | undefined {
  const expectedMode = request.area === 'cpu' ? 'cpu-profile' : 'trace';
  if (snapshot.kind === request.kind && snapshot.mode === expectedMode) {
    return undefined;
  }
  return `No ${request.kind} ${expectedMode} is active for this session.`;
}

function buildFramesResponse(session: SessionState, result: PerfData): PerfData {
  return {
    ...baseResponse(session),
    metrics: { fps: enrichFrameMetricWithSessionContext(result.metric, session) },
    sampling: { fps: result.sampling },
  };
}

function enrichFrameMetricWithSessionContext(metric: unknown, session: SessionState): unknown {
  if (!isDataRecord(metric) || metric.available !== true) return metric;
  const relatedActions = buildRelatedPerfActions(session.actions, metric);
  return relatedActions.length === 0 ? metric : { ...metric, relatedActions };
}

function buildRelatedPerfActions(
  actions: SessionAction[],
  metric: PerfData,
): Array<{ command: string; at: string; offsetMs: number; target?: string }> {
  const windowStartedAtMs = parseIsoTime(metric.windowStartedAt);
  const windowEndedAtMs = parseIsoTime(metric.windowEndedAt) ?? parseIsoTime(metric.measuredAt);
  if (windowStartedAtMs === undefined || windowEndedAtMs === undefined) return [];
  return actions
    .filter(({ ts }) => ts >= windowStartedAtMs && ts <= windowEndedAtMs)
    .map((action) => ({
      command: action.command,
      at: new Date(action.ts).toISOString(),
      offsetMs: Math.max(0, Math.round(action.ts - windowStartedAtMs)),
      target: readActionTarget(action),
    }))
    .slice(-12);
}

function parseIsoTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function readActionTarget(action: SessionAction): string | undefined {
  for (const key of ['refLabel', 'ref', 'appName', 'appBundleId']) {
    const value = action.result?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isDataRecord(value: unknown): value is PerfData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildMemorySampleResponse(session: SessionState, result: PerfData): PerfData {
  return {
    ...baseResponse(session),
    metrics: { memory: result.metric },
    sampling: { memory: result.sampling },
  };
}

function buildMemorySnapshotResponse(session: SessionState, result: PerfData): PerfData {
  return {
    ...baseResponse(session),
    artifact: result.artifact,
    sampling: { snapshot: result.sampling },
    support: result.support,
  };
}

function baseResponse(session: SessionState): PerfData {
  return {
    session: session.name,
    platform: publicPlatformString(session.device),
    device: session.device.name,
    deviceId: session.device.id,
  };
}

function resolveNativeOutPath(
  params: PerfRuntimeHandlerParams,
  requestedPath: string | undefined,
  fallbackFileName: string,
): string {
  if (requestedPath) return SessionStore.expandHome(requestedPath, params.req.meta?.cwd);
  return path.join(
    params.sessionStore.ensureSessionDir(params.sessionName),
    `${timestampToken()}-${fallbackFileName}`,
  );
}

function validatePerfFlagPlacement(req: DaemonRequest): void {
  const area = req.positionals?.[0]?.toLowerCase();
  const action = req.positionals?.[1]?.toLowerCase();
  if (
    req.flags?.out &&
    area !== 'cpu' &&
    area !== 'trace' &&
    !(area === 'memory' && action === 'snapshot')
  ) {
    throw new AppError(
      'INVALID_ARGS',
      '--out is only supported with perf memory snapshot, perf cpu profile, or perf trace',
    );
  }
}

function timestampToken(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-');
}
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
