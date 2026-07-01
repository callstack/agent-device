import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { IOS_RUNNER_CONTAINER_BUNDLE_IDS } from '../../platforms/apple/core/runner/runner-client.ts';
import { formatRecordTraceError } from '../record-trace-errors.ts';
import { buildAppleRunnerRequestOptions } from '../apple-runner-options.ts';
import type { RecordTraceDeps, RecordingBase } from './record-trace-types.ts';
import { finalizeRecordingOverlay } from './record-trace-finalize.ts';
import { errorResponse } from './response.ts';

export function normalizeAppBundleId(session: SessionState): string | undefined {
  const trimmed = session.appBundleId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isRunnerRecordingAlreadyInProgressError(error: unknown): boolean {
  return formatRecordTraceError(error).toLowerCase().includes('recording already in progress');
}

function findOtherActiveIosRunnerRecording(
  sessionStore: SessionStore,
  deviceId: string,
  currentSessionName: string,
): SessionState | undefined {
  return sessionStore
    .toArray()
    .find(
      (session) =>
        session.name !== currentSessionName &&
        session.device.platform === 'ios' &&
        session.device.kind === 'device' &&
        session.device.id === deviceId &&
        session.recording?.platform === 'ios-device-runner',
    );
}

export function getIosRunnerOptions(
  req: DaemonRequest,
  logPath: string | undefined,
  session: SessionState,
) {
  return buildAppleRunnerRequestOptions({
    req,
    logPath,
    traceLogPath: session.trace?.outPath,
  });
}

function resolveIosRecordingTrimStartMs(
  recording: Extract<NonNullable<SessionState['recording']>, { platform: 'ios-device-runner' }>,
): number {
  if (
    typeof recording.runnerStartedAtUptimeMs !== 'number' ||
    typeof recording.targetAppReadyUptimeMs !== 'number'
  ) {
    return 0;
  }
  return Math.max(0, recording.targetAppReadyUptimeMs - recording.runnerStartedAtUptimeMs);
}

async function stopRunnerRecordingBestEffort(params: {
  req: DaemonRequest;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
}): Promise<void> {
  const { req, activeSession, device, logPath, deps } = params;
  const appBundleId = normalizeAppBundleId(activeSession);

  try {
    await deps.runAppleRunnerCommand(
      device,
      { command: 'recordStop', appBundleId },
      getIosRunnerOptions(req, logPath, activeSession),
    );
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'record_stop_runner_failed',
      data: {
        platform: device.platform,
        kind: device.kind,
        deviceId: device.id,
        session: activeSession.name,
        error: formatRecordTraceError(error),
      },
    });
  }
}

type RunnerGestureClockAnchor = {
  gestureClockOriginAtMs: number;
  gestureClockOriginUptimeMs: number;
};

export async function warmIosSimulatorRunner(params: {
  req: DaemonRequest;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
}): Promise<RunnerGestureClockAnchor | undefined> {
  const { req, activeSession, device, logPath, deps } = params;
  const appBundleId = normalizeAppBundleId(activeSession);
  if (!appBundleId) return undefined;

  try {
    const result = await deps.runAppleRunnerCommand(
      device,
      {
        command: 'snapshot',
        appBundleId,
        interactiveOnly: true,
        depth: 1,
      },
      getIosRunnerOptions(req, logPath, activeSession),
    );
    // Pair the runner-stamped uptime with daemon receipt time. The runner stamps
    // currentUptimeMs just before sending the response, so receive time is the closest
    // wall-clock pair; the request midpoint would be wrong because this warm request can
    // include cold runner build/launch (10s+).
    const receivedAtMs = Date.now();
    if (
      typeof result.currentUptimeMs === 'number' &&
      Number.isFinite(result.currentUptimeMs) &&
      result.currentUptimeMs > 0
    ) {
      emitDiagnostic({
        level: 'debug',
        phase: 'record_start_gesture_clock_anchor',
        data: { source: 'warm_snapshot' },
      });
      return {
        gestureClockOriginAtMs: receivedAtMs,
        gestureClockOriginUptimeMs: result.currentUptimeMs,
      };
    }
    return undefined;
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'record_start_simulator_runner_warm_failed',
      data: {
        deviceId: device.id,
        session: activeSession.name,
        appBundleId,
        error: formatRecordTraceError(error),
      },
    });
    return undefined;
  }
}

export async function startIosDeviceRecording(params: {
  req: DaemonRequest;
  activeSession: SessionState;
  sessionStore: SessionStore;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
  fpsFlag: number | undefined;
  recordingBase: RecordingBase;
  appBundleId: string;
}): Promise<DaemonResponse | NonNullable<SessionState['recording']>> {
  const {
    req,
    activeSession,
    sessionStore,
    device,
    logPath,
    deps,
    fpsFlag,
    recordingBase,
    appBundleId,
  } = params;
  const recordingFileName = `agent-device-recording-${Date.now()}.mp4`;
  const remotePath = `tmp/${recordingFileName}`;
  const runnerOptions = getIosRunnerOptions(req, logPath, activeSession);
  let runnerStartedAtUptimeMs: number | undefined;
  let targetAppReadyUptimeMs: number | undefined;
  const startRunnerRecording = async () =>
    deps.runAppleRunnerCommand(
      device,
      {
        command: 'recordStart',
        outPath: recordingFileName,
        fps: fpsFlag,
        maxSize: recordingBase.maxSize,
        appBundleId,
      },
      runnerOptions,
    );

  try {
    const startResult = await startRunnerRecording();
    runnerStartedAtUptimeMs =
      typeof startResult.recorderStartUptimeMs === 'number'
        ? startResult.recorderStartUptimeMs
        : undefined;
    targetAppReadyUptimeMs =
      typeof startResult.targetAppReadyUptimeMs === 'number'
        ? startResult.targetAppReadyUptimeMs
        : undefined;
  } catch (error) {
    if (!isRunnerRecordingAlreadyInProgressError(error)) {
      return errorResponse(
        'COMMAND_FAILED',
        `failed to start recording: ${formatRecordTraceError(error)}`,
      );
    }

    emitDiagnostic({
      level: 'warn',
      phase: 'record_start_runner_desynced',
      data: {
        platform: device.platform,
        kind: device.kind,
        deviceId: device.id,
        session: activeSession.name,
        error: formatRecordTraceError(error),
      },
    });

    const otherRecordingSession = findOtherActiveIosRunnerRecording(
      sessionStore,
      device.id,
      activeSession.name,
    );
    if (otherRecordingSession) {
      return errorResponse(
        'COMMAND_FAILED',
        `failed to start recording: recording already in progress in session '${otherRecordingSession.name}'`,
      );
    }

    try {
      await deps.runAppleRunnerCommand(
        device,
        { command: 'recordStop', appBundleId },
        runnerOptions,
      );
    } catch {
      // best effort: stop stale runner recording and retry start
    }

    try {
      const startResult = await startRunnerRecording();
      runnerStartedAtUptimeMs =
        typeof startResult.recorderStartUptimeMs === 'number'
          ? startResult.recorderStartUptimeMs
          : undefined;
      targetAppReadyUptimeMs =
        typeof startResult.targetAppReadyUptimeMs === 'number'
          ? startResult.targetAppReadyUptimeMs
          : undefined;
    } catch (retryError) {
      return errorResponse(
        'COMMAND_FAILED',
        `failed to start recording: ${formatRecordTraceError(retryError)}`,
      );
    }
  }

  return {
    platform: 'ios-device-runner',
    remotePath,
    runnerStartedAtUptimeMs,
    targetAppReadyUptimeMs,
    ...recordingBase,
  };
}

export async function startMacOsRecording(params: {
  req: DaemonRequest;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
  fpsFlag: number | undefined;
  recordingBase: RecordingBase;
  appBundleId: string;
}): Promise<DaemonResponse | NonNullable<SessionState['recording']>> {
  const { req, activeSession, device, logPath, deps, fpsFlag, recordingBase, appBundleId } = params;

  try {
    await deps.runAppleRunnerCommand(
      device,
      {
        command: 'recordStart',
        outPath: recordingBase.outPath,
        fps: fpsFlag,
        maxSize: recordingBase.maxSize,
        appBundleId,
      },
      getIosRunnerOptions(req, logPath, activeSession),
    );
  } catch (error) {
    return errorResponse(
      'COMMAND_FAILED',
      `failed to start recording: ${formatRecordTraceError(error)}`,
    );
  }

  return {
    platform: 'macos-runner',
    ...recordingBase,
  };
}

export async function stopIosDeviceRecording(params: {
  req: DaemonRequest;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
  recording: Extract<NonNullable<SessionState['recording']>, { platform: 'ios-device-runner' }>;
}): Promise<DaemonResponse | null> {
  const { req, activeSession, device, logPath, deps, recording } = params;
  await stopRunnerRecordingBestEffort({ req, activeSession, device, logPath, deps });

  let copyResult = { stdout: '', stderr: '', exitCode: 1 };
  for (const bundleId of IOS_RUNNER_CONTAINER_BUNDLE_IDS) {
    copyResult = await deps.runCmd(
      'xcrun',
      [
        'devicectl',
        'device',
        'copy',
        'from',
        '--device',
        device.id,
        '--source',
        recording.remotePath,
        '--destination',
        recording.outPath,
        '--domain-type',
        'appDataContainer',
        '--domain-identifier',
        bundleId,
      ],
      { allowFailure: true },
    );
    if (copyResult.exitCode === 0) {
      break;
    }
  }

  if (copyResult.exitCode !== 0) {
    const copyError =
      copyResult.stderr.trim() ||
      copyResult.stdout.trim() ||
      `devicectl exited with code ${copyResult.exitCode}`;
    return errorResponse('COMMAND_FAILED', `failed to copy recording from device: ${copyError}`);
  }

  const trimStartMs = resolveIosRecordingTrimStartMs(recording);
  if (trimStartMs > 0) {
    await deps.trimRecordingStart({
      videoPath: recording.outPath,
      trimStartMs,
    });
  }

  await finalizeRecordingOverlay({
    recording,
    deps,
    trimStartMs,
    targetLabel: 'iOS recording',
  });

  return null;
}

export async function stopMacOsRecording(params: {
  req: DaemonRequest;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
  recording: Extract<NonNullable<SessionState['recording']>, { platform: 'macos-runner' }>;
}): Promise<DaemonResponse | null> {
  const { req, activeSession, device, logPath, deps, recording } = params;
  await stopRunnerRecordingBestEffort({ req, activeSession, device, logPath, deps });

  await finalizeRecordingOverlay({
    recording,
    deps,
    targetLabel: 'macOS recording',
  });

  return null;
}
