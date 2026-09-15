import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { ScreenRecordingLiveSnapshot } from '@agent-device/contracts/screen-recording-runtime';
import {
  cleanupChunks,
  nativeChunksDisposition,
  pullChunks,
  stopOwnedChunks,
  waitForStableArtifacts,
} from './chunks.ts';
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
    // `stopOwnedChunks` either observed each recorder gone or threw; reaching here is proof, not an
    // assumption (ADR 0024 2.2).
    stopObservation: { recorder: 'confirmed' },
    // The recorders are gone and the remote chunks still sit on the device: owed a removal, safe to do.
    nativePathDisposition: 'retirable',
  });
  // The marker is published before disposal on purpose: a crash after it must not lose a completion
  // the export already earned. Its disposition is true of the moment it was written, and every
  // reader re-reads that one field from the device rather than replaying it.
  await persistNativeManifest(
    params.transport,
    params.manifestPath,
    createCompletedNativeManifest(params.evidence, outcome.result),
  );
  await cleanupChunks(params.transport, params.evidence.chunks);
  // Disposal is over once the device stops showing the chunks. A removal the device reported but
  // did not perform stays owed instead of being declared done by the call's return value.
  return {
    status: 'completed',
    result: {
      ...outcome.result,
      nativePathDisposition: await nativeChunksDisposition(
        params.transport,
        params.evidence.chunks,
      ),
    },
  };
}
