import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { AndroidScreenRecordingProcessOwnership } from '@agent-device/contracts/screen-recording-runtime-host';
import type { NativeChunk } from './manifest.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

export type AndroidChunkRecorderStatus = Readonly<{
  chunk: NativeChunk;
  /** What the device answered for the identity the chunk recorded, never for whoever holds its pid. */
  state: AndroidScreenRecordingProcessOwnership;
}>;

/** Asks the device, for every committed chunk, what became of the recorder its identity names. */
export async function observeRecordedRecorders(
  transport: Transport,
  chunks: readonly NativeChunk[],
): Promise<readonly AndroidChunkRecorderStatus[]> {
  return await Promise.all(
    chunks.map(async (chunk) => ({
      chunk,
      state: await transport.inspect({
        pid: chunk.remotePid,
        remotePath: chunk.remotePath,
        startTime: chunk.remoteStartTime,
      }),
    })),
  );
}
