import path from 'node:path';
import type { Platform, PlatformSelector } from '@agent-device/kernel/device';
import { resolveUserPath } from '@agent-device/host-kit/file';

const DEFAULT_RECORDING_EXTENSION = '.mp4';
const WEB_RECORDING_EXTENSION = '.webm';

export function recordingExtensionForPlatform(
  platform: Platform | PlatformSelector | undefined,
): string {
  return platform === 'web' ? WEB_RECORDING_EXTENSION : DEFAULT_RECORDING_EXTENSION;
}

export function appendRecordingExtensionWhenMissing(filePath: string, extension: string): string {
  return path.extname(filePath) ? filePath : `${filePath}${extension}`;
}

export function defaultRecordingPath(platform: Platform | undefined): string {
  return `./recording-${Date.now()}${recordingExtensionForPlatform(platform)}`;
}

export type RecordingOutputPaths = Readonly<{
  requestedPath: string;
  outputPath: string;
}>;

export function resolveRecordingOutputPaths(params: {
  requestedPath?: string;
  platform: Platform;
  cwd?: string;
}): RecordingOutputPaths {
  const requestedPath =
    params.requestedPath === undefined
      ? defaultRecordingPath(params.platform)
      : params.platform === 'web'
        ? appendRecordingExtensionWhenMissing(params.requestedPath, WEB_RECORDING_EXTENSION)
        : params.requestedPath;
  return Object.freeze({
    requestedPath,
    outputPath: resolveUserPath(requestedPath, { cwd: params.cwd }),
  });
}
