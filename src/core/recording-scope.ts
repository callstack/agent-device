export const RECORDING_SCOPE_VALUES = ['app', 'device', 'system'] as const;

export type RecordingScope = (typeof RECORDING_SCOPE_VALUES)[number];

export function isWholeScreenRecordingScope(scope: RecordingScope): boolean {
  return scope === 'device' || scope === 'system';
}
