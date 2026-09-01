import type { CommandFlags } from '@agent-device/contracts/command';
import type { SettleParams } from '@agent-device/contracts/interaction';
import type { DaemonResponse } from '../../types.ts';
import { interactionErrorResponse } from './interaction-response.ts';

const REF_UNSUPPORTED_FLAG_MAP: ReadonlyArray<[keyof CommandFlags, string]> = [
  ['snapshotDepth', '--depth'],
  ['snapshotScope', '--scope'],
  ['snapshotRaw', '--raw'],
];

export function refSnapshotFlagGuardResponse(
  command: 'press' | 'fill' | 'get' | 'longpress' | 'hover',
  flags: CommandFlags | undefined,
): DaemonResponse | null {
  const unsupported = unsupportedRefSnapshotFlags(flags);
  if (unsupported.length === 0) return null;
  return interactionErrorResponse(
    'INVALID_ARGS',
    `${command} @ref does not support ${unsupported.join(', ')}.`,
  );
}

export function unsupportedRefSnapshotFlags(flags: CommandFlags | undefined): string[] {
  if (!flags) return [];
  const unsupported: string[] = [];
  for (const [key, label] of REF_UNSUPPORTED_FLAG_MAP) {
    if (flags[key] !== undefined) unsupported.push(label);
  }
  return unsupported;
}

export function settleFlagGuardResponse(
  command: string,
  flags: CommandFlags | undefined,
): DaemonResponse | null {
  if (!flags || flags.settle === true) return null;
  const orphaned: string[] = [];
  if (flags.settleQuietMs !== undefined) orphaned.push('--settle-quiet');
  if (orphaned.length === 0) return null;
  return interactionErrorResponse(
    'INVALID_ARGS',
    `${command}: ${orphaned.join(', ')} require${orphaned.length === 1 ? 's' : ''} --settle.`,
  );
}

export function readSettleRequest(flags: CommandFlags | undefined): SettleParams | undefined {
  if (flags?.settle !== true) return undefined;
  return {
    ...(flags.settleQuietMs !== undefined ? { quietMs: flags.settleQuietMs } : {}),
    ...(flags.timeoutMs !== undefined ? { timeoutMs: flags.timeoutMs } : {}),
  };
}
