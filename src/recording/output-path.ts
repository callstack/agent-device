import path from 'node:path';
import type { Platform, PlatformSelector } from '../kernel/device.ts';

const DEFAULT_RECORDING_EXTENSION = '.mp4';
export const WEB_RECORDING_EXTENSION = '.webm';

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
