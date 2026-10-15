import path from 'node:path';
import type { Platform, PlatformSelector } from '@agent-device/kernel/device';
import { resolveUserPath } from '@agent-device/host-kit/file';
import { buildRemoteTempArtifactPath } from '@agent-device/contracts/daemon-http';

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
  /** Where a remote caller downloads the finished recording on its own host. */
  clientOutputPath?: string;
}>;

export function resolveRecordingOutputPaths(params: {
  requestedPath?: string;
  clientOutputPath?: string;
  platform: Platform;
  cwd?: string;
}): RecordingOutputPaths {
  if (params.requestedPath === undefined && params.clientOutputPath !== undefined) {
    return resolveRemoteDefaultRecordingPaths(params.clientOutputPath, params.platform);
  }
  const requestedPath =
    params.requestedPath === undefined
      ? defaultRecordingPath(params.platform)
      : params.platform === 'web'
        ? appendRecordingExtensionWhenMissing(params.requestedPath, WEB_RECORDING_EXTENSION)
        : params.requestedPath;
  return Object.freeze({
    requestedPath,
    outputPath: resolveUserPath(requestedPath, { cwd: params.cwd }),
    ...(params.clientOutputPath === undefined ? {} : { clientOutputPath: params.clientOutputPath }),
  });
}

/**
 * A remote caller that names no path cannot know the session platform's extension, so it sends its
 * local destination without one. The daemon completes it and records to a temp path on its own
 * host, which the caller downloads from; the caller's cwd does not exist here.
 */
function resolveRemoteDefaultRecordingPaths(
  clientOutputStem: string,
  platform: Platform,
): RecordingOutputPaths {
  const extension = recordingExtensionForPlatform(platform);
  const clientOutputPath = appendRecordingExtensionWhenMissing(clientOutputStem, extension);
  return Object.freeze({
    requestedPath: clientOutputPath,
    outputPath: buildRemoteTempArtifactPath('recording', extension),
    clientOutputPath,
  });
}
