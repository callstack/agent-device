import path from 'node:path';
import type { DaemonOpenLifecycle, DaemonRequest, DaemonResponse } from '../../types.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';

import { collectReplayActionArtifactPaths } from './session-replay-runtime-artifacts.ts';
import type {
  ReplayRecordVideoRequest,
  ReplaySessionStore,
  ReplayTestVideoOwner,
} from './command-types.ts';
import {
  defaultRecordingPath,
  recordingExtensionForPlatform,
} from '../../../recording/output-path.ts';

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
  sessionStore: ReplaySessionStore;
  artifactsDir: string | undefined;
  video: ReplayTestVideoOwner;
  appendTimingEvent: (event: Record<string, unknown>) => void;
};

export async function startReplayTestVideoRecordingIfReady(
  params: ReplayTestVideoRecordingParams,
): Promise<DaemonResponse | undefined> {
  const { req, sessionName, sessionStore, artifactsDir, appendTimingEvent } = params;
  if (req.flags?.recordVideo !== true) return undefined;
  const activeSession = sessionStore.get();
  if (!activeSession || activeSession.screenRecording) return undefined;

  const extension = recordingExtensionForPlatform(activeSession.device.platform);
  const videoPath = artifactsDir
    ? path.join(artifactsDir, `recording${extension}`)
    : defaultRecordingPath(activeSession.device.platform);
  appendVideoTimingEvent(appendTimingEvent, {
    type: 'video_recording_start',
    session: sessionName,
    videoPath,
  });
  emitDiagnostic({
    phase: 'replay_test_video_recording_start',
    data: { session: sessionName, videoPath },
  });
  params.video.throwIfCanceled();
  const startResponse = await params.video.record(
    replayVideoRecordRequest({ req, sessionName, phase: 'start', outputPath: videoPath }),
  );
  if (!startResponse.ok) {
    appendVideoTimingEvent(appendTimingEvent, {
      type: 'video_recording_start_failed',
      session: sessionName,
      videoPath,
      errorCode: startResponse.error.code,
    });
    return startResponse;
  }

  const prerollStartedAt = Date.now();
  await sleep(REPLAY_TEST_VIDEO_RECORDING_PREROLL_MS);
  appendVideoTimingEvent(appendTimingEvent, {
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
  const { req, sessionName, sessionStore, artifactPaths, appendTimingEvent } = params;
  if (req.flags?.recordVideo !== true) return undefined;
  if (!sessionStore.get()?.screenRecording) return undefined;

  appendVideoTimingEvent(appendTimingEvent, {
    type: 'video_tail_start',
    session: sessionName,
    requestedDurationMs: REPLAY_TEST_VIDEO_RECORDING_TAIL_MS,
  });
  const tailStartedAt = Date.now();
  await sleep(REPLAY_TEST_VIDEO_RECORDING_TAIL_MS);
  const stopStartedAt = Date.now();
  const stopResponse = await params.video.record(
    replayVideoRecordRequest({ req, sessionName, phase: 'stop' }),
  );
  collectReplayActionArtifactPaths(stopResponse).forEach((entry) => artifactPaths.add(entry));
  appendVideoTimingEvent(appendTimingEvent, {
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
  appendTimingEvent: ReplayTestVideoRecordingParams['appendTimingEvent'],
  event: Record<string, unknown>,
): void {
  appendTimingEvent({ ...event, ts: new Date().toISOString() });
}

type ReplayVideoRecordRequestParams = Readonly<{
  req: DaemonRequest;
  sessionName: string;
}> &
  ({ phase: 'start'; outputPath: string } | { phase: 'stop' });

function replayVideoRecordRequest(
  params: ReplayVideoRecordRequestParams,
): ReplayRecordVideoRequest {
  const request = { token: params.req.token, meta: params.req.meta };
  if (params.phase === 'start') {
    return {
      request,
      sessionName: params.sessionName,
      phase: 'start',
      outputPath: params.outputPath,
    };
  }
  return {
    request,
    sessionName: params.sessionName,
    phase: 'stop',
  };
}
