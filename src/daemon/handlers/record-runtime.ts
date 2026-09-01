import path from 'node:path';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import {
  resolveScreenRecordingRuntimePlan,
  screenRecordingAdmissionUse,
  screenRecordingRecoveryUse,
  screenRecordingStartUse,
} from '@agent-device/contracts/screen-recording-runtime-plan';
import { isWholeScreenRecordingScope } from '@agent-device/contracts/recording';
import { deviceIdentity, sameDeviceIdentity } from '@agent-device/kernel/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { resolveTargetDevice } from '../../core/dispatch-resolve.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import type { ScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import {
  adoptStartedScreenRecording,
  finishLiveScreenRecording,
  finishRecoveredScreenRecording,
  screenRecordingDurableResource,
} from '../screen-recording-session-resource.ts';
import { createScreenRecordingRecoveryControl } from '../screen-recording-resource-recovery.ts';
import { resolveSessionScope } from '../session-routing.ts';
import type { SessionStore } from '../session-store.ts';
import type { BindDeviceRuntime, BindExactDeviceRuntime } from '../request-runtime-binding.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { recordSessionAction } from '../session-action-recorder.ts';
import {
  missingAppSessionResponse,
  prepareRecordingRequest,
  readRecordingScope,
} from './record-runtime-request.ts';
import { resolveRecordingOutputPaths } from '../../recording/output-path.ts';
import {
  buildRecordingStartResponse,
  buildRecordingStartedAction,
  buildRecordingStopResponse,
  buildRecordingUnsupportedResponse,
} from './record-runtime-response.ts';

export type RecordRuntimeHandlerParams = Readonly<{
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  bindDevice: BindDeviceRuntime;
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
  const existingSession = sessionStore.get(sessionName);
  const { plan, scope } = resolveRecordPlan(req, existingSession);
  if (plan.kind === 'start' && !isWholeScreenRecordingScope(scope) && !existingSession) {
    return missingAppSessionResponse(req);
  }
  const session = await resolveRecordingSession(params, existingSession);
  if (plan.kind === 'start') {
    return await startRecording(params, session, prepareRecordingRequest(req), plan.use);
  }
  return await stopRecording(params, session, plan.kind);
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
  existing: SessionState | undefined,
): Promise<SessionState> {
  const device = existing?.device ?? (await resolveTargetDevice(params.req.flags ?? {}));
  await params.retainDeviceExecutionLock(device.id);
  if (existing) return existing;
  await ensureDeviceReady(device);
  return createRecordOnlySession(params, device);
}

async function startRecording(
  params: RecordRuntimeHandlerParams,
  session: SessionState,
  prepared: ReturnType<typeof prepareRecordingRequest>,
  use: typeof screenRecordingStartUse,
): Promise<DaemonResponse> {
  if (session.screenRecording) {
    return { ok: false, error: { code: 'INVALID_ARGS', message: 'recording already in progress' } };
  }
  const admission = await params.bindDevice(session.device, screenRecordingAdmissionUse);
  const startFact = admission.facts.screenRecordingStart;
  if (!startFact.available) return buildRecordingUnsupportedResponse(startFact);
  const runtime = await params.bindDevice(session.device, use);
  const { fence, outputPaths } = prepareRecordingStart(params, session);
  const started = await runtime.operations.screenRecordingStart(
    screenRecordingStartInput(params, session, prepared, fence, outputPaths.outputPath),
  );
  await adoptStartedScreenRecording({
    admissionLedger: params.admissionLedger,
    session,
    sessionName: params.sessionName,
    sessionStore: params.sessionStore,
    device: session.device,
    owner: runtime.owner,
    fence,
    ...started,
    throwIfCanceled: params.throwIfCanceled,
  });
  const adopted = params.sessionStore.get(params.sessionName)?.screenRecording;
  if (!adopted) throw new TypeError('Screen recording adoption did not publish a live handle');
  const snapshot = adopted.handle.inspect();
  recordSessionAction(
    params.sessionStore,
    session,
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
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    params.sessionStore.resolveSessionDir(params.sessionName),
  );
  return {
    fence: screenRecordingDurableResource.createNextFence({
      admissionLedger: params.admissionLedger,
      resourcePath,
      device: session.device,
    }),
    outputPaths: resolveRecordingOutputPaths({
      requestedPath: params.req.positionals?.[1],
      platform: session.device.platform,
      cwd: params.req.meta?.cwd,
    }),
  };
}

function screenRecordingStartInput(
  params: RecordRuntimeHandlerParams,
  session: SessionState,
  prepared: ReturnType<typeof prepareRecordingRequest>,
  fence: ScreenRecordingStartInput['fence'],
  outputPath: string,
): ScreenRecordingStartInput {
  return {
    sessionId: params.sessionName,
    outputPath,
    clientOutputPath: params.req.meta?.clientArtifactPaths?.outPath,
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
  kind: 'stop-live' | 'stop-recovery',
): Promise<DaemonResponse> {
  let completion;
  try {
    completion =
      kind === 'stop-live'
        ? await finishLiveScreenRecording({
            session,
            sessionName: params.sessionName,
            sessionStore: params.sessionStore,
          })
        : await finishRecovered(params, session);
  } catch (error) {
    deleteTerminalRecordOnlySession(params, session);
    throw error;
  }
  const response = buildRecordingStopResponse(completion);
  recordSessionAction(params.sessionStore, session, params.req, params.req.command, {
    action: 'stop',
    outPath: completion.outPath,
    ...(completion.clientOutPath
      ? { requestedFileName: path.basename(completion.clientOutPath) }
      : {}),
    showTouches: completion.showTouches,
  });
  if (session.recordOnlySession) params.sessionStore.delete(params.sessionName);
  return response;
}

function deleteTerminalRecordOnlySession(
  params: Pick<RecordRuntimeHandlerParams, 'sessionName' | 'sessionStore'>,
  session: SessionState,
): void {
  if (!session.recordOnlySession) return;
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    params.sessionStore.resolveSessionDir(params.sessionName),
  );
  const record = screenRecordingDurableResource.store.read(resourcePath);
  if (record.status === 'decoded' && record.envelope.lifecycle === 'completed') {
    params.sessionStore.delete(params.sessionName);
  }
}

async function finishRecovered(params: RecordRuntimeHandlerParams, session: SessionState) {
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    params.sessionStore.resolveSessionDir(params.sessionName),
  );
  const record = screenRecordingDurableResource.store.read(resourcePath);
  if (record.status !== 'decoded' || record.envelope.lifecycle !== 'open') {
    throw new AppError('INVALID_ARGS', 'no active recording');
  }
  if (record.envelope.sessionId !== params.sessionName) {
    throw new AppError(
      'COMMAND_FAILED',
      'Screen recording recovery record does not belong to the requested session',
      { reason: 'runtime-contract-invalid' },
    );
  }
  if (!sameDeviceIdentity(record.envelope.device, deviceIdentity(session.device))) {
    throw new AppError(
      'COMMAND_FAILED',
      'Screen recording recovery device does not match the selected device',
      { reason: 'runtime-contract-invalid' },
    );
  }
  return await finishRecoveredScreenRecording({
    resourcePath,
    scope: params.requestScope,
    acquireControl: async (envelope, recoveryScope) => {
      const runtime = await params.bindExactDevice(
        session.device,
        envelope.owner,
        envelope.fence,
        screenRecordingRecoveryUse,
        recoveryScope,
      );
      return createScreenRecordingRecoveryControl({ runtime, dispose: async () => {} });
    },
  });
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
