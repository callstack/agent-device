import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import { expandSessionPath } from '@agent-device/host-kit/session-paths';
import path from 'node:path';
import { realpathSync, statSync, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cp, rename, rm } from 'node:fs/promises';
import { type PerfCaptureAdmissionLedger } from '@agent-device/capture-kit/perf-capture-admission-ledger';
import {
  adoptStartedPerfCapture,
  finishLivePerfCapture,
  perfCaptureDurableResource,
} from '@agent-device/capture-kit/perf-capture-session-resource';
import {
  parsePerfRuntimeRequest,
  type PerfRuntimePlan,
  type PerfRuntimeRequest,
  resolvePerfRuntimePlan,
} from '@agent-device/capture-kit/perf-runtime-plan';
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
import { isRecord } from '@agent-device/kernel/record';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../../core/request-runtime-binding.ts';
import type { SessionStore } from '../../../core/session-store.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { requestCwd } from '../../../core/context.ts';
import { LEASE_FIELD_NORMALIZERS, resolveLeaseScope } from '../../../core/lease-context.ts';
import type { SessionRef, SessionState } from '../../../core/session-state.ts';
import { bindSessionPerfCapture } from '../../../core/session-capture-binding.ts';
import { withCaptureOutputOwnership } from '../../../core/capture-output-ownership.ts';
import {
  admittedOutputLeaseVerifier,
  assertTrackedPerformanceSourceLease,
  leasedOutputRefusal,
  retainPerfReportSource,
} from '../../../resources/artifact-tracking.ts';
import { recordSessionAction } from '../../../core/session-action-recorder.ts';
import {
  admitRuntimePlan,
  requireRuntimeBinding,
  unavailableRuntimeOperationResponse,
  unwrapAdmittedRuntimePlan,
  type AdmittedRuntimePlan,
} from '../../../core/session-runtime-admission.ts';
import { RUNTIME_GATEWAY_REASONS } from '../../../core/runtime-admission.ts';
import { errorResponse } from '@agent-device/kernel/contracts';

export type PerfRuntimeHandlerParams = Readonly<{
  host: HostEnvironment;
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
  const ref = params.sessionStore.lookup(params.sessionName);
  if (!ref) {
    return errorResponse('SESSION_NOT_FOUND', 'perf requires an active session. Run open first.');
  }
  const session = params.sessionStore.requireCurrent(ref);
  const bound = { ...params, ref };
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
        bound,
        await stopPerfCapture(bound, session, plan.request),
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
      bound,
      await executeAdmittedPerfPlan(bound, session, admitted),
    );
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function recordSuccessfulPerfResponse(
  params: PerfRuntimeHandlerParams & { ref: SessionRef },
  response: DaemonResponse,
): DaemonResponse {
  if (!response.ok) return response;
  recordSessionAction(
    params.sessionStore,
    params.ref,
    params.req,
    'perf',
    isRecord(response.data) ? { ...response.data } : {},
  );
  return response;
}

// One exhaustive switch owns the typed plan-to-operation mapping; splitting it would duplicate
// the admission/runtime join this handler is meant to keep singular.
// fallow-ignore-next-line complexity
async function executeAdmittedPerfPlan(
  params: PerfRuntimeHandlerParams & { ref: SessionRef },
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
          ? expandSessionPath(plan.request.outPath, requestCwd(params.req, params.host))
          : undefined,
        artifactsDir: path.join(
          params.sessionStore.ensureSessionDir(params.sessionName),
          'artifacts',
        ),
      });
      return {
        ok: true,
        data: withCaptureOutputOwnership(
          buildMemorySnapshotResponse(session, result),
          params.req.internal?.publicNetworkOnly ? 'daemon' : 'caller',
          session.lease?.tenantId ?? params.req.meta?.tenantId,
        ),
      };
    }
    case 'capture-start': {
      const runtime = await bindDevice(device, plan.use);
      return await startPerfCapture(params, session, runtime, plan.request);
    }
    case 'profile-report': {
      const isXctrace = plan.request.kind === 'xctrace';
      const requestedPath = plan.request.tracePath
        ? expandSessionPath(plan.request.tracePath, requestCwd(params.req, params.host))
        : undefined;
      const explicit =
        isXctrace && requestedPath ? resolveExplicitPerfSource(requestedPath) : undefined;
      const saved = session.lastPerfProfile;
      const retained =
        explicit &&
        saved &&
        !canReadPerfOutput(params.req, saved.leaseVerifier) &&
        !samePerfSource(explicit, saved.profile.outPath)
          ? undefined
          : saved;
      const tracePath = requestedPath ?? retained?.profile.outPath;
      assertPerfOutputOwner(params.req, retained?.leaseVerifier);
      const last = retained?.profile;
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
      if (!isXctrace && (!last || last.type !== 'cpu-profile' || !isAndroidProfileHandoff(last))) {
        throw new AppError('INVALID_ARGS', 'Stopped Simpleperf profile metadata is malformed.');
      }
      const source =
        isXctrace || requestedPath ? (explicit ?? readPerfSource(tracePath)) : undefined;
      if (source) assertPerfSourceLease(params, source);
      const runtime = await bindDevice(device, plan.use);
      const outPath = resolveNativeOutPath(params, plan.request.outPath, 'cpu-report.json');
      const data = await runtime.operations.perfProfileReport({
        appId: session.appBundleId,
        kind: plan.request.kind,
        tracePath: isXctrace ? (source?.path ?? tracePath) : tracePath,
        outPath,
        template: plan.request.template ?? (last?.kind === 'xctrace' ? last.template : undefined),
        profile: last,
      });
      return {
        ok: true,
        data: withCaptureOutputOwnership(
          { perf: 'reported', ...data },
          params.req.internal?.publicNetworkOnly ? 'daemon' : 'caller',
          params.req.internal?.admittedLease?.tenantId ??
            LEASE_FIELD_NORMALIZERS.tenantId(resolveLeaseScope(params.req).tenantId),
        ),
      };
    }
  }
}

async function startPerfCapture(
  params: PerfRuntimeHandlerParams & { ref: SessionRef },
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
  const outPath = params.req.internal?.publicNetworkOnly
    ? path.join(
        params.sessionStore.ensureSessionDir(params.sessionName),
        `${randomUUID()}-${fallback}`,
      )
    : resolveNativeOutPath(params, request.outPath, fallback);
  const resourcePath = perfCaptureDurableResource.store.resolvePath(
    params.sessionStore.resolveSessionDir(params.sessionName),
  );
  const fence = perfCaptureDurableResource.createNextFence({
    admissionLedger: requirePerfCaptureAdmissionLedger(params),
    resourcePath,
    device: session.device,
  });
  const binding = bindSessionPerfCapture(
    params.sessionStore,
    params.ref,
    params.req.meta?.clientArtifactPaths?.outPath,
  );
  binding.assertAdoptable();
  const started = await runtime.operations.perfNativeCaptureStart({
    sessionId: params.sessionName,
    appId: session.appBundleId,
    mode: request.area === 'cpu' ? 'cpu-profile' : 'trace',
    kind: request.kind,
    template: request.template,
    outPath,
    fence,
  });
  const tenantId = params.req.internal?.admittedLease?.tenantId ?? params.req.meta?.tenantId;
  await adoptStartedPerfCapture({
    admissionLedger: requirePerfCaptureAdmissionLedger(params),
    binding,
    device: session.device,
    owner: runtime.owner,
    fence,
    pendingHandle: started.pendingHandle,
    envelope: {
      ...started.envelope,
      metadata: {
        ...started.envelope.metadata,
        ...(params.req.internal?.publicNetworkOnly ? { remoteCaptureOutputPath: outPath } : {}),
        ...(tenantId ? { remoteCaptureTenantId: tenantId } : {}),
        remoteCaptureLease: admittedOutputLeaseVerifier(params.req),
      },
    },
    throwIfCanceled: params.throwIfCanceled,
  });
  return { ok: true, data: started.response };
}

function requirePerfCaptureAdmissionLedger(
  params: PerfRuntimeHandlerParams,
): PerfCaptureAdmissionLedger {
  if (params.perfCaptureAdmissionLedger) return params.perfCaptureAdmissionLedger;
  throw new AppError('COMMAND_FAILED', 'Perf capture admission ledger is not configured', {
    reason: RUNTIME_GATEWAY_REASONS.missing.reason,
  });
}

async function stopPerfCapture(
  params: PerfRuntimeHandlerParams & { ref: SessionRef },
  session: SessionState,
  request: Extract<PerfRuntimeRequest, { area: 'cpu' | 'trace' }>,
): Promise<DaemonResponse> {
  const capture = session.perfCapture;
  if (!capture) return errorResponse('INVALID_ARGS', 'no active native perf capture');
  const metadata = capture.envelope.metadata;
  const owner = readString(metadata?.remoteCaptureLease) ?? null;
  assertPerfOutputOwner(params.req, owner);
  const tenantId = resolveStoppedCaptureTenant(
    params.req,
    session,
    metadata?.remoteCaptureTenantId,
  );
  const snapshot = capture.handle.inspect();
  const mismatchMessage = perfCaptureStopMismatch(snapshot, request);
  if (mismatchMessage) return errorResponse('INVALID_ARGS', mismatchMessage);
  if (request.outPath) {
    capture.handle.setOutputPath(
      expandSessionPath(request.outPath, requestCwd(params.req, params.host)),
    );
  }
  const completion = await finishLivePerfCapture({
    intent: 'capture',
    binding: bindSessionPerfCapture(params.sessionStore, params.ref),
  });
  const outPath = readString(completion.outPath);
  const daemonOwned = outPath !== undefined && metadata?.remoteCaptureOutputPath === outPath;
  if (request.area === 'cpu') {
    const profile = readProfileHandoff(completion);
    if (daemonOwned) retainPerfReportSource(profile.outPath, owner);
    params.sessionStore.update(params.ref, {
      lastPerfProfile: { profile, leaseVerifier: owner },
    });
  }
  const clientOutPath = params.req.meta?.clientArtifactPaths?.outPath ?? capture.clientOutPath;
  const artifacts =
    daemonOwned && completion.kind === 'xctrace'
      ? [await publishXctraceDownload(outPath, clientOutPath, request.area === 'cpu')]
      : undefined;
  return {
    ok: true,
    data: withCaptureOutputOwnership(
      {
        ...completion,
        ...(clientOutPath ? { clientOutPath } : {}),
        ...(artifacts ? { artifacts } : {}),
      },
      daemonOwned ? 'daemon' : 'caller',
      tenantId,
      owner,
    ),
  };
}

function resolveStoppedCaptureTenant(req: DaemonRequest, session: SessionState, stored: unknown) {
  return readString(stored) ?? session.lease?.tenantId ?? req.meta?.tenantId;
}

function resolveExplicitPerfSource(tracePath: string) {
  const source = readPerfSource(tracePath);
  if (!source) {
    throw new AppError('INVALID_ARGS', 'tracePath must name a readable stopped profile trace.', {
      field: 'tracePath',
    });
  }
  return source;
}

type PerfReportSource = { path: string; stat: Stats };

function samePerfSource(source: PerfReportSource, otherPath: string): boolean {
  if (source.path === otherPath) return true;
  const other = readPerfSource(otherPath);
  return other?.stat.dev === source.stat.dev && other.stat.ino === source.stat.ino;
}

function assertPerfSourceLease(params: PerfRuntimeHandlerParams, source: PerfReportSource): void {
  const owner = admittedOutputLeaseVerifier(params.req);
  for (const session of params.sessionStore.values()) {
    const retained = session.lastPerfProfile;
    if (
      retained?.leaseVerifier &&
      retained.leaseVerifier !== owner &&
      samePerfSource(source, retained.profile.outPath)
    ) {
      throw leasedOutputRefusal('Performance capture');
    }
    const capture = session.perfCapture;
    const captureOwner = readString(capture?.envelope.metadata?.remoteCaptureLease);
    if (capture && captureOwner && captureOwner !== owner) {
      const capturePath = readString(capture.handle.inspect().outPath);
      if (capturePath && samePerfSource(source, capturePath)) {
        throw leasedOutputRefusal('Performance capture');
      }
    }
  }
  assertTrackedPerformanceSourceLease(source.path, source.stat, owner);
}

function readPerfSource(tracePath: string): PerfReportSource | undefined {
  try {
    const resolved = realpathSync(tracePath);
    return { path: resolved, stat: statSync(resolved) };
  } catch {
    return undefined;
  }
}

function canReadPerfOutput(req: DaemonRequest, owner: string | null | undefined): boolean {
  return !owner || owner === admittedOutputLeaseVerifier(req);
}

function assertPerfOutputOwner(req: DaemonRequest, owner: string | null | undefined): void {
  if (!canReadPerfOutput(req, owner)) throw leasedOutputRefusal('Performance capture');
}

async function publishXctraceDownload(
  outPath: string,
  clientOutPath: string | undefined,
  keepForReport: boolean,
): Promise<DaemonArtifact> {
  const publishedPath = path.join(path.dirname(outPath), `${randomUUID()}.trace`);
  try {
    if (keepForReport) {
      await cp(outPath, publishedPath, { recursive: true, errorOnExist: true, force: false });
    } else {
      await rename(outPath, publishedPath);
    }
  } catch (error) {
    await rm(publishedPath, { recursive: true, force: true });
    throw error;
  }
  return {
    field: 'outPath',
    artifactType: 'performance',
    path: publishedPath,
    fileName: path.basename(clientOutPath ?? outPath),
    localPath: clientOutPath,
  };
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
  if (!isRecord(metric) || metric.available !== true) return metric;
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
  if (requestedPath) return expandSessionPath(requestedPath, requestCwd(params.req, params.host));
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
