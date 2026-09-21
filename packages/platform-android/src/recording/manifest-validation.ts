import { isNativePathDisposition } from '@agent-device/contracts/recording-native-path';
import { recordingFactsAreValid } from '@agent-device/capture-kit/recording-facts';
import { isStopObservation } from '@agent-device/contracts/recording-stop-observation';
import type {
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
} from '@agent-device/contracts/screen-recording-runtime';
import { chunkPathAt } from './chunk-path.ts';
import type { AndroidRecordingDescriptor, NativeChunk, NativeManifest } from './manifest.ts';

const nativeRecordingPath =
  /^(?:\/sdcard|\/data\/local\/tmp)\/agent-device-recording-\d{1,20}\.mp4$/;
const nativeManifestPath = /^(?:\/sdcard|\/data\/local\/tmp)\/agent-device-recording-active\.json$/;

export function isValidAndroidRecordingDescriptor(
  value: Record<string, unknown>,
): value is AndroidRecordingDescriptor {
  return (
    descriptorIdentityIsValid(value) &&
    descriptorRecordingIsValid(value) &&
    descriptorOptionsAreValid(value)
  );
}

export function isValidNativeManifest(value: unknown): value is NativeManifest {
  if (!isObject(value)) return false;
  const candidate = value as Partial<NativeManifest>;
  return (
    manifestIdentityIsValid(candidate) &&
    manifestRecordingIsValid(candidate) &&
    manifestOptionsAreValid(candidate) &&
    hasValidManifestResources(candidate) &&
    (candidate.completion === undefined || completionMatchesManifest(candidate as NativeManifest))
  );
}

export function completionMatchesDescriptor(
  completion: ScreenRecordingCompletion,
  descriptor: AndroidRecordingDescriptor,
): boolean {
  return (
    completionCoordinatesMatch(completion, descriptor) &&
    completionChunksMatch(completion, descriptor.outputPath, descriptor.clientOutputPath)
  );
}

function descriptorIdentityIsValid(value: Record<string, unknown>): boolean {
  return (
    value.backend === 'adb-screenrecord' &&
    typeof value.manifestPath === 'string' &&
    nativeManifestPath.test(value.manifestPath) &&
    typeof value.outputPath === 'string'
  );
}

function descriptorRecordingIsValid(value: Record<string, unknown>): boolean {
  return isOptionalText(value.clientOutputPath) && recordingFactsAreValid(value);
}

function descriptorOptionsAreValid(value: Record<string, unknown>): boolean {
  return isTransportMode(value.transportMode);
}

function manifestIdentityIsValid(candidate: Partial<NativeManifest>): boolean {
  return (
    candidate.version === 1 &&
    candidate.resourceKind === 'screen-recording' &&
    typeof candidate.fenceToken === 'string' &&
    Number.isInteger(candidate.fenceGeneration) &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.deviceId === 'string' &&
    Number.isFinite(candidate.startedAt)
  );
}

function manifestRecordingIsValid(candidate: Partial<NativeManifest>): boolean {
  return (
    typeof candidate.outputPath === 'string' &&
    isOptionalText(candidate.clientOutputPath) &&
    recordingFactsAreValid(candidate)
  );
}

function manifestOptionsAreValid(candidate: Partial<NativeManifest>): boolean {
  return (
    isTransportMode(candidate.transportMode) &&
    (candidate.pendingRemotePath === undefined ||
      isNativeRecordingPath(candidate.pendingRemotePath))
  );
}

function hasValidManifestResources(candidate: Partial<NativeManifest>): boolean {
  return (
    Array.isArray(candidate.chunks) &&
    candidate.chunks.every(isValidNativeChunk) &&
    (candidate.chunks.length > 0 || candidate.pendingRemotePath !== undefined) &&
    (candidate.completion === undefined || isValidCompletion(candidate.completion))
  );
}

function isValidNativeChunk(chunk: unknown, index: number): chunk is NativeChunk {
  if (!isObject(chunk)) return false;
  const candidate = chunk as Partial<NativeChunk>;
  return (
    candidate.index === index + 1 &&
    isNativeRecordingPath(candidate.remotePath) &&
    isDecimal(candidate.remotePid) &&
    isDecimal(candidate.remoteStartTime)
  );
}

function isValidCompletion(value: unknown): value is ScreenRecordingCompletion {
  if (!isObject(value)) return false;
  const candidate = value as Partial<ScreenRecordingCompletion>;
  return (
    completionIdentityIsValid(candidate) &&
    completionRecordingIsValid(candidate) &&
    completionFactsAreValid(candidate) &&
    (candidate.chunks === undefined || candidate.chunks.every(isValidCompletionChunk))
  );
}

/** A marker written by an older daemon carries neither field; one with a word no backend reports is not a completion. */
function completionFactsAreValid(candidate: Partial<ScreenRecordingCompletion>): boolean {
  return (
    (candidate.stopObservation === undefined || isStopObservation(candidate.stopObservation)) &&
    (candidate.nativePathDisposition === undefined ||
      isNativePathDisposition(candidate.nativePathDisposition))
  );
}

function completionIdentityIsValid(candidate: Partial<ScreenRecordingCompletion>): boolean {
  return (
    typeof candidate.backend === 'string' &&
    typeof candidate.outPath === 'string' &&
    (candidate.clientOutPath === undefined || typeof candidate.clientOutPath === 'string') &&
    Number.isFinite(candidate.startedAt) &&
    Number.isFinite(candidate.completedAt) &&
    (candidate.capturedDurationMs === undefined || Number.isFinite(candidate.capturedDurationMs))
  );
}

function completionRecordingIsValid(candidate: Partial<ScreenRecordingCompletion>): boolean {
  return recordingFactsAreValid(candidate);
}

function isValidCompletionChunk(chunk: ScreenRecordingChunk, index: number): boolean {
  return (
    chunk.index === index + 1 &&
    typeof chunk.path === 'string' &&
    (chunk.clientOutPath === undefined || typeof chunk.clientOutPath === 'string')
  );
}

function completionMatchesManifest(manifest: NativeManifest): boolean {
  const completion = manifest.completion;
  return (
    completion !== undefined &&
    completionCoordinatesMatch(completion, manifest) &&
    completion.startedAt === manifest.startedAt &&
    completionChunksMatch(
      completion,
      manifest.outputPath,
      manifest.clientOutputPath,
      manifest.chunks.length,
    )
  );
}

function completionCoordinatesMatch(
  completion: ScreenRecordingCompletion,
  recording: Pick<
    AndroidRecordingDescriptor,
    | 'outputPath'
    | 'clientOutputPath'
    | 'scope'
    | 'showTouches'
    | 'recordOnlySession'
    | 'activeSessionApp'
  >,
): boolean {
  return (
    completion.backend === 'adb screenrecord' &&
    completion.outPath === recording.outputPath &&
    completion.clientOutPath === recording.clientOutputPath &&
    completion.scope === recording.scope &&
    completion.showTouches === recording.showTouches &&
    completion.recordOnlySession === recording.recordOnlySession &&
    sameApp(completion.activeSessionApp, recording.activeSessionApp)
  );
}

function completionChunksMatch(
  completion: ScreenRecordingCompletion,
  outputPath: string,
  clientOutputPath: string | undefined,
  expectedChunks = completion.chunks === undefined ? 1 : completion.chunks.length,
): boolean {
  if (expectedChunks === 1) return completion.chunks === undefined;
  return (
    completion.chunks?.length === expectedChunks &&
    completion.chunks.every(
      (chunk, index) =>
        chunk.path === chunkPathAt(outputPath, index + 1) &&
        chunk.clientOutPath ===
          (clientOutputPath === undefined ? undefined : chunkPathAt(clientOutputPath, index + 1)),
    )
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTransportMode(value: unknown): value is AndroidRecordingDescriptor['transportMode'] {
  return value === 'local' || value === 'transport-composed';
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isNativeRecordingPath(value: unknown): value is string {
  return typeof value === 'string' && nativeRecordingPath.test(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function sameApp(
  left: ScreenRecordingCompletion['activeSessionApp'],
  right: AndroidRecordingDescriptor['activeSessionApp'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
