import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { ScreenRecordingLiveSnapshot } from '@agent-device/contracts/screen-recording-runtime';
import { cleanupChunks, pullChunks, stopOwnedChunks, waitForStableArtifacts } from './chunks.ts';
import { completed } from './completion.ts';
import { createCompletedNativeManifest, type NativeManifest } from './manifest.ts';
import { persistNativeManifest } from './manifest-store.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

/** Finalize media first, then durably publish terminal coordinates before native artifact cleanup. */
export async function finalizeAndroidRecording(params: {
  host: PlatformRuntimeHost;
  transport: Transport;
  evidence: NativeManifest;
  manifestPath: string;
  recording: ScreenRecordingLiveSnapshot;
  /** Host instant the recorder was launched, which is where a clip's timeline begins. */
  startedAtMs: number;
  reachedLimit?: boolean;
}): Promise<
  Readonly<{
    status: 'completed';
    result: import('@agent-device/contracts/screen-recording-runtime').ScreenRecordingCompletion;
  }>
> {
  // Read the clock before the signal below: everything after that signal is this tool's own export
  // latency rather than time the screen sat unchanged.
  const stoppedAtMs = Date.now();
  const reachedLimit =
    (await stopOwnedChunks(params.transport, params.evidence.chunks)) ||
    params.reachedLimit === true;
  await waitForStableArtifacts(params.transport, params.evidence.chunks);
  const outputChunks = await pullChunks(
    params.transport,
    params.evidence.chunks,
    params.recording.outPath,
    params.recording.clientOutPath,
  );
  const outcome = await completed({
    host: params.host,
    recording: params.recording,
    chunks: outputChunks,
    targetLabel: 'Android recording',
    reachedLimit,
    startedAtMs: params.startedAtMs,
    stoppedAtMs,
  });
  await persistNativeManifest(
    params.transport,
    params.manifestPath,
    createCompletedNativeManifest(params.evidence, outcome.result),
  );
  await cleanupChunks(params.transport, params.evidence.chunks);
  return outcome;
}
