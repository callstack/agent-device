import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  type ScreenRecordingCompletion,
  type ScreenRecordingRuntimeOperations,
  type ScreenRecordingStartInput,
  SCREEN_RECORDING_RESOURCE_KIND,
} from '@agent-device/contracts/screen-recording-runtime';
import {
  completionMatchesDescriptor,
  isValidAndroidRecordingDescriptor,
  isValidNativeManifest,
} from './manifest-validation.ts';

export type AndroidRecordingDescriptor = Readonly<{
  backend: 'adb-screenrecord';
  manifestPath: string;
  outputPath: string;
  clientOutputPath?: string;
  scope: ScreenRecordingStartInput['scope'];
  showTouches: boolean;
  recordOnlySession: boolean;
  activeSessionApp?: ScreenRecordingStartInput['activeSessionApp'];
  exportQuality?: ScreenRecordingStartInput['exportQuality'];
  transportMode: 'local' | 'transport-composed';
}>;

export type NativeChunk = Readonly<{
  index: number;
  remotePath: string;
  remotePid: string;
  remoteStartTime: string;
}>;

export type NativeManifest = Readonly<{
  version: 1;
  resourceKind: 'screen-recording';
  fenceToken: string;
  fenceGeneration: number;
  sessionId: string;
  deviceId: string;
  startedAt: number;
  outputPath: string;
  clientOutputPath?: string;
  scope: ScreenRecordingStartInput['scope'];
  showTouches: boolean;
  recordOnlySession: boolean;
  activeSessionApp?: ScreenRecordingStartInput['activeSessionApp'];
  exportQuality?: ScreenRecordingStartInput['exportQuality'];
  transportMode: 'local' | 'transport-composed';
  chunks: readonly NativeChunk[];
  pendingRemotePath?: string;
  completion?: ScreenRecordingCompletion;
}>;

export const androidScreenRecordingDescriptorCodec = Object.freeze({
  resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
  version: 1,
  encode: (descriptor: AndroidRecordingDescriptor) => ({ ...descriptor }),
  decode: (body: Record<string, unknown>) =>
    isValidAndroidRecordingDescriptor(body)
      ? ({
          status: 'decoded',
          descriptor: Object.freeze({
            backend: 'adb-screenrecord',
            manifestPath: body.manifestPath,
            outputPath: body.outputPath,
            ...(body.clientOutputPath === undefined
              ? {}
              : { clientOutputPath: body.clientOutputPath }),
            scope: body.scope,
            showTouches: body.showTouches,
            recordOnlySession: body.recordOnlySession,
            transportMode: body.transportMode,
            ...(body.activeSessionApp === undefined
              ? {}
              : {
                  activeSessionApp:
                    body.activeSessionApp as AndroidRecordingDescriptor['activeSessionApp'],
                }),
            ...(body.exportQuality === undefined
              ? {}
              : {
                  exportQuality: body.exportQuality as AndroidRecordingDescriptor['exportQuality'],
                }),
          }),
        } as const)
      : ({ status: 'invalid', message: 'Invalid Android screen-recording descriptor' } as const),
});

export function createNativeManifest(
  device: DeviceInfo,
  input: ScreenRecordingStartInput,
  startedAt: number,
  chunks: readonly NativeChunk[],
  pendingRemotePath?: string,
  transportMode: NativeManifest['transportMode'] = 'local',
): NativeManifest {
  return Object.freeze({
    version: 1,
    resourceKind: 'screen-recording',
    fenceToken: input.fence.token,
    fenceGeneration: input.fence.generation,
    sessionId: input.sessionId,
    deviceId: device.id,
    startedAt,
    outputPath: input.outputPath,
    ...(input.clientOutputPath === undefined ? {} : { clientOutputPath: input.clientOutputPath }),
    scope: input.scope,
    showTouches: input.showTouches,
    recordOnlySession: input.recordOnlySession,
    ...(input.activeSessionApp === undefined ? {} : { activeSessionApp: input.activeSessionApp }),
    ...(input.exportQuality === undefined ? {} : { exportQuality: input.exportQuality }),
    chunks,
    ...(pendingRemotePath === undefined ? {} : { pendingRemotePath }),
    transportMode,
  });
}

/**
 * Native completion evidence remains fenced by the same manifest until the daemon has committed
 * the matching durable terminal transition. It deliberately retains the original coordinates so
 * a crash after native finalization can return the exact terminal result without rerunning it.
 */
export function createCompletedNativeManifest(
  active: NativeManifest,
  completion: ScreenRecordingCompletion,
): NativeManifest {
  return Object.freeze({ ...active, completion });
}

export function decodeNativeManifest(value: string | undefined): NativeManifest | undefined {
  try {
    const parsed: unknown = value && JSON.parse(value);
    return isValidNativeManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function nativeManifestMatchesEnvelope(
  manifest: NativeManifest,
  device: DeviceInfo,
  envelope: Parameters<ScreenRecordingRuntimeOperations['screenRecordingCleanup']>[0]['envelope'],
): boolean {
  return (
    manifest.deviceId === device.id &&
    manifest.deviceId === envelope.device.id &&
    manifest.fenceToken === envelope.fence.token &&
    manifest.fenceGeneration === envelope.fence.generation &&
    manifest.sessionId === envelope.sessionId
  );
}

export function nativeManifestMatchesDescriptor(
  manifest: NativeManifest,
  descriptor: AndroidRecordingDescriptor,
): boolean {
  return (
    manifest.outputPath === descriptor.outputPath &&
    manifest.clientOutputPath === descriptor.clientOutputPath &&
    manifest.scope === descriptor.scope &&
    manifest.showTouches === descriptor.showTouches &&
    manifest.recordOnlySession === descriptor.recordOnlySession &&
    JSON.stringify(manifest.activeSessionApp) === JSON.stringify(descriptor.activeSessionApp) &&
    manifest.exportQuality === descriptor.exportQuality &&
    manifest.transportMode === descriptor.transportMode &&
    (manifest.completion === undefined ||
      completionMatchesDescriptor(manifest.completion, descriptor))
  );
}
