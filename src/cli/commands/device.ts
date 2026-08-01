import { AppError } from '@agent-device/kernel/errors';
import {
  inspectDeviceClaims,
  type InspectedDeviceClaim,
} from '../../daemon/device-claim-inspection.ts';
import { shellQuoteIfNeeded } from '../../utils/shell-quote.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

export const deviceCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  if (positionals[0] !== 'status' || positionals.length !== 1) {
    throw new AppError('INVALID_ARGS', 'device accepts only: status');
  }
  const inspectedClaims = inspectDeviceClaims({
    platform: flags.platform,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
  });
  const staleClaims = inspectedClaims.filter(isStaleClaim);
  const claims = (
    flags.stale ? staleClaims : inspectedClaims.filter((claim) => !isStaleClaim(claim))
  ).map(serializeClaim);
  const data = {
    claims,
    ...(flags.stale ? {} : { hiddenStaleClaims: staleClaims.length }),
  };
  writeCommandOutput(flags, data, () =>
    renderDeviceStatus(claims, {
      staleOnly: flags.stale === true,
      hiddenStaleClaims: staleClaims.length,
      staleCommand: buildStaleInspectionCommand(flags),
    }),
  );
  return true;
};

function isStaleClaim(claim: InspectedDeviceClaim): boolean {
  return (
    claim.classification === 'owner-process-dead' || claim.classification === 'owner-state-dir-gone'
  );
}

function serializeClaim(entry: InspectedDeviceClaim): Record<string, unknown> {
  const claim = entry.claim;
  return {
    ...(entry.deviceKey ? { deviceKey: entry.deviceKey } : {}),
    ...(!claim ? { fileName: entry.fileName } : {}),
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
        }
      : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function renderDeviceStatus(
  claims: Record<string, unknown>[],
  options: { staleOnly: boolean; hiddenStaleClaims: number; staleCommand: string },
): string {
  const claimLines = claims.map(renderClaimLine);
  if (claimLines.length === 0) {
    if (options.staleOnly) return 'No stale local advisory device claims found.';
    if (options.hiddenStaleClaims === 0) return 'No local advisory device claims found.';
  }
  return [
    // Without this the all-stale case renders only the hidden-claim notice, so
    // the answer to "what holds this device" reads as a maintenance warning.
    ...(claimLines.length === 0 ? ['No live local advisory device claims found.'] : claimLines),
    !options.staleOnly && options.hiddenStaleClaims > 0
      ? `${options.hiddenStaleClaims} stale ${options.hiddenStaleClaims === 1 ? 'claim' : 'claims'} hidden; inspect with: ${options.staleCommand}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function renderClaimLine(claim: Record<string, unknown>): string {
  return `${renderClaimLabel(claim)}: ${claim.classification}${renderClaimOwner(claim.owner)}`;
}

function renderClaimLabel(claim: Record<string, unknown>): string {
  const device = claim.device as { platform?: string; id?: string; name?: string } | undefined;
  if (!device) return String(claim.deviceKey ?? claim.fileName ?? 'claim');
  return `${device.platform ?? 'unknown'} ${device.name ?? device.id ?? 'claim'}`;
}

function renderClaimOwner(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const owner = value as { session?: string; workspace?: string };
  return ` session=${owner.session} workspace=${owner.workspace}`;
}

function buildStaleInspectionCommand(flags: {
  platform?: string;
  device?: string;
  udid?: string;
  serial?: string;
}): string {
  const selectors = [
    flags.platform ? `--platform ${shellQuoteIfNeeded(flags.platform)}` : null,
    flags.device ? `--device ${shellQuoteIfNeeded(flags.device)}` : null,
    flags.udid ? `--udid ${shellQuoteIfNeeded(flags.udid)}` : null,
    flags.serial ? `--serial ${shellQuoteIfNeeded(flags.serial)}` : null,
  ].filter((part): part is string => Boolean(part));
  return ['agent-device device status', ...selectors, '--stale'].join(' ');
}
