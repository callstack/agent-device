import type { CommandFlags } from '@agent-device/contracts/command';
import type { DaemonResponse } from './types.ts';
import { errorResponse } from './response.ts';

const REF_UNSUPPORTED_FLAG_MAP: ReadonlyArray<[keyof CommandFlags, string]> = [
  ['snapshotDepth', '--depth'],
  ['snapshotScope', '--scope'],
  ['snapshotRaw', '--raw'],
];

export function refSnapshotFlagGuardResponse(
  command: 'press' | 'fill' | 'get' | 'longpress' | 'hover',
  flags: CommandFlags | undefined,
): DaemonResponse | null {
  const unsupported = REF_UNSUPPORTED_FLAG_MAP.filter(([key]) => flags?.[key] !== undefined).map(
    ([, label]) => label,
  );
  if (unsupported.length === 0) return null;
  return errorResponse(
    'INVALID_ARGS',
    `${command} @ref does not support ${unsupported.join(', ')}.`,
  );
}
