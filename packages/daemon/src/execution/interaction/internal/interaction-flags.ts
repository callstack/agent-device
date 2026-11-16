import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { isOutdatedObservation, refFrameState, refFrameTree } from '../../../core/ref-frame.ts';
import type { SessionState } from '../../../core/session-state.ts';
import type { SettleParams } from '@agent-device/contracts/interaction';
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

const ADAPTIVE_SETTLE_ENV = 'AGENT_DEVICE_SETTLE_ADAPTIVE';

/**
 * The session's observation still describes the screen: the ref frame is active (no side-effect
 * seam expired it), no native read marked its tree outdated (`wait text`), and no newer
 * observation replaced it (an Android freshness capture).
 */
function isObservationCurrent(session: SessionState): boolean {
  const tree = refFrameTree(session);
  return (
    refFrameState(session) === 'active' &&
    tree !== undefined &&
    session.snapshot === tree &&
    !isOutdatedObservation(tree)
  );
}

/**
 * The settle request a command carries. `host` selects the internal adaptive confirmation prototype
 * through the daemon host environment and nothing else. Read it before the action dispatches: the
 * dispatch expires the ref frame, and the prototype asks whether the observation was current before
 * it.
 */
export function readSettleRequest(
  flags: CommandFlags | undefined,
  host?: { env: Readonly<EnvMap>; session: SessionState | undefined },
): SettleParams | undefined {
  if (flags?.settle !== true) return undefined;
  const adaptive = host?.env[ADAPTIVE_SETTLE_ENV] === '1';
  return {
    ...(flags.settleQuietMs !== undefined ? { quietMs: flags.settleQuietMs } : {}),
    ...(flags.timeoutMs !== undefined ? { timeoutMs: flags.timeoutMs } : {}),
    ...(adaptive
      ? {
          earlyExit: 'adaptive' as const,
          observationCurrent: host.session !== undefined && isObservationCurrent(host.session),
        }
      : {}),
  };
}
