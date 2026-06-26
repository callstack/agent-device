import fs from 'node:fs';
import { withDiagnosticTimer } from '../../utils/diagnostics.ts';
import { sleep } from '../../utils/timeouts.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import {
  buildRecordStopFailure,
  formatRecordTraceError,
  formatRecordTraceExecFailure,
} from '../record-trace-errors.ts';
import { finalizeRecordingOverlay } from './record-trace-finalize.ts';
import {
  getIosRunnerOptions,
  normalizeAppBundleId,
  warmIosSimulatorRunner,
} from './record-trace-ios.ts';
import {
  IOS_SIMULATOR_RECORDING_STOP_TIMEOUT_MS,
  stopIosSimulatorRecordingProcess,
} from './record-trace-ios-simulator.ts';
import type { RecordTraceDeps, RecordingBase } from './record-trace-types.ts';
import { errorResponse } from './response.ts';

const LOCAL_RECORDING_READY_POLL_MS = 250;
const LOCAL_RECORDING_READY_SETTLE_POLLS = 2;
const IOS_SIMULATOR_VIDEO_READY_POLL_MS = 150;
const IOS_SIMULATOR_VIDEO_READY_ATTEMPTS = 12;

type ActiveRecording = NonNullable<SessionState['recording']>;
type IosSimulatorRecording = Extract<ActiveRecording, { platform: 'ios' }>;

export async function startIosSimulatorRecording(params: {
  req: DaemonRequest;
  activeSession: SessionState;
  device: SessionState['device'];
  logPath?: string;
  deps: RecordTraceDeps;
  recordingBase: RecordingBase;
  resolvedOut: string;
}): Promise<DaemonResponse | ActiveRecording> {
  const { req, activeSession, device, logPath, deps, recordingBase, resolvedOut } = params;

  // The warm-up carries the gesture-clock anchor on its snapshot response when the runner
  // stamps it, letting us skip a standalone uptime command. The anchor is a pure clock pair
  // (origin uptime + daemon receipt time), so capturing it before the recorder spawn/settle
  // window is equivalent to capturing it after: recordingStartedAt stays readyAt below.
  const warmAnchor = recordingBase.showTouches
    ? await warmIosSimulatorRunner({ req, activeSession, device, logPath, deps })
    : undefined;
  const { child, wait } = deps.startIosSimulatorRecording({ device, outPath: resolvedOut });
  const readyAt = await waitForLocalRecordingSettleWindow(resolvedOut);
  let gestureClockOriginAtMs: number | undefined;
  let gestureClockOriginUptimeMs: number | undefined;
  if (warmAnchor) {
    gestureClockOriginAtMs = warmAnchor.gestureClockOriginAtMs;
    gestureClockOriginUptimeMs = warmAnchor.gestureClockOriginUptimeMs;
  } else if (recordingBase.showTouches) {
    // Fallback for older runner builds (or a failed/unavailable warm anchor): issue a
    // standalone uptime command and pair it at the request midpoint.
    try {
      const uptimeRequestStartedAtMs = Date.now();
      const uptimeResult = await deps.runIosRunnerCommand(
        device,
        {
          command: 'uptime',
          appBundleId: normalizeAppBundleId(activeSession),
        },
        getIosRunnerOptions(req, logPath, activeSession),
      );
      const uptimeRequestFinishedAtMs = Date.now();
      gestureClockOriginAtMs = Math.round(
        (uptimeRequestStartedAtMs + uptimeRequestFinishedAtMs) / 2,
      );
      gestureClockOriginUptimeMs =
        typeof uptimeResult.currentUptimeMs === 'number' ? uptimeResult.currentUptimeMs : undefined;
    } catch {
      // Best effort only; wall-clock fallback remains available.
    }
  }
  return {
    platform: 'ios',
    child,
    wait,
    ...recordingBase,
    recorderPid: child.pid,
    startedAt: readyAt,
    gestureClockOriginAtMs:
      gestureClockOriginUptimeMs === undefined ? undefined : gestureClockOriginAtMs,
    gestureClockOriginUptimeMs,
  };
}

export async function stopIosSimulatorRecording(params: {
  deps: RecordTraceDeps;
  recording: IosSimulatorRecording;
  stopRequestedAt: number;
}): Promise<DaemonResponse | null> {
  const { deps, recording, stopRequestedAt } = params;

  await withDiagnosticTimer('record_stop_tail_settle', () => deps.waitForRecordingTail(recording), {
    platform: recording.platform,
    gestureEventCount: recording.gestureEvents.length,
  });
  const stopResult = await withDiagnosticTimer(
    'record_stop_ios_simulator_process',
    () => stopIosSimulatorRecordingProcess({ deps, recording }),
    {
      outPath: recording.outPath,
    },
  );
  if (!stopResult) {
    return buildIosSimulatorRecordingStopFailure(
      `failed to stop recording: simctl recordVideo did not exit after ${IOS_SIMULATOR_RECORDING_STOP_TIMEOUT_MS}ms and forced cleanup`,
      recording,
      stopRequestedAt,
    );
  }
  if (stopResult.exitCode !== 0) {
    return buildIosSimulatorRecordingStopFailure(
      `failed to stop recording: ${formatRecordTraceExecFailure(stopResult, 'simctl recordVideo')}`,
      recording,
      stopRequestedAt,
    );
  }

  await withDiagnosticTimer(
    'record_stop_video_stable',
    () =>
      deps.waitForStableFile(recording.outPath, {
        pollMs: IOS_SIMULATOR_VIDEO_READY_POLL_MS,
        attempts: IOS_SIMULATOR_VIDEO_READY_ATTEMPTS,
      }),
    {
      outPath: recording.outPath,
    },
  );
  const playable = await withDiagnosticTimer(
    'record_stop_video_playable_check',
    () => deps.isPlayableVideo(recording.outPath),
    {
      outPath: recording.outPath,
    },
  );
  if (!playable) {
    return buildIosSimulatorRecordingStopFailure(
      `failed to stop recording: ${recording.outPath} was not finalized into a playable video`,
      recording,
      stopRequestedAt,
    );
  }

  if (recording.maxSize !== undefined) {
    try {
      await withDiagnosticTimer(
        'record_stop_resize',
        () =>
          deps.resizeRecording({
            videoPath: recording.outPath,
            maxSize: recording.maxSize!,
            exportQuality: recording.exportQuality,
            targetLabel: 'iOS recording',
          }),
        {
          outPath: recording.outPath,
          maxSize: recording.maxSize,
        },
      );
    } catch (error) {
      recording.overlayWarning = `failed to resize recording: ${formatRecordTraceError(error)}`;
    }
  }

  await withDiagnosticTimer(
    'record_stop_finalize_overlay',
    () =>
      finalizeRecordingOverlay({
        recording,
        deps,
        targetLabel: 'iOS recording',
      }),
    {
      outPath: recording.outPath,
      showTouches: recording.showTouches,
      gestureEventCount: recording.gestureEvents.length,
    },
  );

  return null;
}

async function waitForLocalRecordingSettleWindow(outPath: string): Promise<number> {
  // simctl recordVideo can take a beat to open its output even though recording has already
  // started. This is a short settle window, not a strict readiness guarantee. We prefer a
  // close recorder anchor over blocking start indefinitely waiting for non-zero bytes.
  for (let attempt = 0; attempt < LOCAL_RECORDING_READY_SETTLE_POLLS; attempt += 1) {
    try {
      const stat = fs.statSync(outPath);
      if (stat.size > 0) {
        return Date.now();
      }
    } catch {
      // Wait for the recorder to create the output file.
    }

    if (attempt + 1 >= LOCAL_RECORDING_READY_SETTLE_POLLS) {
      return Date.now();
    }

    await sleep(LOCAL_RECORDING_READY_POLL_MS);
  }

  return Date.now();
}

function buildIosSimulatorRecordingStopFailure(
  message: string,
  recording: IosSimulatorRecording,
  stopRequestedAt: number,
): DaemonResponse {
  const failure = buildRecordStopFailure(message, recording, stopRequestedAt);
  removeInvalidRecordingOutput(recording.outPath);
  return errorResponse('COMMAND_FAILED', failure.message);
}

function removeInvalidRecordingOutput(outPath: string): void {
  try {
    fs.rmSync(outPath, { force: true });
  } catch {
    // Best effort: the error response still reports the failed finalization.
  }
}
