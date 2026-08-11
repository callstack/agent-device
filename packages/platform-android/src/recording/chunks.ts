import path from 'node:path';
import type {
  PlatformRuntimeHost,
  ScreenRecordingChunk,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/platform';
import type { NativeChunk } from './manifest.ts';

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

export function candidateRemotePaths(
  preferredDir: string | undefined,
  now = Date.now(),
): readonly string[] {
  const dirs = preferredDir
    ? [preferredDir, '/sdcard', '/data/local/tmp']
    : ['/sdcard', '/data/local/tmp'];
  return [...new Set(dirs)].map((directory) => `${directory}/agent-device-recording-${now}.mp4`);
}

export async function startChunkAt(
  transport: Transport,
  remotePath: string,
  input: ScreenRecordingStartInput,
  signal?: AbortSignal,
): Promise<NativeChunk> {
  let nativeProcess: Awaited<ReturnType<Transport['start']>>['process'] | undefined;
  try {
    nativeProcess = (
      await transport.start({ remotePath, quality: input.exportQuality ?? 'medium' }, signal)
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
    if (
      nativeProcess &&
      validProcessIdentity(nativeProcess) &&
      !(await rollbackStartedProcess(transport, nativeProcess))
    ) {
      throw new AndroidScreenRecordingStartRollbackUnconfirmed(error);
    }
    if (signal?.aborted) throw signal.reason;
    throw error;
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

export async function stopOwnedChunks(
  transport: Transport,
  chunks: readonly NativeChunk[],
): Promise<boolean> {
  let reachedLimit = false;
  let failure: unknown;
  for (const chunk of [...chunks].reverse()) {
    try {
      reachedLimit = (await stopChunk(transport, chunk)) || reachedLimit;
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return reachedLimit;
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

export async function pullChunks(
  transport: Transport,
  chunks: readonly NativeChunk[],
  outputPath: string,
  clientOutputPath?: string,
): Promise<readonly ScreenRecordingChunk[]> {
  const results: ScreenRecordingChunk[] = [];
  for (const [offset, chunk] of chunks.entries()) {
    const pathForChunk = offset === 0 ? outputPath : chunkOutputPath(outputPath, offset + 1);
    await pullPlayableChunk(transport, chunk.remotePath, pathForChunk);
    const clientPath =
      offset === 0 || clientOutputPath === undefined
        ? clientOutputPath
        : chunkOutputPath(clientOutputPath, offset + 1);
    results.push({
      index: offset + 1,
      path: pathForChunk,
      ...(clientPath === undefined ? {} : { clientOutPath: clientPath }),
    });
  }
  return Object.freeze(results);
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

export async function rollbackChunks(
  transport: Transport,
  chunks: readonly NativeChunk[],
): Promise<void> {
  try {
    await stopOwnedChunks(transport, chunks);
  } finally {
    await cleanupChunks(transport, chunks);
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
      (await transport.remove(nativeProcess.remotePath))
    );
  } catch {
    return false;
  }
}

export async function stopChunk(
  transport: Transport,
  chunk: NativeChunk | undefined,
): Promise<boolean> {
  if (!chunk) return false;
  const processIdentity = {
    pid: chunk.remotePid,
    remotePath: chunk.remotePath,
    startTime: chunk.remoteStartTime,
  };
  const graceful = await transport.stop(processIdentity);
  if (graceful === 'already-missing') return true;
  if (graceful === 'ownership-lost')
    throw new Error(
      `Android screenrecord ownership could not be confirmed for pid ${chunk.remotePid}`,
    );
  if (await waitForStopped(transport, processIdentity)) return false;
  const forced = await transport.stop(processIdentity, { force: true });
  if (forced === 'stopped' || forced === 'already-missing') return false;
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
): Promise<boolean> {
  for (let elapsed = 0; elapsed <= GRACEFUL_STOP_TIMEOUT_MS; elapsed += STOP_POLL_INTERVAL_MS) {
    const state = await transport.inspect(processIdentity);
    if (state === 'missing') return true;
    if (state === 'ownership-lost') {
      throw new Error(
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

function chunkOutputPath(outputPath: string, index: number): string {
  const parsed = path.parse(outputPath);
  return path.join(
    parsed.dir,
    `${parsed.name}.part-${String(index).padStart(3, '0')}${parsed.ext || '.mp4'}`,
  );
}
