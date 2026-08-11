import type { RecordingScope } from '@agent-device/contracts/recording';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/platform';
import { AppError } from '@agent-device/kernel/errors';

type ScreenRecordingOptionSupport = Readonly<{
  scopes: readonly RecordingScope[];
  fps: boolean;
  exportQuality: boolean;
  hideTouches: boolean;
}>;

export function assertScreenRecordingOptionsSupported(
  input: ScreenRecordingStartInput,
  support: ScreenRecordingOptionSupport,
  message: (unsupported: readonly string[]) => string,
): void {
  const unsupported = unsupportedScreenRecordingOptions(input, support);
  if (unsupported.length > 0) {
    throw new AppError('INVALID_ARGS', message(unsupported));
  }
}

function unsupportedScreenRecordingOptions(
  input: ScreenRecordingStartInput,
  support: ScreenRecordingOptionSupport,
): readonly string[] {
  return Object.freeze([
    ...(support.scopes.includes(input.scope) ? [] : ['--scope']),
    ...(support.fps || input.fps === undefined ? [] : ['--fps']),
    ...(support.exportQuality || input.exportQuality === undefined ? [] : ['--quality']),
    ...(support.hideTouches || !input.hideTouchesRequested ? [] : ['--hide-touches']),
  ]);
}
