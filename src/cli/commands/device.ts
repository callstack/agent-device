import { AppError } from '../../kernel/errors.ts';
import {
  inspectDeviceClaims,
  type InspectedDeviceClaim,
} from '../../daemon/device-claim-inspection.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

export const deviceCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  if (positionals[0] !== 'status' || positionals.length !== 1) {
    throw new AppError('INVALID_ARGS', 'device accepts only: status');
  }
  const claims = inspectDeviceClaims({
    platform: flags.platform,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
  }).map(serializeClaim);
  const data = { claims };
  writeCommandOutput(flags, data, () => renderDeviceStatus(claims));
  return true;
};

function serializeClaim(entry: InspectedDeviceClaim): Record<string, unknown> {
  const claim = entry.claim;
  return {
    ...(entry.deviceKey ? { deviceKey: entry.deviceKey } : {}),
    classification: entry.classification,
    ...(claim
      ? {
          device: claim.device,
          owner: {
            session: claim.session,
            workspace: claim.workspace,
            stateDir: claim.stateDir,
            pid: claim.ownerPid,
            startTime: claim.ownerStartTime,
          },
          recovery: {
            command: futureRecoveryCommand(claim.device.platform, claim.device.id),
          },
        }
      : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function futureRecoveryCommand(platform: string, id: string): string | undefined {
  if (platform === 'ios' || platform === 'macos') {
    return `agent-device device release --platform ${platform} --udid ${id} --stale`;
  }
  if (platform === 'android') {
    return `agent-device device release --platform android --serial ${id} --stale`;
  }
  return undefined;
}

function renderDeviceStatus(claims: Record<string, unknown>[]): string {
  if (claims.length === 0) return 'No local advisory device claims found.';
  return claims
    .map((claim) => {
      const device = claim.device as { platform?: string; id?: string; name?: string } | undefined;
      const owner = claim.owner as { session?: string; workspace?: string } | undefined;
      return [
        `${device?.platform ?? 'unknown'} ${device?.name ?? device?.id ?? claim.deviceKey ?? 'claim'}: ${claim.classification}`,
        owner ? `session=${owner.session} workspace=${owner.workspace}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' ');
    })
    .join('\n');
}
