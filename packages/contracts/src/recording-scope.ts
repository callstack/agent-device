export const RECORDING_SCOPE_VALUES = ['app', 'device', 'system'] as const;

export type RecordingScope = (typeof RECORDING_SCOPE_VALUES)[number];

export function isRecordingScope(value: unknown): value is RecordingScope {
  return RECORDING_SCOPE_VALUES.some((scope) => scope === value);
}

export function isWholeScreenRecordingScope(scope: RecordingScope): boolean {
  return scope === 'device' || scope === 'system';
}
