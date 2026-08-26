import type {
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
} from '@agent-device/contracts/screen-recording-runtime';
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
  return (
    (value.clientOutputPath === undefined || typeof value.clientOutputPath === 'string') &&
    isScope(value.scope) &&
    typeof value.showTouches === 'boolean' &&
    typeof value.recordOnlySession === 'boolean'
  );
}

function descriptorOptionsAreValid(value: Record<string, unknown>): boolean {
  return (
    isTransportMode(value.transportMode) &&
    isOptionalQuality(value.exportQuality) &&
    isOptionalApp(value.activeSessionApp)
  );
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
    (candidate.clientOutputPath === undefined || typeof candidate.clientOutputPath === 'string') &&
    isScope(candidate.scope) &&
    typeof candidate.showTouches === 'boolean' &&
    typeof candidate.recordOnlySession === 'boolean'
  );
}

function manifestOptionsAreValid(candidate: Partial<NativeManifest>): boolean {
  return (
    isOptionalApp(candidate.activeSessionApp) &&
    isOptionalQuality(candidate.exportQuality) &&
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
    (candidate.chunks === undefined || candidate.chunks.every(isValidCompletionChunk))
  );
}

function completionIdentityIsValid(candidate: Partial<ScreenRecordingCompletion>): boolean {
  return (
    typeof candidate.backend === 'string' &&
    typeof candidate.outPath === 'string' &&
    (candidate.clientOutPath === undefined || typeof candidate.clientOutPath === 'string') &&
    Number.isFinite(candidate.startedAt) &&
    Number.isFinite(candidate.completedAt)
  );
}

function completionRecordingIsValid(candidate: Partial<ScreenRecordingCompletion>): boolean {
  return (
    isScope(candidate.scope) &&
    typeof candidate.showTouches === 'boolean' &&
    typeof candidate.recordOnlySession === 'boolean' &&
    isOptionalApp(candidate.activeSessionApp)
  );
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
        chunk.path === chunkPath(outputPath, index + 1) &&
        chunk.clientOutPath ===
          (clientOutputPath === undefined ? undefined : chunkPath(clientOutputPath, index + 1)),
    )
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isScope(value: unknown): value is 'app' | 'device' | 'system' {
  return value === 'app' || value === 'device' || value === 'system';
}

function isTransportMode(value: unknown): value is AndroidRecordingDescriptor['transportMode'] {
  return value === 'local' || value === 'transport-composed';
}

function isOptionalQuality(value: unknown): boolean {
  return value === undefined || value === 'medium' || value === 'high';
}

function isOptionalApp(value: unknown): boolean {
  return (
    value === undefined ||
    (isObject(value) &&
      typeof value.bundleId === 'string' &&
      (value.name === undefined || typeof value.name === 'string'))
  );
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

function chunkPath(outputPath: string, index: number): string {
  if (index === 1) return outputPath;
  const extension = outputPath.lastIndexOf('.');
  const base =
    extension > outputPath.lastIndexOf('/') ? outputPath.slice(0, extension) : outputPath;
  const suffix = extension > outputPath.lastIndexOf('/') ? outputPath.slice(extension) : '.mp4';
  return `${base}.part-${String(index).padStart(3, '0')}${suffix}`;
}
