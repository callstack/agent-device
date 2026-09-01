import type { CommandFlags } from '@agent-device/contracts/command';
import type { SettleParams } from '@agent-device/contracts/interaction';
import type { DaemonResponse } from '../../types.ts';
import { interactionErrorResponse } from './interaction-response.ts';

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
