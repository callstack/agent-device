import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../../utils/timeouts.ts';
import { resolveTargetDevice, type CommandFlags } from '../../core/dispatch.ts';
import { isCommandSupportedOnDevice } from '../../core/capabilities.ts';
import { ensureDeviceReady } from '../device-ready.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonArtifact, DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { runCmd } from '../../utils/exec.ts';
import { isPlayableVideo, waitForStableFile } from '../../utils/video.ts';
import { deriveRecordingTelemetryPath } from '../recording-telemetry.ts';
import { runIosRunnerCommand } from '../../platforms/ios/runner-client.ts';
import { runXcrun } from '../../platforms/ios/tool-provider.ts';
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
import { errorResponse } from './response.ts';
import { deriveAndroidChunkOutPath } from './record-trace-android-chunks.ts';
import {
  resolveRecordingBackendForDevice,
  resolveRecordingBackendForRecording,
} from './record-trace-recording-backends.ts';
import type { RecordTraceDeps, RecordingBase } from './record-trace-types.ts';
import { resolveImplicitSessionScope, resolvePublicSessionName } from '../session-routing.ts';

const IOS_DEVICE_RECORD_MIN_FPS = 1;
const IOS_DEVICE_RECORD_MAX_FPS = 120;
const IOS_SIMULATOR_RECORDING_TAIL_SETTLE_MS = 350;

export type { RecordTraceDeps, RecordingBase } from './record-trace-types.ts';

function buildRecordTraceDeps(): RecordTraceDeps {
  return {
    runCmd: async (cmd, args, options) =>
      cmd === 'xcrun' ? await runXcrun(args, options) : await runCmd(cmd, args, options),
    startIosSimulatorRecording: (request) =>
      resolveRecordingProvider().startIosSimulatorRecording(request),
    runIosRunnerCommand,
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

// fallow-ignore-next-line complexity
async function startRecording(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore, activeSession, device, logPath, deps } = params;

  if (activeSession.recording) {
    return errorResponse('INVALID_ARGS', 'recording already in progress');
  }

  const fpsFlag = req.flags?.fps;
  const qualityFlag = req.flags?.quality;
  const maxSizeFlag = req.flags?.screenshotMaxSize;
  const backend = resolveRecordingBackendForDevice(device);
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
  if (
    qualityFlag !== undefined &&
    recordingQualityInputToExportQuality(qualityFlag) === undefined
  ) {
    return errorResponse(
      'INVALID_ARGS',
      `quality must be one of: ${RECORDING_EXPORT_QUALITIES.join(', ')} (legacy numeric values 5-10 are accepted)`,
    );
  }
  if (maxSizeFlag !== undefined && (!Number.isInteger(maxSizeFlag) || maxSizeFlag < 1)) {
    return errorResponse('INVALID_ARGS', 'max-size must be a positive integer');
  }
  if (!isCommandSupportedOnDevice('record', device)) {
    return errorResponse('UNSUPPORTED_OPERATION', 'record is not supported on this device');
  }

  const outPath = backend.resolveOutputPath({ req });
  const resolvedOut = SessionStore.expandHome(outPath, req.meta?.cwd);
  const recordingBase = buildRecordingBase(req, resolvedOut);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.rmSync(resolvedOut, { force: true });

  const recording = await backend.start({
    req,
    activeSession,
    sessionStore,
    device,
    logPath,
    deps,
    fpsFlag,
    recordingBase,
    resolvedOut,
  });

  if ('ok' in recording) {
    return recording;
  }

  activeSession.recording = recording;
  sessionStore.set(sessionName, activeSession);
  const sessionStateDir = sessionStore.ensureSessionDir(sessionName);
  sessionStore.recordAction(activeSession, {
    command: req.command,
    positionals: req.positionals ?? [],
    flags: (req.flags ?? {}) as CommandFlags,
    result: { action: 'start', showTouches: recording.showTouches },
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

async function stopRecording(params: {
  req: DaemonRequest;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
}): Promise<DaemonResponse> {
  const { req, activeSession, device, logPath, deps } = params;

  if (!activeSession.recording) {
    return errorResponse('INVALID_ARGS', 'no active recording');
  }

  const recording = activeSession.recording;
  const stopRequestedAt = Date.now();
  const invalidatedReason = recording.invalidatedReason;
  activeSession.recording = undefined;
  const backend = resolveRecordingBackendForRecording(recording);

  const stopError = await backend.stop({
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

  if (invalidatedReason && recording.platform === 'ios' && recording.showTouches) {
    recording.overlayWarning ??= `overlay unavailable: ${invalidatedReason}`;
  } else if (invalidatedReason) {
    return errorResponse('COMMAND_FAILED', invalidatedReason);
  }

  return buildRecordStopResponse(recording);
}

function buildRecordStopResponse(
  recording: NonNullable<SessionState['recording']>,
): DaemonResponse {
  const chunks = recording.platform === 'android' ? recording.chunks : undefined;
  const artifacts: DaemonArtifact[] = [
    {
      field: 'outPath',
      path: recording.outPath,
      localPath: recording.clientOutPath,
      fileName: path.basename(recording.clientOutPath ?? recording.outPath),
    },
  ];
  if (chunks && chunks.length > 1) {
    artifacts.push(
      ...chunks.slice(1).map((chunk) => ({
        field: 'chunkPath',
        path: chunk.path,
        localPath: deriveAndroidChunkClientPath(recording, chunk.index),
        fileName: path.basename(deriveAndroidChunkClientPath(recording, chunk.index) ?? chunk.path),
      })),
    );
  }
  if (recording.telemetryPath) {
    artifacts.push({
      field: 'telemetryPath',
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

function releaseRecordOnlySession(
  sessionStore: SessionStore,
  sessionName: string,
  session: SessionState,
  options: { writeLog?: boolean } = {},
): void {
  if (!session.recordOnlySession) {
    return;
  }
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

  const response = await stopRecording({ req, activeSession, device, logPath, deps });
  if (!response.ok) {
    releaseRecordOnlySession(sessionStore, sessionName, activeSession);
    return response;
  }

  sessionStore.recordAction(activeSession, {
    command: req.command,
    positionals: req.positionals ?? [],
    flags: (req.flags ?? {}) as CommandFlags,
    result: {
      action: 'stop',
      outPath: response.data?.outPath,
      showTouches: response.data?.showTouches,
    },
  });
  releaseRecordOnlySession(sessionStore, sessionName, activeSession, { writeLog: true });
  return response;
}
