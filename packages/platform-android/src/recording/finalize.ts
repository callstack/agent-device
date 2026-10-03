import type {
  DurableCaptureProgress,
  FinishOutcome,
} from '@agent-device/contracts/durable-resource';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
  ScreenRecordingLiveSnapshot,
} from '@agent-device/contracts/screen-recording-runtime';
import type { ScreenRecordingFinalization } from '@agent-device/contracts/recording-stop-progress';
import { stopAndExportScreenRecording } from '@agent-device/capture-kit/recording-stop-sequence';
import { measureCapturedWindow } from './captured-window.ts';
import { chunkPathAt } from './chunk-path.ts';
import {
  cleanupChunks,
  nativeChunksDisposition,
  pullChunks,
  stopOwnedChunks,
  waitForStableArtifacts,
} from './chunks.ts';
import { createCompletedNativeManifest, type NativeManifest } from './manifest.ts';
import { persistNativeManifest } from './manifest-store.ts';

const TARGET_LABEL = 'Android recording';
const PLATFORM_LIMIT_WARNING =
  'Android adb screenrecord stopped before record stop, likely after reaching the 180s platform ' +
  'limit. The MP4 may be truncated; final interactions after the limit are not in the video.';
const CHUNKED_WARNING =
  'Android adb screenrecord is capped at 180s, so this recording was split into multiple MP4 chunks.';
const CHUNKED_OVERLAY_WARNING =
  'touch overlay burn-in is skipped for chunked Android recordings; returning raw chunks plus ' +
  'gesture telemetry';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

/**
 * One `record stop` for `adb screenrecord`, committed between its steps (ADR 0024 2.3).
 *
 * The device's chunks are pulled to collected siblings, checked there, and only then copied onto the
 * caller's paths. A stop that dies partway therefore leaves the caller's video absent and the collected
 * set present, and the next attempt resumes from that set instead of signalling a recorder that already
 * stopped and pulling a device file that may have moved.
 */
export async function finalizeAndroidRecording(
  params: Readonly<{
    host: PlatformRuntimeHost;
    transport: Transport;
    evidence: NativeManifest;
    manifestPath: string;
    recording: ScreenRecordingLiveSnapshot;
    /** Host instant the recorder was launched, which is where a clip's timeline begins. */
    startedAtMs: number;
    progress?: DurableCaptureProgress;
    reachedLimit?: boolean;
  }>,
): Promise<FinishOutcome<ScreenRecordingCompletion>> {
  const { host, transport, evidence, recording, startedAtMs, progress } = params;
  let reachedLimit = params.reachedLimit === true;
  const outcome = await stopAndExportScreenRecording({
    snapshot: recording,
    progress,
    steps: {
      stop: async () => {
        // `stopOwnedChunks` either observed each recorder gone or threw, and an artifact that stopped
        // growing is the evidence the recorder stopped writing (ADR 0024 2.2). The platform limit is
        // disclosed here rather than at the export because it is a fact about the recorder, and the
        // journal is what keeps it attached to a stop that has to be driven again.
        reachedLimit = (await stopOwnedChunks(transport, evidence.chunks)) || reachedLimit;
        await waitForStableArtifacts(transport, evidence.chunks);
        return {
          observation: { recorder: 'confirmed' },
          ...(reachedLimit ? { warning: PLATFORM_LIMIT_WARNING } : {}),
        };
      },
      // Each chunk is pulled until its host copy plays, which is the playability check for the pulled
      // set; the finalizer checks the export once more because that is the file the caller is served.
      collect: (collectedPath) => pullChunks(transport, evidence.chunks, collectedPath),
      finalize: ({ collectedPath, exportPath, stoppedAtMs }) =>
        exportCollectedChunks({
          host,
          evidence,
          recording,
          startedAtMs,
          stoppedAtMs,
          collectedPath,
          exportPath,
        }),
      discard: (collectedPath) =>
        discardCollectedChunks(host, collectedPath, evidence.chunks.length),
    },
  });
  return await recordCompletionAndDisposeChunks(params, outcome);
}

/** Copies the collected set onto the caller's paths and finalizes the export, never the pulled set. */
async function exportCollectedChunks(
  params: Readonly<{
    host: PlatformRuntimeHost;
    evidence: NativeManifest;
    recording: ScreenRecordingLiveSnapshot;
    startedAtMs: number;
    stoppedAtMs: number;
    collectedPath: string;
    exportPath: string;
  }>,
): Promise<ScreenRecordingFinalization> {
  const { host, evidence, recording, collectedPath, exportPath } = params;
  const files = chunkFilePairs({
    collectedPath,
    exportPath,
    exportClientPath: recording.clientOutPath,
    count: evidence.chunks.length,
  });
  const chunked = files.length > 1;
  let finalization: Awaited<
    ReturnType<PlatformRuntimeHost['screenRecording']['finalize']['complete']>
  >;
  try {
    await copyCollectedChunksToExport(host, files);
    finalization = await host.screenRecording.finalize.complete({
      outputPath: exportPath,
      showTouches: chunked ? false : recording.showTouches,
      gestureEvents: recording.gestureEvents,
      exportQuality: recording.exportQuality ?? 'medium',
      targetLabel: TARGET_LABEL,
    });
  } catch (error) {
    // The caller's paths only ever hold bytes the finalizer accepted. The collected set stays for the retry.
    for (const { served } of files) await host.screenRecording.outputs.remove(served.path);
    throw error;
  }
  // The length is measured on the pulled set because those are the bytes the recorder wrote; the
  // export is a copy of them, and a copy cannot tell the caller anything the original did not.
  const captured = measureCapturedWindow({
    chunkPaths: files.map(({ collected }) => collected.path),
    startedAtMs: params.startedAtMs,
    stoppedAtMs: params.stoppedAtMs,
  });
  return finalizationFromExport({ finalization, captured, recording, chunked, files });
}

async function copyCollectedChunksToExport(
  host: PlatformRuntimeHost,
  files: readonly Readonly<{ collected: ScreenRecordingChunk; served: ScreenRecordingChunk }>[],
): Promise<void> {
  for (const { collected, served } of files) {
    await host.screenRecording.outputs.copy({ from: collected.path, to: served.path });
  }
}

/**
 * The collected set has served its purpose once its finalization is journaled; keeping it would leave a
 * second copy of the video behind with nothing left to read it. A refused removal is not a failure the
 * caller can act on, because their video already exists.
 */
async function discardCollectedChunks(
  host: PlatformRuntimeHost,
  collectedPath: string,
  count: number,
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await host.screenRecording.outputs.remove(chunkPathAt(collectedPath, index));
  }
}

function finalizationFromExport(
  params: Readonly<{
    finalization: Awaited<
      ReturnType<PlatformRuntimeHost['screenRecording']['finalize']['complete']>
    >;
    captured: Readonly<{ capturedDurationMs?: number; idleTailWarning?: string }>;
    recording: ScreenRecordingLiveSnapshot;
    chunked: boolean;
    files: readonly Readonly<{ collected: ScreenRecordingChunk; served: ScreenRecordingChunk }>[];
  }>,
): ScreenRecordingFinalization {
  const { finalization, captured, recording, chunked, files } = params;
  const warnings = [
    finalization.warning,
    ...(chunked ? [CHUNKED_WARNING] : []),
    captured.idleTailWarning,
  ].filter((warning): warning is string => warning !== undefined && warning.length > 0);
  return {
    ...(finalization.telemetryPath === undefined
      ? {}
      : { telemetryPath: finalization.telemetryPath }),
    ...(warnings.length === 0 ? {} : { warning: warnings.join(' ') }),
    ...(chunked && recording.showTouches && recording.gestureEvents.length > 0
      ? { overlayWarning: CHUNKED_OVERLAY_WARNING }
      : {}),
    ...(captured.capturedDurationMs === undefined
      ? {}
      : { capturedDurationMs: captured.capturedDurationMs }),
    ...(chunked ? { chunks: files.map((file) => file.served) } : {}),
    // The recorders are gone and the chunks still sit on the device: owed a removal, safe to do.
    nativePathDisposition: 'retirable',
  };
}

/**
 * Publishes the completion the export earned, then disposes the device's chunks and answers with what
 * the device actually shows afterwards (ADR 0024 2.3).
 *
 * The marker is written before disposal on purpose: a crash after it must not lose a completion the
 * export already earned. Its disposition is true of the moment it was written, and every reader — this
 * one included — re-reads that one field from the device rather than replaying it.
 */
async function recordCompletionAndDisposeChunks(
  params: Readonly<{
    host: PlatformRuntimeHost;
    transport: Transport;
    evidence: NativeManifest;
    manifestPath: string;
  }>,
  outcome: Readonly<{ status: 'completed'; result: ScreenRecordingCompletion }>,
): Promise<FinishOutcome<ScreenRecordingCompletion>> {
  const { transport, evidence, manifestPath } = params;
  await persistNativeManifest(
    transport,
    manifestPath,
    createCompletedNativeManifest(evidence, outcome.result),
  );
  await cleanupChunks(transport, evidence.chunks);
  // Disposal is over once the device stops showing the chunks. A removal the device reported but did
  // not perform stays owed instead of being declared done by the call's return value.
  return {
    status: 'completed',
    result: {
      ...outcome.result,
      nativePathDisposition: await nativeChunksDisposition(transport, evidence.chunks),
    },
  };
}

/** The files one recording is made of, on both sides of the copy, named by the one chunk rule. */
function chunkFilePairs(
  params: Readonly<{
    collectedPath: string;
    exportPath: string;
    exportClientPath: string | undefined;
    count: number;
  }>,
): readonly Readonly<{ collected: ScreenRecordingChunk; served: ScreenRecordingChunk }>[] {
  return Object.freeze(
    Array.from({ length: params.count }, (_, offset) => ({
      collected: Object.freeze({
        index: offset + 1,
        path: chunkPathAt(params.collectedPath, offset + 1),
      }),
      served: Object.freeze({
        index: offset + 1,
        path: chunkPathAt(params.exportPath, offset + 1),
        ...(params.exportClientPath === undefined
          ? {}
          : { clientOutPath: chunkPathAt(params.exportClientPath, offset + 1) }),
      }),
    })),
  );
}
