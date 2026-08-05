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
const LOCAL_RECORDING_LIVENESS_GRACE_MS = 50;
// CoreSimulator may delay creating the zero-byte recordVideo destination while
// a just-booted simulator finishes service startup. This is still much shorter
// than recording itself, but avoids reporting a false start under CI load.
const LOCAL_RECORDING_READY_TIMEOUT_MS = 15_000;
const IOS_SIMULATOR_VIDEO_READY_POLL_MS = 150;
const IOS_SIMULATOR_VIDEO_READY_ATTEMPTS = 12;

type ActiveRecording = NonNullable<SessionState['recording']>;
type IosSimulatorRecording = Extract<ActiveRecording, { platform: 'ios' }>;
type LocalRecordingReadiness =
  | { kind: 'ready'; readyAt: number }
  | { kind: 'exited'; result: Awaited<IosSimulatorRecording['wait']> }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timeout' };

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
  const readiness = await waitForLocalRecordingReadiness(resolvedOut, wait);
  if (readiness.kind !== 'ready') {
    if (readiness.kind === 'timeout' || readiness.kind === 'failed') {
      await stopIosSimulatorRecordingProcess({
        deps,
        recording: {
          platform: 'ios',
          child,
          wait,
          ...recordingBase,
          outPath: resolvedOut,
          recorderPid: child.pid,
          startedAt: Date.now(),
        },
      });
    }
    removeInvalidRecordingOutput(resolvedOut);
    return errorResponse('COMMAND_FAILED', formatRecordingStartFailure(readiness));
  }
  const readyAt = readiness.readyAt;
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
      const uptimeResult = await deps.runAppleRunnerCommand(
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

async function waitForLocalRecordingReadiness(
  outPath: string,
  wait: IosSimulatorRecording['wait'],
): Promise<LocalRecordingReadiness> {
  let settledProcessExit: LocalRecordingReadiness | undefined;
  const processExit: Promise<LocalRecordingReadiness> = wait.then(
    (result) => (settledProcessExit = { kind: 'exited', result }),
    (error: unknown) => (settledProcessExit = { kind: 'failed', error }),
  );
  // Give an already-settled recorder wait precedence over a destination the process touched
  // immediately before exiting.
  await Promise.resolve();
  const attempts = Math.ceil(LOCAL_RECORDING_READY_TIMEOUT_MS / LOCAL_RECORDING_READY_POLL_MS);
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    if (settledProcessExit) return settledProcessExit;
    try {
      fs.statSync(outPath);
      const readyAt = Date.now();
      // `simctl recordVideo` creates a zero-byte destination when capture is ready and writes
      // the finalized MP4 only after SIGINT. Existence, not size, is the readiness signal, but
      // keep a short liveness window for an immediate post-create process exit to win.
      const exit = await Promise.race([
        processExit,
        sleep(LOCAL_RECORDING_LIVENESS_GRACE_MS).then(() => undefined),
      ]);
      if (exit) return exit;
      return { kind: 'ready', readyAt };
    } catch {
      // Wait for the recorder to create the output file.
    }

    if (attempt === attempts) return { kind: 'timeout' };
    const exit = await Promise.race([
      processExit,
      sleep(LOCAL_RECORDING_READY_POLL_MS).then(() => undefined),
    ]);
    if (exit) return exit;
  }

  return { kind: 'timeout' };
}

function formatRecordingStartFailure(
  readiness: Exclude<LocalRecordingReadiness, { kind: 'ready' }>,
): string {
  if (readiness.kind === 'timeout') {
    return `failed to start recording: simctl recordVideo did not create its output within ${LOCAL_RECORDING_READY_TIMEOUT_MS}ms`;
  }
  if (readiness.kind === 'failed') {
    return `failed to start recording: ${formatRecordTraceError(readiness.error)}`;
  }
  return `failed to start recording: ${formatRecordTraceExecFailure(
    readiness.result,
    'simctl recordVideo',
  )}`;
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
