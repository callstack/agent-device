import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { ScreenRecordingLiveSnapshot } from '@agent-device/contracts/screen-recording-runtime';
import { cleanupChunks, pullChunks, stopOwnedChunks, waitForStableArtifacts } from './chunks.ts';
import { completed } from './completion.ts';
import { createCompletedNativeManifest, type NativeManifest } from './manifest.ts';
import { persistNativeManifest } from './launch.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

/** Finalize media first, then durably publish terminal coordinates before native artifact cleanup. */
export async function finalizeAndroidRecording(params: {
  host: PlatformRuntimeHost;
  transport: Transport;
  evidence: NativeManifest;
  manifestPath: string;
  recording: ScreenRecordingLiveSnapshot;
  reachedLimit?: boolean;
}): Promise<
  Readonly<{
    status: 'completed';
    result: import('@agent-device/contracts/screen-recording-runtime').ScreenRecordingCompletion;
  }>
> {
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
  const outcome = await completed(
    params.host,
    params.recording,
    outputChunks,
    'Android recording',
    reachedLimit,
  );
  await persistNativeManifest(
    params.transport,
    params.manifestPath,
    createCompletedNativeManifest(params.evidence, outcome.result),
  );
  await cleanupChunks(params.transport, params.evidence.chunks);
  return outcome;
}
