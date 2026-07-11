import path from 'node:path';
import type { DaemonOpenLifecycle, DaemonRequest, DaemonResponse } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { sleep } from '../../utils/timeouts.ts';
import { handleRecordCommand } from './record-trace-recording.ts';
import { appendReplayTestTimingEvent } from './session-test-runtime.ts';
import { collectReplayActionArtifactPaths } from './session-replay-runtime-artifacts.ts';
import {
  defaultRecordingPath,
  recordingExtensionForPlatform,
} from '../../recording/output-path.ts';

const REPLAY_TEST_VIDEO_RECORDING_PREROLL_MS = 1_000;
const REPLAY_TEST_VIDEO_RECORDING_TAIL_MS = 3_000;

export function buildReplayTestVideoOpenLifecycle(
  params: ReplayTestVideoRecordingParams,
): DaemonOpenLifecycle | undefined {
  if (params.req.flags?.recordVideo !== true) return undefined;
  return {
    beforeDispatch: async () => await startReplayTestVideoRecordingIfReady(params),
  };
}

type ReplayTestVideoRecordingParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  artifactsDir: string | undefined;
  tracePath: string | undefined;
};

export async function startReplayTestVideoRecordingIfReady(
  params: ReplayTestVideoRecordingParams,
): Promise<DaemonResponse | undefined> {
  const { req, sessionName, logPath, sessionStore, artifactsDir, tracePath } = params;
  if (req.flags?.recordVideo !== true) return undefined;
  const activeSession = sessionStore.get(sessionName);
  if (!activeSession || activeSession.recording) return undefined;

  const extension = recordingExtensionForPlatform(activeSession.device.platform);
  const videoPath = artifactsDir
    ? path.join(artifactsDir, `recording${extension}`)
    : defaultRecordingPath(activeSession.device.platform);
  appendVideoTimingEvent(tracePath, {
    type: 'video_recording_start',
    session: sessionName,
    videoPath,
  });
  emitDiagnostic({
    phase: 'replay_test_video_recording_start',
    data: { session: sessionName, videoPath },
  });
  const startResponse = await handleRecordCommand({
    req: {
      token: req.token,
      session: sessionName,
      command: 'record',
      positionals: ['start', videoPath],
      flags: {},
      meta: req.meta,
    },
    sessionName,
    sessionStore,
    logPath,
  });
  if (!startResponse.ok) {
    appendVideoTimingEvent(tracePath, {
      type: 'video_recording_start_failed',
      session: sessionName,
      videoPath,
      errorCode: startResponse.error.code,
    });
    return startResponse;
  }

  const prerollStartedAt = Date.now();
  await sleep(REPLAY_TEST_VIDEO_RECORDING_PREROLL_MS);
  appendVideoTimingEvent(tracePath, {
    type: 'video_preroll_done',
    session: sessionName,
    durationMs: Date.now() - prerollStartedAt,
    requestedDurationMs: REPLAY_TEST_VIDEO_RECORDING_PREROLL_MS,
  });
  emitDiagnostic({
    phase: 'replay_test_video_recording_preroll_done',
    durationMs: Date.now() - prerollStartedAt,
    data: { session: sessionName, requestedDurationMs: REPLAY_TEST_VIDEO_RECORDING_PREROLL_MS },
  });
  return startResponse;
}

export async function finalizeReplayTestVideoRecording(
  params: ReplayTestVideoRecordingParams & {
    artifactPaths: Set<string>;
  },
): Promise<DaemonResponse | undefined> {
  const { req, sessionName, logPath, sessionStore, tracePath, artifactPaths } = params;
  if (req.flags?.recordVideo !== true) return undefined;
  if (!sessionStore.get(sessionName)?.recording) return undefined;

  appendVideoTimingEvent(tracePath, {
    type: 'video_tail_start',
    session: sessionName,
    requestedDurationMs: REPLAY_TEST_VIDEO_RECORDING_TAIL_MS,
  });
  const tailStartedAt = Date.now();
  await sleep(REPLAY_TEST_VIDEO_RECORDING_TAIL_MS);
  const stopStartedAt = Date.now();
  const stopResponse = await handleRecordCommand({
    req: {
      token: req.token,
      session: sessionName,
      command: 'record',
      positionals: ['stop'],
      flags: {},
      meta: req.meta,
    },
    sessionName,
    sessionStore,
    logPath,
  });
  collectReplayActionArtifactPaths(stopResponse).forEach((entry) => artifactPaths.add(entry));
  appendVideoTimingEvent(tracePath, {
    type: 'video_recording_stop',
    session: sessionName,
    ok: stopResponse.ok,
    durationMs: Date.now() - stopStartedAt,
    tailDurationMs: stopStartedAt - tailStartedAt,
    errorCode: stopResponse.ok ? undefined : stopResponse.error.code,
  });
  emitDiagnostic({
    phase: 'replay_test_video_recording_stop',
    durationMs: Date.now() - stopStartedAt,
    data: {
      session: sessionName,
      ok: stopResponse.ok,
      tailDurationMs: stopStartedAt - tailStartedAt,
    },
  });
  return stopResponse;
}

function appendVideoTimingEvent(
  tracePath: string | undefined,
  event: Record<string, unknown>,
): void {
  appendReplayTestTimingEvent(tracePath, {
    ...event,
    ts: new Date().toISOString(),
  });
}
