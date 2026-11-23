import path from 'node:path';
import type { Platform, PlatformSelector } from '@agent-device/kernel/device';
import { resolveUserPath } from '@agent-device/host-kit/path-resolution';

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
  cwd: string;
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

/**
 * The host path of a recording's `index`th file (1-based). The first file keeps the base path and each
 * later one takes a `.part-NNN` suffix. Pulled, served and journaled chunk sets all follow this one
 * rule from their own base, which is what lets an attempt that never ran the pull name the files a
 * previous attempt left behind.
 */
export function chunkPathAt(basePath: string, index: number): string {
  if (index === 1) return basePath;
  const parsed = path.parse(basePath);
  return path.join(
    parsed.dir,
    `${parsed.name}.part-${String(index).padStart(3, '0')}${parsed.ext || '.mp4'}`,
  );
}
