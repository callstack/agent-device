export const RECORDING_SCOPE_VALUES = ['app', 'device', 'system'] as const;

/** Shared trace command grammar for handler and composite admission. */
export function parseTraceAction(
  positionals: readonly string[] | undefined,
): 'start' | 'stop' | undefined {
  const action = (positionals?.[0] ?? '').toLowerCase();
  if (action === 'start' || action === 'stop') return action;
  return undefined;
}

export type RecordingScope = (typeof RECORDING_SCOPE_VALUES)[number];

export function isRecordingScope(value: unknown): value is RecordingScope {
  return RECORDING_SCOPE_VALUES.some((scope) => scope === value);
}

export function isWholeScreenRecordingScope(scope: RecordingScope): boolean {
  return scope === 'device' || scope === 'system';
}
