import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { provesAndroidScreenRecordTermination } from '@agent-device/contracts/screen-recording-runtime-host';
import type { NativePathDisposition } from '@agent-device/contracts/recording-native-path';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import { chunkPathAt } from './chunk-path.ts';
import type { NativeChunk, NativeManifest } from './manifest.ts';
import { admissionOwner } from './admission.ts';
import { recordingArtifactPath, type AndroidRecordingGeneration } from './native-path.ts';
import { ScreenRecordingStartRolledBack } from '@agent-device/contracts/screen-recording-runtime';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

const GRACEFUL_STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_INTERVAL_MS = 1_000;
const PLAYABLE_PULL_ATTEMPTS = 3;
const PLAYABLE_PULL_INTERVAL_MS = 1_000;

export class AndroidScreenRecordingStartRollbackUnconfirmed extends Error {
  constructor(cause: unknown) {
    super('Android screenrecord launch rollback could not be confirmed', { cause });
  }
}

/**
 * Refusal raised when the recording's stop was claimed before a chunk launch was dispatched. It is
 * how the launch owner reports that the stop outran it, so the rotation withdraws without starting a
 * recorder. Only `startPendingChunk` raises it: a commit already in flight runs to its real outcome,
 * because cancelling the host command cannot prove what the device's rename did.
 */
export class AndroidScreenRecordingStopClaimed extends Error {
  constructor() {
    super('Android screenrecord rotation refused: the recording stop was already claimed');
  }
}

export function candidateRemotePaths(
  generation: AndroidRecordingGeneration,
  now = Date.now(),
): readonly string[] {
  return [recordingArtifactPath('/sdcard', generation, now)];
}

export async function startChunkAt(
  transport: Transport,
  remotePath: string,
  input: ScreenRecordingStartInput,
  manifestPath: string,
  armed: NativeManifest,
  signal?: AbortSignal,
): Promise<NativeChunk> {
  let nativeProcess: Awaited<ReturnType<Transport['start']>>['process'] | undefined;
  try {
    nativeProcess = (
      await transport.start(
        {
          remotePath,
          quality: input.exportQuality ?? 'medium',
          admission: {
            owner: admissionOwner(armed),
            manifestPath,
            expected: JSON.stringify(armed),
            admitted: JSON.stringify({ ...armed, launchDisposition: 'admitted' }),
          },
        },
        signal,
      )
    ).process;
    if (
      !/^\d+$/.test(nativeProcess.pid) ||
      !/^\d+$/.test(nativeProcess.startTime) ||
      nativeProcess.remotePath !== remotePath
    ) {
      throw new Error('Android screenrecord returned an invalid process identity');
    }
    if (!(await waitForReady(transport, remotePath, nativeProcess, signal))) {
      throw new Error('Android screenrecord did not begin producing frames');
    }
    return {
      index: 1,
      remotePath,
      remotePid: nativeProcess.pid,
      remoteStartTime: nativeProcess.startTime,
    };
  } catch (error) {
    if (!nativeProcess || !validProcessIdentity(nativeProcess))
      throw new AndroidScreenRecordingStartRollbackUnconfirmed(error);
    if (!(await rollbackStartedProcess(transport, nativeProcess)))
      throw new AndroidScreenRecordingStartRollbackUnconfirmed(error);
    throw new ScreenRecordingStartRolledBack(error);
  }
}

function validProcessIdentity(
  nativeProcess: Awaited<ReturnType<Transport['start']>>['process'],
): boolean {
  return (
    /^\d+$/.test(nativeProcess.pid) &&
    /^\d+$/.test(nativeProcess.startTime) &&
    nativeProcess.remotePath.length > 0
  );
}

/**
 * Resolves whether the active (last) chunk's recorder had already exited, i.e. the video ends before
 * record stop. Earlier chunks always end before stop because rotation replaced them.
 */
export async function stopOwnedChunks(
  transport: Transport,
  chunks: readonly NativeChunk[],
): Promise<boolean> {
  return (await stopOwnedChunksWithObservation(transport, chunks)).activeAlreadyExited;
}

export async function stopOwnedChunksWithObservation(
  transport: Transport,
  chunks: readonly NativeChunk[],
  onActiveSignalled?: () => void,
  signal?: AbortSignal,
): Promise<{ activeAlreadyExited: boolean; activeSignalled: boolean }> {
  const active = chunks.at(-1);
  let result = { activeAlreadyExited: false, activeSignalled: false };
  let failure: unknown;
  for (const chunk of [...chunks].reverse()) {
    try {
      const stopped = await stopChunkWithObservation(
        transport,
        chunk,
        chunk === active ? onActiveSignalled : undefined,
        signal,
      );
      if (chunk === active)
        result = { activeAlreadyExited: stopped.alreadyExited, activeSignalled: stopped.signalled };
    } catch (error) {
      if (failure === undefined || error instanceof AndroidRecordingOwnershipLost) failure = error;
    }
  }
  if (failure) throw failure;
  return result;
}

export async function waitForStableArtifacts(
  transport: Transport,
  chunks: readonly NativeChunk[],
): Promise<void> {
  for (const chunk of chunks) {
    let previousSize: number | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const size = await transport.size(chunk.remotePath);
      if (typeof size === 'number' && size > 0 && size === previousSize) break;
      previousSize = typeof size === 'number' && size > 0 ? size : undefined;
      if (attempt === 2)
        throw new Error(`Android recording artifact is not stable: ${chunk.remotePath}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Pulls each device chunk to its host path under `outputPath`, retrying until the host copy plays. */
export async function pullChunks(
  transport: Transport,
  chunks: readonly NativeChunk[],
  outputPath: string,
): Promise<void> {
  for (const [offset, chunk] of chunks.entries()) {
    await pullPlayableChunk(transport, chunk.remotePath, chunkPathAt(outputPath, offset + 1));
  }
}

export async function cleanupChunks(
  transport: Transport,
  chunks: readonly NativeChunk[],
): Promise<void> {
  let failure: unknown;
  for (const chunk of chunks) {
    try {
      if (!(await transport.remove(chunk.remotePath)))
        throw new Error(`failed to remove Android recording artifact: ${chunk.remotePath}`);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

/**
 * Whether this recording's own files still sit on the device (ADR 0024 2.3). This is the only place
 * a disposition is decided: the answer is read from the device, so a value a marker froze before a
 * removal cannot survive as the claim after one, and a removal the device reported but did not
 * perform is still seen as owed. `retired` needs a probe that answered "gone" for every chunk, so a
 * probe that could not run leaves the path owed rather than crediting a removal nobody observed.
 */
export async function nativeChunksDisposition(
  transport: Transport,
  chunks: readonly NativeChunk[],
): Promise<NativePathDisposition> {
  for (const chunk of chunks) {
    if ((await transport.exists(chunk.remotePath)) !== false) return 'retirable';
  }
  return 'retired';
}

export async function rollbackChunks(
  transport: Transport,
  chunks: readonly NativeChunk[],
): Promise<void> {
  let stopFailure: unknown;
  for (const chunk of [...chunks].reverse()) {
    try {
      await stopChunk(transport, chunk);
    } catch (error) {
      if (!(error instanceof AndroidRecordingOwnershipLost)) {
        stopFailure ??= error;
        continue;
      }
      const state = await transport
        .inspect({
          pid: chunk.remotePid,
          remotePath: chunk.remotePath,
          startTime: chunk.remoteStartTime,
        })
        .catch(() => 'uncertain' as const);
      if (!provesAndroidScreenRecordTermination(state)) stopFailure ??= error;
    }
  }
  if (stopFailure) throw stopFailure;
  for (const chunk of chunks) {
    const process = {
      pid: chunk.remotePid,
      remotePath: chunk.remotePath,
      startTime: chunk.remoteStartTime,
    };
    if (!(await waitForStopped(transport, process, undefined, { allowReassigned: true })))
      throw new Error('Android recorder did not stop');
  }
  for (const chunk of chunks) {
    const writers = await transport.probeRunningWriters(chunk.remotePath);
    if (!writers.conclusive || writers.writers.length !== 0)
      throw new Error('Android artifact ownership unconfirmed');
  }
  await cleanupChunks(transport, chunks);
  for (const chunk of chunks) {
    if ((await transport.exists(chunk.remotePath)) !== false)
      throw new Error('Android artifact removal unconfirmed');
  }
}

async function waitForReady(
  transport: Transport,
  remotePath: string,
  nativeProcess: Awaited<ReturnType<Transport['start']>>['process'],
  signal?: AbortSignal,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted();
    if ((await transport.exists(remotePath, signal)) === true) return true;
    if ((await transport.inspect(nativeProcess, signal)) !== 'owned-alive') return false;
    if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return true;
}

async function rollbackStartedProcess(
  transport: Transport,
  nativeProcess: Awaited<ReturnType<Transport['start']>>['process'],
): Promise<boolean> {
  try {
    const stopped = await transport.stop(nativeProcess, { force: true });
    return (
      (stopped === 'stopped' || stopped === 'already-missing') &&
      (await waitForStopped(transport, nativeProcess)) &&
      (await pathHasNoWriters(transport, nativeProcess.remotePath)) &&
      (await transport.remove(nativeProcess.remotePath)) &&
      (await transport.exists(nativeProcess.remotePath)) === false
    );
  } catch {
    return false;
  }
}

async function pathHasNoWriters(transport: Transport, remotePath: string): Promise<boolean> {
  const search = await transport.probeRunningWriters(remotePath);
  return search.conclusive && search.writers.length === 0;
}

export class AndroidRecordingOwnershipLost extends Error {}

export async function stopChunk(
  transport: Transport,
  chunk: NativeChunk | undefined,
): Promise<boolean> {
  if (!chunk) return false;
  return (await stopChunkWithObservation(transport, chunk)).alreadyExited;
}

async function stopChunkWithObservation(
  transport: Transport,
  chunk: NativeChunk,
  onSignalled?: () => void,
  signal?: AbortSignal,
): Promise<{ alreadyExited: boolean; signalled: boolean }> {
  const processIdentity = {
    pid: chunk.remotePid,
    remotePath: chunk.remotePath,
    startTime: chunk.remoteStartTime,
  };
  const graceful = await transport.stop(processIdentity, undefined, signal);
  if (graceful === 'stopped') onSignalled?.();
  if (graceful === 'already-missing') return { alreadyExited: true, signalled: false };
  if (graceful === 'ownership-lost')
    throw new AndroidRecordingOwnershipLost(
      `Android screenrecord ownership could not be confirmed for pid ${chunk.remotePid}`,
    );
  if (await waitForStopped(transport, processIdentity, signal))
    return { alreadyExited: false, signalled: graceful === 'stopped' };
  const forced = await transport.stop(processIdentity, { force: true }, signal);
  if (forced === 'stopped' && graceful !== 'stopped') onSignalled?.();
  if (forced === 'stopped' || forced === 'already-missing')
    return { alreadyExited: false, signalled: graceful === 'stopped' || forced === 'stopped' };
  if (forced === 'ownership-lost')
    throw new AndroidRecordingOwnershipLost('Android recorder ownership lost');
  throw new Error(`failed to stop Android screenrecord pid ${chunk.remotePid}`);
}

async function pullPlayableChunk(
  transport: Transport,
  remotePath: string,
  outputPath: string,
): Promise<void> {
  for (let attempt = 0; attempt < PLAYABLE_PULL_ATTEMPTS; attempt += 1) {
    const pulled = await transport.pullPlayable({ remotePath, outputPath });
    if (pulled.exitCode === 0 && pulled.playable) return;
    if (attempt + 1 < PLAYABLE_PULL_ATTEMPTS) await delay(PLAYABLE_PULL_INTERVAL_MS);
  }
  throw new Error('failed to retrieve playable Android recording');
}

async function waitForStopped(
  transport: Transport,
  processIdentity: Awaited<ReturnType<Transport['start']>>['process'],
  signal?: AbortSignal,
  options?: Readonly<{ allowReassigned: boolean }>,
): Promise<boolean> {
  for (let elapsed = 0; elapsed <= GRACEFUL_STOP_TIMEOUT_MS; elapsed += STOP_POLL_INTERVAL_MS) {
    signal?.throwIfAborted();
    const state = await transport.inspect(processIdentity, signal);
    if (state === 'missing') return true;
    if (provesAndroidScreenRecordTermination(state)) {
      if (options?.allowReassigned) return true;
      throw new AndroidRecordingOwnershipLost(
        `Android screenrecord ownership could not be confirmed for pid ${processIdentity.pid}`,
      );
    }
    if (elapsed < GRACEFUL_STOP_TIMEOUT_MS) await delay(STOP_POLL_INTERVAL_MS);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
