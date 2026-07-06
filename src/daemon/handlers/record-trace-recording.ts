import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../../utils/timeouts.ts';
import { resolveTargetDevice } from '../../core/dispatch.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonArtifact, DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { runCmd } from '../../utils/exec.ts';
import { isPlayableVideo, waitForStableFile } from '../../utils/video.ts';
import { deriveRecordingTelemetryPath } from '../recording-telemetry.ts';
import { runAppleRunnerCommand } from '../../platforms/apple/core/runner/runner-client.ts';
import { runXcrun } from '../../platforms/apple/core/tool-provider.ts';
import {
  overlayRecordingTouches,
  resizeRecording,
  trimRecordingStart,
} from '../../recording/overlay.ts';
import {
  DEFAULT_RECORDING_EXPORT_QUALITY,
  RECORDING_EXPORT_QUALITIES,
  recordingQualityInputToExportQuality,
} from '../../core/recording-export-quality.ts';
import { resolveRecordingProvider } from '../recording-provider.ts';
import { errorResponse, requireCommandSupported } from './response.ts';
import { recordSessionAction } from './handler-utils.ts';
import { deriveAndroidChunkOutPath } from './record-trace-android-chunks.ts';
import {
  resolveRecordingBackendForDevice,
  stopActiveRecording,
} from './record-trace-recording-backends.ts';
import type { RecordTraceDeps, RecordingBase } from './record-trace-types.ts';
import { resolveImplicitSessionScope, resolvePublicSessionName } from '../session-routing.ts';

const IOS_DEVICE_RECORD_MIN_FPS = 1;
const IOS_DEVICE_RECORD_MAX_FPS = 120;
const IOS_SIMULATOR_RECORDING_TAIL_SETTLE_MS = 350;

export type { RecordTraceDeps, RecordingBase } from './record-trace-types.ts';

type StartRecordingParams = {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
};

type StopRecordingParams = {
  req: DaemonRequest;
  sessionStore: SessionStore;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
};

type PreparedRecordingStart = {
  outPath: string;
  resolvedOut: string;
  recordingBase: RecordingBase;
};
type RecordingQualityInput = Parameters<typeof recordingQualityInputToExportQuality>[0];
type RecordingStartBackend = ReturnType<typeof resolveRecordingBackendForDevice>;
type RecordingStartPlan = PreparedRecordingStart & {
  backend: RecordingStartBackend;
  fpsFlag: number | undefined;
};

function buildRecordTraceDeps(): RecordTraceDeps {
  return {
    runCmd: async (cmd, args, options) =>
      cmd === 'xcrun' ? await runXcrun(args, options) : await runCmd(cmd, args, options),
    startIosSimulatorRecording: (request) =>
      resolveRecordingProvider().startIosSimulatorRecording(request),
    runAppleRunnerCommand,
    waitForRecordingTail,
    waitForStableFile,
    isPlayableVideo,
    trimRecordingStart,
    resizeRecording,
    overlayRecordingTouches,
  };
}

async function waitForRecordingTail(
  recording: RecordingBase & { platform: 'ios' | 'android' },
): Promise<void> {
  if (recording.platform !== 'ios') return;
  if (recording.gestureEvents.length === 0) return;
  await sleep(IOS_SIMULATOR_RECORDING_TAIL_SETTLE_MS);
}

function buildRecordingBase(req: DaemonRequest, outPath: string): RecordingBase {
  const exportQuality = recordingQualityInputToExportQuality(req.flags?.quality);
  return {
    outPath,
    clientOutPath: req.meta?.clientArtifactPaths?.outPath,
    startedAt: Date.now(),
    maxSize: req.flags?.screenshotMaxSize,
    exportQuality: exportQuality ?? DEFAULT_RECORDING_EXPORT_QUALITY,
    showTouches: req.flags?.hideTouches !== true,
    gestureEvents: [],
  };
}

// --- Start recording orchestrator ---

async function startRecording(params: StartRecordingParams): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore, activeSession, device, logPath, deps } = params;
  const startPlan = resolveRecordingStartPlan(params);
  if (!('backend' in startPlan)) return startPlan;

  const recording = await startPlan.backend.start({
    req,
    activeSession,
    sessionStore,
    device,
    logPath,
    deps,
    fpsFlag: startPlan.fpsFlag,
    recordingBase: startPlan.recordingBase,
    resolvedOut: startPlan.resolvedOut,
  });

  return persistStartedRecording({
    req,
    sessionName,
    sessionStore,
    activeSession,
    recording,
    outPath: startPlan.outPath,
  });
}

function resolveRecordingStartPlan(
  params: StartRecordingParams,
): DaemonResponse | RecordingStartPlan {
  const { req, activeSession, device } = params;
  const backend = resolveRecordingBackendForDevice(device);
  const startError = validateRecordingStartRequest({ req, activeSession, device, backend });
  if (startError) return startError;

  return {
    ...prepareRecordingStart(req, backend),
    backend,
    fpsFlag: req.flags?.fps,
  };
}

function validateRecordingStartRequest(params: {
  req: DaemonRequest;
  activeSession: SessionState;
  device: SessionState['device'];
  backend: RecordingStartBackend;
}): DaemonResponse | null {
  const { req, activeSession, device, backend } = params;
  const validators = [
    () => validateNoActiveRecording(activeSession),
    () => backend.validateStart?.(req) ?? null,
    () =>
      validateRecordingStartFlags({
        fpsFlag: req.flags?.fps,
        qualityFlag: req.flags?.quality,
        maxSizeFlag: req.flags?.screenshotMaxSize,
      }),
    () => requireCommandSupported('record', device),
  ];
  for (const validate of validators) {
    const error = validate();
    if (error) return error;
  }
  return null;
}

function persistStartedRecording(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  activeSession: SessionState;
  recording: Awaited<ReturnType<RecordingStartBackend['start']>>;
  outPath: string;
}): DaemonResponse {
  const { req, sessionName, sessionStore, activeSession, recording, outPath } = params;
  if ('ok' in recording) {
    return recording;
  }

  activeSession.recording = recording;
  sessionStore.set(sessionName, activeSession);
  const sessionStateDir = sessionStore.ensureSessionDir(sessionName);
  recordSessionAction(sessionStore, activeSession, req, req.command, {
    action: 'start',
    showTouches: recording.showTouches,
  });

  return {
    ok: true,
    data: {
      recording: 'started',
      outPath: recording.clientOutPath ?? outPath,
      sessionStateDir,
      showTouches: recording.showTouches,
    },
  };
}

function validateNoActiveRecording(activeSession: SessionState): DaemonResponse | null {
  return activeSession.recording
    ? errorResponse('INVALID_ARGS', 'recording already in progress')
    : null;
}

function validateRecordingStartFlags(flags: {
  fpsFlag: number | undefined;
  qualityFlag: RecordingQualityInput;
  maxSizeFlag: number | undefined;
}): DaemonResponse | null {
  const { fpsFlag, qualityFlag, maxSizeFlag } = flags;
  return (
    validateRecordingFpsFlag(fpsFlag) ??
    validateRecordingQualityFlag(qualityFlag) ??
    validateRecordingMaxSizeFlag(maxSizeFlag)
  );
}

function validateRecordingFpsFlag(fpsFlag: number | undefined): DaemonResponse | null {
  if (
    fpsFlag !== undefined &&
    (!Number.isInteger(fpsFlag) ||
      fpsFlag < IOS_DEVICE_RECORD_MIN_FPS ||
      fpsFlag > IOS_DEVICE_RECORD_MAX_FPS)
  ) {
    return errorResponse(
      'INVALID_ARGS',
      `fps must be an integer between ${IOS_DEVICE_RECORD_MIN_FPS} and ${IOS_DEVICE_RECORD_MAX_FPS}`,
    );
  }
  return null;
}

function validateRecordingQualityFlag(qualityFlag: RecordingQualityInput): DaemonResponse | null {
  if (
    qualityFlag !== undefined &&
    recordingQualityInputToExportQuality(qualityFlag) === undefined
  ) {
    return errorResponse(
      'INVALID_ARGS',
      `quality must be one of: ${RECORDING_EXPORT_QUALITIES.join(', ')} (legacy numeric values 5-10 are accepted)`,
    );
  }
  return null;
}

function validateRecordingMaxSizeFlag(maxSizeFlag: number | undefined): DaemonResponse | null {
  if (maxSizeFlag !== undefined && (!Number.isInteger(maxSizeFlag) || maxSizeFlag < 1)) {
    return errorResponse('INVALID_ARGS', 'max-size must be a positive integer');
  }
  return null;
}

function prepareRecordingStart(
  req: DaemonRequest,
  backend: ReturnType<typeof resolveRecordingBackendForDevice>,
): PreparedRecordingStart {
  const outPath = backend.resolveOutputPath({ req });
  const resolvedOut = SessionStore.expandHome(outPath, req.meta?.cwd);
  const recordingBase = buildRecordingBase(req, resolvedOut);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.rmSync(resolvedOut, { force: true });
  return { outPath, resolvedOut, recordingBase };
}

async function stopRecording(params: StopRecordingParams): Promise<DaemonResponse> {
  const { req, activeSession, device, logPath, deps } = params;

  const recording = await resolveRecordingToStop(params);
  if (recording && 'ok' in recording) return recording;
  if (!recording) {
    return errorResponse('INVALID_ARGS', 'no active recording');
  }

  const stopRequestedAt = Date.now();
  const invalidatedReason = recording.invalidatedReason;
  activeSession.recording = undefined;
  const stopError = await stopActiveRecording({
    req,
    activeSession,
    device,
    logPath,
    deps,
    recording,
    stopRequestedAt,
  });
  if (stopError) {
    return stopError;
  }

  const invalidatedError = applyRecordingInvalidation(recording, invalidatedReason);
  if (invalidatedError) return invalidatedError;

  return buildRecordStopResponse(recording);
}

async function resolveRecordingToStop(
  params: StopRecordingParams,
): Promise<DaemonResponse | NonNullable<SessionState['recording']> | null> {
  if (params.activeSession.recording) {
    return params.activeSession.recording;
  }
  return await recoverMissingRecordingState(params);
}

async function recoverMissingRecordingState(
  params: StopRecordingParams,
): Promise<DaemonResponse | NonNullable<SessionState['recording']> | null> {
  const { req, sessionStore, activeSession, device, logPath, deps } = params;
  if (hasActiveRecordingSessionForDevice(sessionStore, device.id)) {
    return null;
  }

  const backend = resolveRecordingBackendForDevice(device);
  if (!backend.recoverMissingStop) {
    return null;
  }

  const { resolvedOut, recordingBase } = prepareRecoveredRecording(req, backend);
  const recovered = await backend.recoverMissingStop({
    req,
    activeSession,
    sessionStore,
    device,
    logPath,
    deps,
    recordingBase,
    resolvedOut,
  });
  if (!recovered) {
    return null;
  }
  if (!('ok' in recovered)) {
    resetRecoveredRecordingOutput(resolvedOut);
  }
  return recovered;
}

function prepareRecoveredRecording(
  req: DaemonRequest,
  backend: ReturnType<typeof resolveRecordingBackendForDevice>,
): Pick<PreparedRecordingStart, 'resolvedOut' | 'recordingBase'> {
  const outPath = backend.resolveOutputPath({ req });
  const resolvedOut = SessionStore.expandHome(outPath, req.meta?.cwd);
  const recordingBase = buildRecordingBase(req, resolvedOut);
  return { resolvedOut, recordingBase };
}

function resetRecoveredRecordingOutput(resolvedOut: string): void {
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.rmSync(resolvedOut, { force: true });
}

function applyRecordingInvalidation(
  recording: NonNullable<SessionState['recording']>,
  invalidatedReason: string | undefined,
): DaemonResponse | null {
  if (!invalidatedReason) {
    return null;
  }
  if (recording.platform === 'ios' && recording.showTouches) {
    recording.overlayWarning ??= `overlay unavailable: ${invalidatedReason}`;
    return null;
  }
  return errorResponse('COMMAND_FAILED', invalidatedReason);
}

function hasActiveRecordingSessionForDevice(sessionStore: SessionStore, deviceId: string): boolean {
  for (const session of sessionStore.values()) {
    if (session.recording && session.device.id === deviceId) {
      return true;
    }
  }
  return false;
}

function buildRecordStopResponse(
  recording: NonNullable<SessionState['recording']>,
): DaemonResponse {
  const chunks = recording.platform === 'android' ? recording.chunks : undefined;
  const artifacts: DaemonArtifact[] = [
    {
      field: 'outPath',
      artifactType: 'screen-recording',
      path: recording.outPath,
      localPath: recording.clientOutPath,
      fileName: path.basename(recording.clientOutPath ?? recording.outPath),
    },
  ];
  if (chunks && chunks.length > 1) {
    artifacts.push(
      ...chunks.slice(1).map((chunk) => ({
        field: 'chunkPath',
        artifactType: 'screen-recording-chunk' as const,
        path: chunk.path,
        localPath: deriveAndroidChunkClientPath(recording, chunk.index),
        fileName: path.basename(deriveAndroidChunkClientPath(recording, chunk.index) ?? chunk.path),
      })),
    );
  }
  if (recording.telemetryPath) {
    artifacts.push({
      field: 'telemetryPath',
      artifactType: 'screen-recording-telemetry',
      path: recording.telemetryPath,
      localPath: deriveClientTelemetryPath(recording),
      fileName: path.basename(recording.telemetryPath),
    });
  }

  return {
    ok: true,
    data: {
      recording: 'stopped',
      outPath: recording.outPath,
      telemetryPath: recording.telemetryPath,
      artifacts,
      showTouches: recording.showTouches,
      warning: recording.warning,
      overlayWarning: recording.overlayWarning,
      chunks: chunks?.map((chunk) => ({
        index: chunk.index,
        path: deriveAndroidChunkClientPath(recording, chunk.index) ?? chunk.path,
      })),
    },
  };
}

function deriveAndroidChunkClientPath(
  recording: NonNullable<SessionState['recording']>,
  chunkIndex: number,
): string | undefined {
  if (recording.platform !== 'android' || !recording.clientOutPath) {
    return undefined;
  }
  return deriveAndroidChunkOutPath(recording.clientOutPath, chunkIndex);
}

function deriveClientTelemetryPath(
  recording: NonNullable<SessionState['recording']>,
): string | undefined {
  if (!recording.clientOutPath) {
    return undefined;
  }
  return deriveRecordingTelemetryPath(recording.clientOutPath);
}

async function releaseRecordOnlySession(
  sessionStore: SessionStore,
  sessionName: string,
  session: SessionState,
  options: { writeLog?: boolean } = {},
): Promise<void> {
  if (!session.recordOnlySession) {
    return;
  }
  const backend = resolveRecordingBackendForDevice(session.device);
  await backend.cleanupRecordOnlySession?.(session);
  if (options.writeLog) {
    sessionStore.writeSessionLog(session);
  }
  sessionStore.delete(sessionName);
}

// --- Main command handler ---

export async function handleRecordCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath?: string;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore, logPath } = params;
  const deps = buildRecordTraceDeps();
  const session = sessionStore.get(sessionName);
  const device = session?.device ?? (await resolveTargetDevice(req.flags ?? {}));
  if (!session) {
    await ensureDeviceReady(device);
  }

  const activeSession =
    session ??
    ({
      name: resolvePublicSessionName(req),
      sessionScope: resolveImplicitSessionScope(req),
      device,
      createdAt: Date.now(),
      recordOnlySession: true,
      actions: [],
    } satisfies SessionState);

  const action = (req.positionals?.[0] ?? '').toLowerCase();
  if (!['start', 'stop'].includes(action)) {
    return errorResponse('INVALID_ARGS', 'record requires start|stop');
  }

  if (action === 'start') {
    return startRecording({ req, sessionName, sessionStore, activeSession, device, logPath, deps });
  }

  const response = await stopRecording({ req, sessionStore, activeSession, device, logPath, deps });
  if (!response.ok) {
    await releaseRecordOnlySession(sessionStore, sessionName, activeSession);
    return response;
  }

  recordSessionAction(sessionStore, activeSession, req, req.command, {
    action: 'stop',
    outPath: response.data?.outPath,
    showTouches: response.data?.showTouches,
  });
  await releaseRecordOnlySession(sessionStore, sessionName, activeSession, { writeLog: true });
  return response;
}
