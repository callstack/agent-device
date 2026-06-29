import { AppError } from '../../kernel/errors.ts';
import type { AndroidNativePerfKind } from './perf-native-types.ts';

export function annotateAndroidNativePerfError(
  action: 'start' | 'stop' | 'report',
  tool: AndroidNativePerfKind,
  packageName: string,
  error: unknown,
): AppError {
  if (error instanceof AppError) {
    const details = error.details ?? {};
    return new AppError(
      error.code,
      error.message,
      {
        ...details,
        action,
        package: packageName,
        tool,
        hint:
          typeof details.hint === 'string'
            ? details.hint
            : classifyAndroidNativePerfHint(tool, details),
      },
      error,
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `Failed to ${action} Android ${tool} for ${packageName}`,
    {
      action,
      package: packageName,
      tool,
      hint: buildAndroidNativePerfHint(tool),
    },
    error,
  );
}

function buildAndroidNativePerfHint(tool: AndroidNativePerfKind): string {
  return tool === 'simpleperf'
    ? 'Verify simpleperf is available, the app process is running, and the app/device permits native CPU profiling.'
    : 'Verify perfetto is available, the app process is running, and the device permits trace capture.';
}

export function buildAndroidNativeToolUnavailableHint(tool: AndroidNativePerfKind): string {
  return tool === 'simpleperf'
    ? 'Use an emulator/system image with simpleperf available, or install the Android NDK simpleperf binary for this device.'
    : 'Use Android 10+ or a system image that exposes the perfetto command-line binary.';
}

function classifyAndroidNativePerfHint(
  tool: AndroidNativePerfKind,
  details: Record<string, unknown>,
): string {
  const stderr = typeof details.stderr === 'string' ? details.stderr : '';
  const text = stderr.toLowerCase();
  if (tool === 'simpleperf') return classifySimpleperfHint(text);
  if (hasPerfettoPermissionError(text)) {
    return 'Use a device image that permits perfetto trace capture for shell, keep the app running, then retry perf trace start.';
  }
  return buildAndroidNativePerfHint(tool);
}

function classifySimpleperfHint(text: string): string {
  if (hasSimpleperfProfileabilityError(text)) {
    return 'Use a debuggable/profileable Android app or a device image that permits simpleperf for the target process, then retry perf cpu profile start.';
  }
  if (text.includes('not supported') || text.includes('failed to open perf event')) {
    return 'This device image does not expose the requested simpleperf event for the app process. Try a different emulator/system image or a profileable app.';
  }
  return buildAndroidNativePerfHint('simpleperf');
}

function hasSimpleperfProfileabilityError(text: string): boolean {
  return (
    text.includes('permission denied') ||
    text.includes('not profileable') ||
    text.includes('profileable')
  );
}

function hasPerfettoPermissionError(text: string): boolean {
  return text.includes('permission denied') || text.includes('not allowed');
}
