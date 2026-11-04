import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import path from 'node:path';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { isScreenRecordingStartNotDispatched } from '@agent-device/contracts/screen-recording-runtime';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';
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
import { namesSessionExplicitly } from '@agent-device/kernel/contracts';
import {
  deviceIdentityFlag,
  type DeviceIdentity,
  type DeviceInfo,
  type Platform,
} from '@agent-device/kernel/device';
import {
  resolveTargetDevice,
  type ResolveDeviceFlags,
} from '@agent-device/device-selection/dispatch-resolve';
import { hasDeviceSelectionInput } from '../../core/device/device-selector-intent.ts';
import { ensureBoundDeviceReady } from '../../core/request-runtime-binding.ts';
import { type ScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { createScreenRecordingRecoveryControl } from '@agent-device/capture-kit/screen-recording-recovery';
import {
  SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY,
  SCREEN_RECORDING_CLAIM_BINDING_VERSION_KEY,
} from '@agent-device/capture-kit/screen-recording-resource-store';
import {
  adoptStartedScreenRecording,
  finishLiveScreenRecording,
  finishRecoveredScreenRecording,
  screenRecordingDurableResource,
} from '@agent-device/capture-kit/screen-recording-session-resource';
import {
  resolveScreenRecordingStopRecovery,
  screenRecordingManifestDevice,
  screenRecordingManifestIsTerminal,
} from '@agent-device/capture-kit/screen-recording-stop-recovery';
import { resolveSessionScope } from '../session-routing.ts';
import type { SessionStore } from '../../core/session-store.ts';
import type {
  BindDeviceRuntime,
  BindExactDeviceRuntime,
} from '../../core/request-runtime-binding.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../../core/session-state.ts';
import { sessionHasOwnersBeyondRecording } from '../../core/session-state.ts';
import { withCaptureOutputOwnership } from '../../core/capture-output-ownership.ts';
import { recordSessionAction } from '../../core/session-action-recorder.ts';
import { adoptRecordOnlyRecordingClaim } from '../session-lifecycle/internal/session-open.ts';
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
import { buildRemoteTempArtifactPath } from '@agent-device/contracts/daemon-http';
import { randomUUID } from 'node:crypto';
import {
  buildRecordingStartResponse,
  buildRecordingStartedAction,
  buildRecordingStopResponse,
  buildRecordingUnsupportedResponse,
  isDaemonOwnedRecordingOutput,
} from './record-runtime-response.ts';

/**
 * A stop either finishes the live export or reports one the daemon already finished. Only the
 * first owes a session action: the request that terminalized the recording already recorded it.
 */
type ScreenRecordingStop = Readonly<{
  completion: ScreenRecordingCompletion;
  recordsSessionAction: boolean;
}>;

export type RecordRuntimeHandlerParams = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  bindDevice: BindDeviceRuntime;
  platformServices: DaemonPlatformServices;
  bindExactDevice: BindExactDeviceRuntime;
  admissionLedger: ScreenRecordingAdmissionLedger;
  requestScope: PlatformRequestScope;
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
  const existingRef = sessionStore.lookup(sessionName);
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
  const resolvedSession = await resolveRecordingSession(params, existingRef, plan);
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
  plan: ReturnType<typeof resolveRecordPlan>['plan'],
): Promise<Readonly<{ session: SessionState; ref?: SessionRef; needsReadiness: boolean }>> {
  if (ref) return { session: params.sessionStore.requireCurrent(ref), ref, needsReadiness: false };
  const device = await resolveUnheldRecordingDevice(params, plan);
  await params.retainDeviceExecutionLock(device.id);
  return { session: createRecordOnlySession(params, device), needsReadiness: true };
}

/**
 * The device an unheld record request is answered on, and the single place the record handler
 * applies the named-session rule (#3674) at its only device selection.
 *
 * A request that names a session this daemon does not hold and states no device is answered from
 * the durable manifest the session address finds, never from a sweep of every device on the host:
 * a decodable manifest is re-resolved with the request's scope and lease keys under the manifest's
 * family (admission proved the request states no device), and a start or a stop with no decodable
 * manifest to recover from refuses with the named-session error.
 * `assertManifestBelongsToRequest` owns the proof that the resolved device
 * and session address match the manifest.
 *
 * The two shapes that keep their chosen target are unchanged: a request that never named a
 * session resolves sessionlessly from its flags, and one that states a device selector resolves
 * from it.
 */
async function resolveUnheldRecordingDevice(
  params: RecordRuntimeHandlerParams,
  plan: ReturnType<typeof resolveRecordPlan>['plan'],
): Promise<DeviceInfo> {
  const { req, sessionName } = params;
  if (!namesSessionWithoutTarget(req))
    return await resolveTargetDevice(req.flags ?? {}, { env: params.sessionStore.host.env });
  if (plan.kind === 'stop-recovery') {
    const recorded = screenRecordingManifestDevice({
      sessionName,
      sessionStore: params.sessionStore,
    });
    if (recorded) {
      return await resolveManifestDevice(params, recorded);
    }
  }
  const { namedSessionNotFoundError } = await import('../../core/explicit-session-resolution.ts');
  throw namedSessionNotFoundError(sessionName);
}

/** Whether this request is addressed to a session and leaves its device to the session. */
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
  return await resolveTargetDevice(selector, { env: params.sessionStore.host.env });
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
  const draft = ref
    ? undefined
    : bindRecordOnlyScreenRecording(params.sessionStore, params.sessionName, session);
  const binding = ref ? bindSessionScreenRecording(params.sessionStore, ref) : draft!.binding;
  binding.assertAdoptable();
  const admission = await params.bindDevice(session.device, screenRecordingAdmissionUse);
  if (needsReadiness) await ensureBoundDeviceReady(admission, params.platformServices);
  const startFact = admission.facts.screenRecordingStart;
  if (!startFact.available) return buildRecordingUnsupportedResponse(startFact);
  const runtime = await params.bindDevice(session.device, use);
  const { fence, outputPaths } = prepareRecordingStart(params, session);
  binding.assertAdoptable();
  await params.req.internal?.reserveRecordingFence?.(fence);
  params.req.internal?.recordStartAttempt?.();
  let started: Awaited<ReturnType<typeof runtime.operations.screenRecordingStart>>;
  try {
    started = await runtime.operations.screenRecordingStart(
      screenRecordingStartInput(params, session, prepared, fence, outputPaths),
    );
  } catch (error) {
    if (isScreenRecordingStartNotDispatched(error))
      params.req.internal?.recordStartNoEffect?.('not-dispatched');
    throw error;
  }
  const tenantId = session.lease?.tenantId ?? params.req.meta?.tenantId;
  const recordingClaim = params.req.internal?.recordingClaimOwnership?.();
  const claimToken = recordingClaim?.ownerToken;
  await adoptStartedScreenRecording({
    admissionLedger: params.admissionLedger,
    binding,
    device: session.device,
    owner: runtime.owner,
    fence,
    ...started,
    reportConfirmedStartRollback: () => params.req.internal?.recordStartNoEffect?.('rolled-back'),
    envelope:
      params.req.internal?.publicNetworkOnly || tenantId || claimToken
        ? {
            ...started.envelope,
            metadata: {
              ...started.envelope.metadata,
              ...(params.req.internal?.publicNetworkOnly ? { remoteCaptureOutput: true } : {}),
              ...(tenantId ? { remoteCaptureTenantId: tenantId } : {}),
              ...(claimToken
                ? {
                    [SCREEN_RECORDING_CLAIM_TOKEN_METADATA_KEY]: claimToken,
                    [SCREEN_RECORDING_CLAIM_BINDING_VERSION_KEY]: 1,
                  }
                : {}),
            },
          }
        : started.envelope,
    throwIfCanceled: params.throwIfCanceled,
  });
  const adoptedRef = ref ?? draft!.requireRef();
  if (recordingClaim)
    adoptRecordOnlyRecordingClaim(params.sessionStore, adoptedRef, recordingClaim);
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
  );
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
    outputPaths: resolveRecordingStartPaths(
      params.req,
      session.device.platform,
      params.sessionStore.host.cwd,
      params.sessionStore.ensureSessionDir(params.sessionName),
    ),
  };
}

type RecordingStartPaths = RecordingOutputPaths & Readonly<{ clientOutputPath?: string }>;

function resolveRecordingStartPaths(
  req: DaemonRequest,
  platform: Platform,
  hostCwd: string,
  sessionDir: string,
): RecordingStartPaths {
  const requestedPath = req.positionals?.[1];
  const clientOutputPath = req.meta?.clientArtifactPaths?.outPath;
  if (req.internal?.publicNetworkOnly) {
    const extension = recordingExtensionForPlatform(platform);
    return {
      ...resolveRecordingOutputPaths({
        requestedPath: path.join(sessionDir, `recording-${randomUUID()}${extension}`),
        platform,
        cwd: hostCwd,
      }),
      ...(clientOutputPath === undefined
        ? {}
        : { clientOutputPath: appendRecordingExtensionWhenMissing(clientOutputPath, extension) }),
    };
  }
  if (requestedPath === undefined && clientOutputPath !== undefined) {
    // A remote caller that names no path cannot know the session platform's extension, so it sends
    // its local destination without one; its cwd does not exist on this host.
    const extension = recordingExtensionForPlatform(platform);
    return {
      ...resolveRecordingOutputPaths({
        requestedPath: buildRemoteTempArtifactPath('recording', extension),
        platform,
        cwd: hostCwd,
      }),
      clientOutputPath: appendRecordingExtensionWhenMissing(clientOutputPath, extension),
    };
  }
  return {
    ...resolveRecordingOutputPaths({
      requestedPath,
      platform,
      cwd: req.meta?.cwd ?? hostCwd,
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
    ...(params.req.internal?.recordingClaimOwnership?.()?.ownerToken
      ? { claimToken: params.req.internal.recordingClaimOwnership()!.ownerToken }
      : {}),
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
): Promise<DaemonResponse> {
  let stopped: ScreenRecordingStop;
  try {
    if (kind === 'stop-live') {
      await params.req.internal?.retryRecordingCleanup?.(session.device);
      await params.bindDevice(session.device, screenRecordingAdmissionUse);
    }
    stopped =
      kind === 'stop-live'
        ? {
            completion: await finishLiveScreenRecording({
              intent: 'capture',
              binding: bindSessionScreenRecording(params.sessionStore, ref!),
            }),
            recordsSessionAction: true,
          }
        : await finishRecovered(params, session, needsReadiness);
  } catch (error) {
    deleteTerminalRecordOnlySession(params, ref);
    throw error;
  }
  const completion = stopped.completion;
  const response = buildRecordingStopResponse(completion);
  const resourcePath = screenRecordingDurableResource.resourcePath(
    params.sessionStore,
    params.sessionName,
  );
  const record = screenRecordingDurableResource.store.read(resourcePath);
  const daemonOwned = isDaemonOwnedRecordingOutput(
    completion,
    record.status === 'decoded' && record.envelope.metadata?.remoteCaptureOutput === true,
  );
  const tenantId =
    record.status === 'decoded' &&
    typeof record.envelope.metadata?.remoteCaptureTenantId === 'string'
      ? record.envelope.metadata.remoteCaptureTenantId
      : session.lease?.tenantId;
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
  return response.ok && response.data
    ? {
        ...response,
        data: withCaptureOutputOwnership(
          response.data,
          daemonOwned ? 'daemon' : 'caller',
          tenantId,
        ),
      }
    : response;
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
): Promise<ScreenRecordingStop> {
  const recovery = resolveScreenRecordingStopRecovery({
    sessionName: params.sessionName,
    sessionStore: params.sessionStore,
    device: session.device,
  });
  await params.req.internal?.retryRecordingCleanup?.(session.device);
  const settled = await params.req.internal?.recoverIncompleteRecordingStart?.(session.device);
  if (recovery.kind === 'none' || settled) {
    throw new AppError(
      'INVALID_ARGS',
      'no active recording',
      settled ? { reason: 'recording-start-rolled-back' } : undefined,
    );
  }
  if (recovery.kind === 'completed') {
    return { completion: recovery.completion, recordsSessionAction: false };
  }
  await params.bindDevice(session.device, screenRecordingAdmissionUse);
  const completion = await finishRecoveredScreenRecording({
    resourcePath: recovery.resourcePath,
    scope: params.requestScope,
    acquireControl: async (envelope, recoveryScope) => {
      const runtime = await params.bindExactDevice(
        session.device,
        envelope.owner,
        envelope.fence,
        screenRecordingRecoveryUse,
        recoveryScope,
      );
      if (needsReadiness) await ensureBoundDeviceReady(runtime, params.platformServices);
      return createScreenRecordingRecoveryControl({ runtime, dispose: async () => {} });
    },
  });
  return { completion, recordsSessionAction: true };
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
