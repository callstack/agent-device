import { AppError } from '@agent-device/kernel/errors';
import { publicPlatformString } from '@agent-device/kernel/device';
import {
  deviceClaimOwnerCannotRelease,
  deviceClaimRequiresStaleInspection,
  inspectDeviceClaims,
  type InspectedDeviceClaim,
} from '../../daemon/device-claim-inspection.ts';
import type { DeviceClaimStaleReleaseOutcome } from '../../daemon/device-claims.ts';
import { shellQuoteIfNeeded } from '@agent-device/host-kit/command';
import { writeCommandOutput } from './shared.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { ClientCommandHandler } from './router-types.ts';

// Loaded dynamically by dedicatedCliCommandHandlerLoaders in router.ts.
export const deviceCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  if (positionals.length !== 1 || (positionals[0] !== 'status' && positionals[0] !== 'release')) {
    throw new AppError('INVALID_ARGS', 'device accepts only: status, release');
  }
  if (positionals[0] === 'release') return await runDeviceRelease(flags);
  const inspectedClaims = inspectDeviceClaims({
    platform: flags.platform,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
  });
  const staleClaims = inspectedClaims.filter((claim) =>
    deviceClaimRequiresStaleInspection(claim.classification),
  );
  const claims = (
    flags.stale
      ? staleClaims
      : inspectedClaims.filter((claim) => !deviceClaimRequiresStaleInspection(claim.classification))
  ).map(serializeClaim);
  const data = {
    claims,
    ...(flags.stale ? {} : { hiddenStaleClaims: staleClaims.length }),
  };
  await writeCommandOutput(flags, data, () =>
    renderDeviceStatus(claims, {
      staleOnly: flags.stale === true,
      hiddenStaleClaims: staleClaims.length,
      staleCommand: buildStaleInspectionCommand(flags, 'status'),
      releasableClaims: staleClaims.filter((claim) =>
        deviceClaimOwnerCannotRelease(claim.classification),
      ).length,
      releaseCommand: buildStaleInspectionCommand(flags, 'release'),
    }),
  );
  return true;
};

/**
 * `device release --stale`: settle and clear matching claims whose owner
 * provably cannot release them. Everything else fails closed and is reported
 * with the reason, so a live or uncertain owner is never interrupted.
 */
async function runDeviceRelease(flags: CliFlags): Promise<boolean> {
  if (flags.stale !== true) {
    throw new AppError(
      'INVALID_ARGS',
      'device release only releases provably stale claims; pass --stale to confirm.',
      {
        hint: 'A live owner is released by closing its session from its own workspace, or by stopping its daemon: agent-device daemon stop --state-dir <owner state dir>.',
      },
    );
  }
  const { runStaleDeviceClaimRelease } = await import('./device-release.ts');
  const outcomes = await runStaleDeviceClaimRelease({
    platform: flags.platform,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
  });
  const data = {
    released: outcomes.filter((outcome) => outcome.status === 'released').map(serializeOutcome),
    retained: outcomes.filter((outcome) => outcome.status === 'retained').map(serializeOutcome),
    refused: outcomes.filter((outcome) => outcome.status === 'refused').map(serializeOutcome),
    changed: outcomes.filter((outcome) => outcome.status === 'changed').map(serializeOutcome),
  };
  await writeCommandOutput(flags, data, () => renderDeviceRelease(outcomes));
  return true;
}

function serializeOutcome(outcome: DeviceClaimStaleReleaseOutcome): Record<string, unknown> {
  const { device, ...rest } = outcome;
  return {
    ...rest,
    ...(device ? { device: serializeClaimDevice(device) } : {}),
  };
}

function renderDeviceRelease(outcomes: DeviceClaimStaleReleaseOutcome[]): string {
  if (outcomes.length === 0) return 'No local device claims matched.';
  return outcomes.map(renderReleaseOutcomeLine).join('\n');
}

function renderReleaseOutcomeLine(outcome: DeviceClaimStaleReleaseOutcome): string {
  const label = outcome.device
    ? `${publicPlatformString({ platform: outcome.device.family, appleOs: outcome.device.appleOs })} ${outcome.device.name}`
    : (outcome.deviceKey ?? outcome.fileName);
  const owner = outcome.session ? ` session=${outcome.session} workspace=${outcome.workspace}` : '';
  switch (outcome.status) {
    case 'released':
      return `released ${label}${owner}`;
    case 'retained':
      return `retained ${label}${owner} — resources not settled (${outcome.reason}); the claim stays until they are.`;
    case 'refused':
      return `refused ${label}${owner} — ${outcome.reason} (${outcome.classification}); ${releaseRefusalHint(outcome)}`;
    case 'changed':
      return `changed ${label} — the claim changed while releasing; re-run device status.`;
  }
}

function releaseRefusalHint(outcome: DeviceClaimStaleReleaseOutcome): string {
  if (outcome.classification === 'live' || outcome.classification === 'owner-state-dir-gone') {
    return outcome.stateDir
      ? `close the owning session from its workspace, or stop its daemon: agent-device daemon stop --state-dir ${shellQuoteIfNeeded(outcome.stateDir)}`
      : 'close the owning session from its workspace first.';
  }
  return 'only provably dead owners are released; nothing was changed.';
}

function serializeClaim(entry: InspectedDeviceClaim): Record<string, unknown> {
  const claim = entry.claim;
  return {
    ...(entry.deviceKey ? { deviceKey: entry.deviceKey } : {}),
    ...(!claim ? { fileName: entry.fileName } : {}),
    classification: entry.classification,
    ...(claim
      ? {
          device: serializeClaimDevice(claim.device),
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

function serializeClaimDevice(device: NonNullable<InspectedDeviceClaim['claim']>['device']) {
  const { family, ...rest } = device;
  return {
    ...rest,
    platform: publicPlatformString({ platform: family, appleOs: device.appleOs }),
  };
}

type DeviceStatusRenderOptions = {
  staleOnly: boolean;
  hiddenStaleClaims: number;
  staleCommand: string;
  releasableClaims: number;
  releaseCommand: string;
};

function renderDeviceStatus(
  claims: Record<string, unknown>[],
  options: DeviceStatusRenderOptions,
): string {
  const claimLines = claims.map(renderClaimLine);
  if (claimLines.length === 0) {
    if (options.staleOnly) return 'No stale local device claims found.';
    if (options.hiddenStaleClaims === 0) return 'No local device claims found.';
  }
  return [
    // Without this the all-stale case renders only the hidden-claim notice, so
    // the answer to "what holds this device" reads as a maintenance warning.
    ...(claimLines.length === 0 ? ['No live local device claims found.'] : claimLines),
    ...deviceStatusNoticeLines(options),
  ].join('\n');
}

function deviceStatusNoticeLines(options: DeviceStatusRenderOptions): string[] {
  if (options.staleOnly) {
    return options.releasableClaims > 0
      ? [`Release provably dead owners with: ${options.releaseCommand}`]
      : [];
  }
  if (options.hiddenStaleClaims === 0) return [];
  const noun = options.hiddenStaleClaims === 1 ? 'claim' : 'claims';
  return [
    `${options.hiddenStaleClaims} stale ${noun} hidden; inspect with: ${options.staleCommand}`,
  ];
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

function buildStaleInspectionCommand(
  flags: {
    platform?: string;
    device?: string;
    udid?: string;
    serial?: string;
  },
  subcommand: 'status' | 'release',
): string {
  const selectors = [
    flags.platform ? `--platform ${shellQuoteIfNeeded(flags.platform)}` : null,
    flags.device ? `--device ${shellQuoteIfNeeded(flags.device)}` : null,
    flags.udid ? `--udid ${shellQuoteIfNeeded(flags.udid)}` : null,
    flags.serial ? `--serial ${shellQuoteIfNeeded(flags.serial)}` : null,
  ].filter((part): part is string => Boolean(part));
  return [`agent-device device ${subcommand}`, ...selectors, '--stale'].join(' ');
}
