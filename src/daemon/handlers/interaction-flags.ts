import type { CommandFlags } from '../../core/dispatch.ts';
import type { PostActionObservationCommandName } from '../../core/command-descriptor/post-action-observation.ts';
import type { SettleParams } from '../../contracts/interaction.ts';
import type { DaemonResponse } from '../types.ts';
import { errorResponse } from './response.ts';

const REF_UNSUPPORTED_FLAG_MAP: ReadonlyArray<[keyof CommandFlags, string]> = [
  ['snapshotDepth', '--depth'],
  ['snapshotScope', '--scope'],
  ['snapshotRaw', '--raw'],
];

export function refSnapshotFlagGuardResponse(
  command: 'press' | 'fill' | 'get' | 'longpress',
  flags: CommandFlags | undefined,
): DaemonResponse | null {
  const unsupported = unsupportedRefSnapshotFlags(flags);
  if (unsupported.length === 0) return null;
  return errorResponse(
    'INVALID_ARGS',
    `${command} @ref does not support ${unsupported.join(', ')}.`,
  );
}

export type RefSnapshotFlagGuardResponse = typeof refSnapshotFlagGuardResponse;

export function unsupportedRefSnapshotFlags(flags: CommandFlags | undefined): string[] {
  if (!flags) return [];
  const unsupported: string[] = [];
  for (const [key, label] of REF_UNSUPPORTED_FLAG_MAP) {
    if (flags[key] !== undefined) unsupported.push(label);
  }
  return unsupported;
}

/**
 * `--settle` (#1101) flag grammar for commands carrying the descriptor
 * post-action observation trait: `--settle` opts in, `--settle-quiet <ms>`
 * overrides the quiet window, and `--timeout <ms>` bounds the settle wait (the
 * same budget the descriptor's flag-sourced timeout policy widens the request
 * envelope past, mirroring wait's positional budget). Preserve compatibility
 * for a bare `--timeout` without `--settle`: older touch commands silently
 * ignored it. Only `--settle-quiet` is settle-specific enough to reject when
 * orphaned.
 */
export function settleFlagGuardResponse(
  command: PostActionObservationCommandName,
  flags: CommandFlags | undefined,
): DaemonResponse | null {
  if (!flags || flags.settle === true) return null;
  const orphaned: string[] = [];
  if (flags.settleQuietMs !== undefined) orphaned.push('--settle-quiet');
  if (orphaned.length === 0) return null;
  return errorResponse(
    'INVALID_ARGS',
    `${command}: ${orphaned.join(', ')} require${orphaned.length === 1 ? 's' : ''} --settle.`,
  );
}

/** The runtime settle request for a command's flags, or undefined without --settle. */
export function readSettleRequest(flags: CommandFlags | undefined): SettleParams | undefined {
  if (flags?.settle !== true) return undefined;
  return {
    ...(flags.settleQuietMs !== undefined ? { quietMs: flags.settleQuietMs } : {}),
    ...(flags.timeoutMs !== undefined ? { timeoutMs: flags.timeoutMs } : {}),
  };
}
