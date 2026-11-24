import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import path from 'node:path';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import {
  bindSessionScreenRecording,
  bindRecordOnlyScreenRecording,
} from '../../core/session-capture-binding.ts';
import {
  resolveScreenRecordingRuntimePlan,
  screenRecordingAdmissionUse,
  screenRecordingRecoveryUse,
  screenRecordingStartUse,
} from '@agent-device/contracts/screen-recording-runtime-plan';
import { isWholeScreenRecordingScope } from '@agent-device/contracts/recording';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { namesSessionExplicitly } from '@agent-device/kernel/record';
import {
  deviceIdentityFlag,
  type DeviceIdentity,
  type DeviceInfo,
  type Platform,
} from '@agent-device/kernel/device';
import { type ResolveDeviceFlags } from '@agent-device/device-selection/dispatch-resolve';
import { hasDeviceSelectionInput } from '../../core/device/device-selector-intent.ts';
import { ensureBoundDeviceReady } from '../../core/request-runtime-binding.ts';
import { type ScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { createScreenRecordingRecoveryControl } from '@agent-device/capture-kit/screen-recording-recovery';
import {
  adoptStartedScreenRecording,
  finishLiveScreenRecording,
  finishPendingScreenRecordingProof,
  finishRecoveredScreenRecording,
  screenRecordingDurableResource,
} from '@agent-device/capture-kit/screen-recording-session-resource';
import {
  resolveScreenRecordingStopRecovery,
  readStoredCompletion,
  unreadableRecordingProof,
  screenRecordingManifestIsTerminal,
} from '@agent-device/capture-kit/screen-recording-stop-recovery';
import { resolveSessionScope } from '../session-routing.ts';
import { type SessionStore, SessionCoordinator } from '../../core/session-store.ts';
import type {
  BindDeviceRuntime,
  BindExactDeviceRuntime,
} from '../../core/request-runtime-binding.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { requestCwd } from '../../core/context.ts';
import type { SessionRef, SessionState } from '../../core/session-state.ts';
import { sessionHasOwnersBeyondRecording } from '../../core/session-state.ts';
import { resolveLeaseScope } from '../../core/lease-context.ts';
import {
  leasedOutputRefusal,
  leaseVerifier,
  requestHoldsOutputLease,
} from '../../resources/artifact-tracking.ts';
import { recordSessionAction } from '../../core/session-action-recorder.ts';
import {
  missingAppSessionResponse,
  prepareRecordingRequest,
  readRecordingScope,
} from './record-runtime-request.ts';
import {
  appendRecordingExtensionWhenMissing,
  type RecordingOutputPaths,
  recordingExtensionForPlatform,
  resolveRecordingOutputPaths,
} from '@agent-device/capture-kit/recording-output-path';
import { isRemoteTempArtifactPath, normalizeTenantId } from '@agent-device/contracts/daemon-http';
import { randomUUID } from 'node:crypto';
import {
  buildRecordingStartResponse,
  buildRecordingStartedAction,
  buildRecordingStopResponse,
  buildRecordingUnsupportedResponse,
  recordingOutputLeaseVerifier,
  UNLEASED_CAPTURE,
} from './record-runtime-response.ts';
import { commitRecordingOutputs } from '../recording-outputs.ts';
import { resolveRequestTargetDevice } from '../../core/request-device-resolution.ts';

/**
 * A stop either finishes the live export or reports one the daemon already finished. Only the
 * first owes a session action: the request that terminalized the recording already recorded it.
 */
type ScreenRecordingStop = Readonly<{
  envelope: DurableResourceEnvelope<'screen-recording'>;
  recordsSessionAction: boolean;
}>;

export type RecordRuntimeHandlerParams = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  sessionRef?: SessionRef;
  bindDevice: BindDeviceRuntime;
  platformServices: DaemonPlatformServices;
  bindExactDevice: BindExactDeviceRuntime;
  admissionLedger: ScreenRecordingAdmissionLedger;
  requestScope: PlatformRequestScope;
  suiteCapture?: 'local' | 'remote';
  retainDeviceExecutionLock(deviceId: string): Promise<void>;
  throwIfCanceled(): void;
}>;

export async function handleRecordCommand(
  params: RecordRuntimeHandlerParams,
): Promise<DaemonResponse> {
  try {
    return await handleRecordCommandUnsafe(params);
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

async function handleRecordCommandUnsafe(
  params: RecordRuntimeHandlerParams,
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const existingRef = params.sessionRef ?? sessionStore.lookup(sessionName);
  const existingSession = existingRef?.session;
  const { plan, scope } = resolveRecordPlan(req, existingSession);
  // The app-scope refusal states what a start needs beyond a device, so it answers only for a
  // request that can still reach one: a start naming a session this daemon does not hold is
  // answered on the session first, at resolveRecordingSession below, where every record lane
  // meets the one named-session rule at the only device selection the handler makes.
  if (
    plan.kind === 'start' &&
    !isWholeScreenRecordingScope(scope) &&
    !existingSession &&
    !namesSessionWithoutTarget(req)
  ) {
    return missingAppSessionResponse(req);
  }
  const authorized = plan.kind === 'start' ? undefined : readStopEnvelope(params);
  if (authorized) assertRequestMayStopRecording(params, authorized);
  const resolvedSession = await resolveRecordingSession(params, existingRef, authorized?.device);
  const { session } = resolvedSession;
  if (plan.kind === 'start') {
    return await startRecording(
      params,
      session,
      resolvedSession.ref,
      prepareRecordingRequest(req),
      plan.use,
      resolvedSession.needsReadiness,
    );
  }
  return await stopRecording(
    params,
    session,
    resolvedSession.ref,
    plan.kind,
    resolvedSession.needsReadiness,
    authorized,
  );
}

function resolveRecordPlan(req: DaemonRequest, session: SessionState | undefined) {
  const scope = readRecordingScope(req.flags?.recordingScope);
  return {
    scope,
    plan: resolveScreenRecordingRuntimePlan({
      action: req.positionals?.[0],
      scope,
      hasLiveHandle: session?.screenRecording !== undefined,
    }),
  };
}

async function resolveRecordingSession(
  params: RecordRuntimeHandlerParams,
  ref: SessionRef | undefined,
  recorded: DeviceIdentity | undefined,
): Promise<Readonly<{ session: SessionState; ref?: SessionRef; needsReadiness: boolean }>> {
  if (ref) return { session: params.sessionStore.requireCurrent(ref), ref, needsReadiness: false };
  const device = await resolveUnheldRecordingDevice(params, recorded);
  await params.retainDeviceExecutionLock(device.id);
  return { session: createRecordOnlySession(params, device), needsReadiness: true };
}

async function resolveUnheldRecordingDevice(
  params: RecordRuntimeHandlerParams,
  recorded: DeviceIdentity | undefined,
): Promise<DeviceInfo> {
  const { req, sessionName } = params;
  if (!namesSessionWithoutTarget(req))
    return await resolveRequestTargetDevice(req, { env: params.sessionStore.host.env });
  // A named unheld session only selects the device from its authorized manifest (#3674).
  if (recorded) return await resolveManifestDevice(params, recorded);
  const { namedSessionNotFoundError } = await import('../../core/explicit-session-resolution.ts');
  throw namedSessionNotFoundError(sessionName);
}

function namesSessionWithoutTarget(req: DaemonRequest): boolean {
  return namesSessionExplicitly(req) && !hasDeviceSelectionInput(req.flags);
}

/**
 * Re-resolves the device a durable manifest names. Admission (`namesSessionWithoutTarget`) has
 * already proven this request states no device, udid, serial, platform, or target, so spreading
 * its flags carries exactly the scope and lease keys `ResolveDeviceFlags` declares — now and
 * later — without carrying any device choice. The manifest then decides which device: family
 * always, identity flag where the family has one. `assertManifestBelongsToRequest` proves the
 * resolved device against the manifest.
 */
async function resolveManifestDevice(
  params: RecordRuntimeHandlerParams,
  recorded: DeviceIdentity,
): Promise<DeviceInfo> {
  const selector: ResolveDeviceFlags = {
    ...(params.req.flags ?? {}),
    platform: recorded.family,
  };
  const identityFlag = deviceIdentityFlag(recorded.family);
  if (identityFlag) selector[identityFlag] = recorded.id;
  return await resolveRequestTargetDevice(
    params.req,
    { env: params.sessionStore.host.env },
    selector,
  );
}

async function startRecording(
  params: RecordRuntimeHandlerParams,
  session: SessionState,
  ref: SessionRef | undefined,
  prepared: ReturnType<typeof prepareRecordingRequest>,
  use: typeof screenRecordingStartUse,
  needsReadiness: boolean,
): Promise<DaemonResponse> {
  if (session.screenRecording) {
    return { ok: false, error: { code: 'INVALID_ARGS', message: 'recording already in progress' } };
  }
  const slot = ref
    ? undefined
    : new SessionCoordinator(params.sessionStore).reserve(params.req, params.sessionName);
  const draft =
    slot && bindRecordOnlyScreenRecording(params.sessionStore, params.sessionName, session, slot);
  const lifetimeId = ref?.lifetime.journalId ?? slot!.lifetimeId;
  const binding = ref ? bindSessionScreenRecording(params.sessionStore, ref) : draft!.binding;
  binding.assertAdoptable();
  const admission = await params.bindDevice(session.device, screenRecordingAdmissionUse);
  if (needsReadiness)
    await ensureBoundDeviceReady(admission, params.platformServices, params.requestScope);
  const startFact = admission.facts.screenRecordingStart;
  if (!startFact.available) return buildRecordingUnsupportedResponse(startFact);
  const runtime = await params.bindDevice(session.device, use);
  // A recording that died with its device can leave a record that no claim or daemon start
  // retries. Settle the records this start would refuse on, unless their session is still held.
  await screenRecordingDurableResource.settleStartConflicts({
    resourcePath: screenRecordingDurableResource.resourcePath(
      params.sessionStore,
      params.sessionName,
    ),
    device: session.device,
    holdsSession: (sessionId) => params.sessionStore.lookup(sessionId) !== undefined,
    scope: params.requestScope,
    acquireControl: exactRecoveryControl(params, session.device, false),
  });
  const { fence, outputPaths } = prepareRecordingStart(params, session);
  binding.assertAdoptable();
  params.throwIfCanceled();
  const started = await runtime.operations.screenRecordingStart(
    screenRecordingStartInput(params, session, prepared, fence, outputPaths),
  );
  await adoptStartedScreenRecording({
    admissionLedger: params.admissionLedger,
    binding,
    device: session.device,
    owner: runtime.owner,
    fence,
    ...started,
    envelope: withCaptureOwner(started.envelope, params, outputPaths, lifetimeId),
    throwIfCanceled: params.throwIfCanceled,
  });
  const adoptedRef = ref ?? draft!.requireRef();
  const adopted = binding.read();
  if (!adopted) throw new TypeError('Screen recording adoption did not publish a live handle');
  const snapshot = adopted.handle.inspect();
  recordSessionAction(
    params.sessionStore,
    adoptedRef,
    params.req,
    params.req.command,
    buildRecordingStartedAction(snapshot),
  );
  return buildRecordingStartResponse(
    snapshot,
    params.sessionStore.ensureSessionDir(params.sessionName),
    outputPaths.requestedPath,
    !params.suiteCapture && outputPaths.daemonOwned === true,
  );
}

/**
 * Names in the manifest who gets the export: a remote caller, its tenant, and the lease that started
 * the recording, or that no lease did. A manifest that names neither is of unknown ownership.
 */
function withCaptureOwner(
  envelope: DurableResourceEnvelope<'screen-recording'>,
  { req, suiteCapture }: RecordRuntimeHandlerParams,
  output: RecordingStartPaths,
  lifetimeId: string,
): DurableResourceEnvelope<'screen-recording'> {
  const lease = req.internal?.admittedLease;
  const tenantId = normalizeTenantId(lease?.tenantId ?? req.meta?.tenantId);
  const leaseId = lease?.leaseId;
  return {
    ...envelope,
    metadata: {
      ...envelope.metadata,
      ...(output.daemonOwned
        ? {
            remoteCaptureOutput: true,
            remoteCapturePath: output.outputPath,
            remoteCaptureReservation: envelope.fence.token,
            remoteCaptureLifetime: lifetimeId,
            remoteCaptureTenantId: tenantId ?? null,
            ...(suiteCapture === 'remote' &&
            req.meta?.clientArtifactPaths?.artifactsDir &&
            req.positionals?.[1]
              ? { suiteRecordingArchivePath: req.positionals[1] }
              : {}),
          }
        : {}),
      ...(!output.daemonOwned && tenantId ? { remoteCaptureTenantId: tenantId } : {}),
      ...(suiteCapture ? { suiteRecordingLifetime: lifetimeId } : {}),
      remoteCaptureLease: leaseId ? leaseVerifier(leaseId) : UNLEASED_CAPTURE,
    },
  };
}

function prepareRecordingStart(params: RecordRuntimeHandlerParams, session: SessionState) {
  const resourcePath = screenRecordingDurableResource.resourcePath(
    params.sessionStore,
    params.sessionName,
  );
  return {
    fence: screenRecordingDurableResource.createNextFence({
      admissionLedger: params.admissionLedger,
      resourcePath,
      device: session.device,
    }),
    outputPaths:
      params.suiteCapture === 'local'
        ? {
            ...resolveRecordingOutputPaths({
              requestedPath: params.req.positionals?.[1],
              platform: session.device.platform,
              cwd: params.sessionStore.host.cwd,
            }),
          }
        : resolveRecordingStartPaths(
            params.suiteCapture === 'remote'
              ? { ...params.req, internal: { ...params.req.internal, publicNetworkOnly: true } }
              : params.req,
            session.device.platform,
            params.sessionStore.host.cwd,
            params.sessionStore.ensureSessionDir(params.sessionName),
          ),
  };
}

type RecordingStartPaths = RecordingOutputPaths &
  Readonly<{ clientOutputPath?: string; daemonOwned?: true }>;

function resolveRecordingStartPaths(
  req: DaemonRequest,
  platform: Platform,
  hostCwd: string,
  sessionDir: string,
): RecordingStartPaths {
  const requestedPath = req.positionals?.[1];
  const clientOutputPath = req.meta?.clientArtifactPaths?.outPath;
  const remotePlaceholder =
    requestedPath !== undefined &&
    isRemoteTempArtifactPath(requestedPath, 'recording', path.extname(requestedPath));
  if (
    req.internal?.publicNetworkOnly ||
    (clientOutputPath !== undefined && (requestedPath === undefined || remotePlaceholder))
  ) {
    const extension = recordingExtensionForPlatform(platform);
    return {
      ...resolveRecordingOutputPaths({
        requestedPath: path.join(sessionDir, `recording-${randomUUID()}${extension}`),
        platform,
        cwd: hostCwd,
      }),
      daemonOwned: true,
      ...(clientOutputPath === undefined
        ? {}
        : {
            clientOutputPath:
              remotePlaceholder && !req.internal?.publicNetworkOnly
                ? clientOutputPath
                : appendRecordingExtensionWhenMissing(clientOutputPath, extension),
          }),
    };
  }
  return {
    ...resolveRecordingOutputPaths({
      requestedPath,
      platform,
      cwd: requestCwd(req, { cwd: hostCwd }),
    }),
    ...(clientOutputPath === undefined ? {} : { clientOutputPath }),
  };
}

function screenRecordingStartInput(
  params: RecordRuntimeHandlerParams,
  session: SessionState,
  prepared: ReturnType<typeof prepareRecordingRequest>,
  fence: ScreenRecordingStartInput['fence'],
  outputPaths: RecordingStartPaths,
): ScreenRecordingStartInput {
  return {
    sessionId: params.sessionName,
    requestId: params.req.meta?.requestId,
    outputPath: outputPaths.outputPath,
    clientOutputPath: outputPaths.clientOutputPath,
    scope: prepared.scope,
    showTouches: prepared.showTouches,
    hideTouchesRequested: prepared.hideTouchesRequested,
    recordOnlySession: session.recordOnlySession === true,
    activeSessionApp: recordingAppIdentity(session),
    exportQuality: prepared.exportQuality,
    fps: prepared.fps,
    fence,
  };
}

function recordingAppIdentity(
  session: SessionState,
): ScreenRecordingStartInput['activeSessionApp'] {
  if (!session.appBundleId) return undefined;
  return { bundleId: session.appBundleId, ...(session.appName ? { name: session.appName } : {}) };
}

async function stopRecording(
  params: RecordRuntimeHandlerParams,
  session: SessionState,
  ref: SessionRef | undefined,
  kind: 'stop-live' | 'stop-recovery',
  needsReadiness: boolean,
  authorized: DurableResourceEnvelope<'screen-recording'> | undefined,
): Promise<DaemonResponse> {
  let stopped: ScreenRecordingStop;
  try {
    stopped =
      kind === 'stop-live'
        ? await finishAuthorizedLiveRecording(params, ref!, authorized)
        : await finishRecovered(params, session, needsReadiness, authorized);
  } catch (error) {
    deleteTerminalRecordOnlySession(params, ref);
    throw error;
  }
  const { envelope } = stopped;
  const completion = readStoredCompletion(envelope.metadata);
  if (!completion) throw unreadableRecordingProof();
  if (stopped.recordsSessionAction) {
    recordSessionAction(params.sessionStore, ref, params.req, params.req.command, {
      action: 'stop',
      outPath: completion.outPath,
      ...(completion.clientOutPath
        ? { requestedFileName: path.basename(completion.clientOutPath) }
        : {}),
      showTouches: completion.showTouches,
    });
  }
  // Retirement runs no teardown, so it releases a session only while nothing else owns it; the
  // session has to be re-read here, because the record this stop started with may have gained an
  // app, a capture, a claim, or a lease while the recording was being finished.
  if (ref) retireRecordOnlySession(params.sessionStore, ref);
  const remote = isRemoteRecordingRequest(params);
  const artifacts =
    envelope.metadata?.remoteCaptureOutput === true &&
    (remote || envelope.metadata.remoteCaptureExport !== undefined)
      ? await commitRecordingOutputs(envelope, ref ? 'live' : 'replay')
      : undefined;
  if (remote && !artifacts) throw leasedOutputRefusal('Recording');
  return buildRecordingStopResponse(completion, artifacts, !params.suiteCapture && remote);
}

async function finishAuthorizedLiveRecording(
  params: RecordRuntimeHandlerParams,
  ref: SessionRef,
  authorized: DurableResourceEnvelope<'screen-recording'> | undefined,
): Promise<ScreenRecordingStop> {
  const binding = bindSessionScreenRecording(params.sessionStore, ref);
  const active = binding.read();
  if (!authorized || !active || !sameRecordingFence(active.envelope, authorized))
    throw unreadableRecordingProof();
  await finishLiveScreenRecording({ intent: 'capture', binding });
  return { envelope: requireFinishedEnvelope(params, authorized), recordsSessionAction: true };
}

function isRemoteRecordingRequest(params: RecordRuntimeHandlerParams): boolean {
  return (
    params.suiteCapture === 'remote' ||
    params.req.internal?.publicNetworkOnly === true ||
    params.req.meta?.clientArtifactPaths?.outPath !== undefined
  );
}

function readStopEnvelope(params: RecordRuntimeHandlerParams) {
  const record = screenRecordingDurableResource.store.read(
    screenRecordingDurableResource.resourcePath(params.sessionStore, params.sessionName),
  );
  if (record.status === 'unreattachable') throw unreadableRecordingProof();
  return record.status === 'decoded' ? record.envelope : undefined;
}

function sameRecordingFence(
  left: DurableResourceEnvelope<'screen-recording'>,
  right: DurableResourceEnvelope<'screen-recording'>,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.fence.token === right.fence.token &&
    left.fence.generation === right.fence.generation
  );
}

function requireFinishedEnvelope(
  params: RecordRuntimeHandlerParams,
  expected: DurableResourceEnvelope<'screen-recording'>,
) {
  const envelope = readStopEnvelope(params);
  if (
    !envelope ||
    envelope.lifecycle !== 'completed' ||
    !sameRecordingFence(envelope, expected) ||
    envelope.metadata?.remoteCapturePath !== expected.metadata?.remoteCapturePath
  )
    throw unreadableRecordingProof();
  assertRequestMayStopRecording(params, envelope);
  return envelope;
}

/**
 * A stopped export needs only the lease id of its owner, also after
 * that lease ended. A recording that still runs needs the admitted lease.
 */
function assertRequestMayStopRecording(
  params: RecordRuntimeHandlerParams,
  envelope: DurableResourceEnvelope<'screen-recording'>,
): void {
  const { metadata, lifecycle } = envelope;
  const owner = recordingOutputLeaseVerifier(metadata);
  if (
    isRemoteRecordingRequest(params) &&
    (owner === undefined || metadata?.remoteCaptureOutput !== true)
  ) {
    throw leasedOutputRefusal('Recording');
  }
  if (
    metadata?.remoteCaptureOutput === true &&
    typeof metadata.remoteCaptureTenantId === 'string' &&
    metadata.remoteCaptureTenantId !==
      normalizeTenantId(params.req.internal?.admittedLease?.tenantId ?? params.req.meta?.tenantId)
  )
    throw leasedOutputRefusal('Recording');
  if (typeof owner !== 'string') return;
  const presented =
    lifecycle === 'completed' || metadata?.phase === 'export-proof-pending'
      ? (resolveLeaseScope(params.req).leaseId ?? params.req.internal?.admittedLease?.leaseId)
      : params.req.internal?.admittedLease?.leaseId;
  if (!requestHoldsOutputLease(owner, presented)) throw leasedOutputRefusal('Recording');
}

function deleteTerminalRecordOnlySession(
  params: Pick<RecordRuntimeHandlerParams, 'sessionName' | 'sessionStore'>,
  ref: SessionRef | undefined,
): void {
  if (!ref) return;
  if (screenRecordingManifestIsTerminal(params)) retireRecordOnlySession(params.sessionStore, ref);
}

/**
 * Ends a session that its own recording created — but only while the recording is still the only
 * thing that owns it. `SessionStore.retire` runs no teardown, so a session that has since gained an
 * app, a capture, a device claim, or a remote lease keeps its record and stays releasable by
 * `close`, which does own that teardown. Whether anything else took over is read from the session
 * itself rather than from any attaching path having reported itself, so no new attaching path can
 * be forgotten here. Callers hold the session's execution lock.
 *
 * A session that was never record-only, which is every session an `open` created, is left alone.
 */
function retireRecordOnlySession(store: SessionStore, ref: SessionRef): void {
  const session = store.resolveCurrent(ref);
  if (!session?.recordOnlySession) return;
  if (sessionHasOwnersBeyondRecording(session)) return;
  store.retire(ref);
}

async function finishRecovered(
  params: RecordRuntimeHandlerParams,
  session: SessionState,
  needsReadiness: boolean,
  authorized: DurableResourceEnvelope<'screen-recording'> | undefined,
): Promise<ScreenRecordingStop> {
  if (!authorized) throw new AppError('INVALID_ARGS', 'no active recording');
  const recovery = resolveScreenRecordingStopRecovery({
    sessionName: params.sessionName,
    sessionStore: params.sessionStore,
    device: session.device,
    admittedEnvelope: authorized,
  });
  if (recovery.kind === 'none') throw new AppError('INVALID_ARGS', 'no active recording');
  if (recovery.kind === 'completed')
    return { envelope: recovery.envelope, recordsSessionAction: false };
  if (authorized.metadata?.phase === 'export-proof-pending') {
    const envelope = await finishPendingScreenRecordingProof(recovery.resourcePath, authorized);
    assertRequestMayStopRecording(params, envelope);
    return { envelope, recordsSessionAction: false };
  }
  const acquire = exactRecoveryControl(params, session.device, needsReadiness);
  await finishRecoveredScreenRecording({
    resourcePath: recovery.resourcePath,
    scope: params.requestScope,
    acquireControl: (envelope, scope) => {
      if (!sameRecordingFence(envelope, recovery.envelope)) throw unreadableRecordingProof();
      assertRequestMayStopRecording(params, envelope);
      return acquire(envelope, scope);
    },
  });
  return {
    envelope: requireFinishedEnvelope(params, authorized),
    recordsSessionAction: true,
  };
}

/**
 * Recovery control bound to a record's own owner and fence, for a recording whose live handle this
 * daemon no longer holds. A recovered stop and the start-time settle share it.
 */
function exactRecoveryControl(
  params: RecordRuntimeHandlerParams,
  device: SessionState['device'],
  needsReadiness: boolean,
) {
  return async (
    envelope: DurableResourceEnvelope<'screen-recording'>,
    recoveryScope: PlatformRequestScope,
  ) => {
    const runtime = await params.bindExactDevice(
      device,
      envelope.owner,
      envelope.fence,
      screenRecordingRecoveryUse,
      recoveryScope,
    );
    if (needsReadiness)
      await ensureBoundDeviceReady(runtime, params.platformServices, recoveryScope);
    return createScreenRecordingRecoveryControl({ runtime, dispose: async () => {} });
  };
}

function createRecordOnlySession(
  params: Pick<RecordRuntimeHandlerParams, 'req' | 'sessionName'>,
  device: SessionState['device'],
): SessionState {
  return {
    name: params.sessionName,
    sessionScope: resolveSessionScope(params.req),
    device,
    createdAt: Date.now(),
    recordOnlySession: true,
    actions: [],
  };
}
