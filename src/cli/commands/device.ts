import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';
import { AppError } from '@agent-device/kernel/errors';
import { publicPlatformString } from '@agent-device/kernel/device';
import {
  deviceClaimOwnerCannotRelease,
  deviceClaimRequiresStaleInspection,
  inspectDeviceClaims,
  type InspectedDeviceClaim,
  type DeviceClaimStaleReleaseOutcome,
} from '@agent-device/daemon-contracts/device-claims';
import {
  inspectDeviceAcquirability,
  type DeviceAcquirabilityBlockReason,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { writeCommandOutput } from './shared.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { ClientCommandHandler } from './router-types.ts';

// Loaded dynamically by dedicatedCliCommandHandlerLoaders in router.ts.
export const deviceCommand: ClientCommandHandler = async ({ positionals, flags, host }) => {
  if (positionals.length !== 1 || (positionals[0] !== 'status' && positionals[0] !== 'release')) {
    throw new AppError('INVALID_ARGS', 'device accepts only: status, release');
  }
  if (positionals[0] === 'release') return await runDeviceRelease(flags, host);
  const selectors = {
    platform: flags.platform,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
  };
  const inspectedClaims = inspectDeviceClaims(selectors, host.env);
  const hasSelector = Object.values(selectors).some((value) => value !== undefined);
  const staleClaims = inspectedClaims.filter((claim) =>
    deviceClaimRequiresStaleInspection(claim.classification),
  );
  const visible = flags.stale
    ? staleClaims
    : inspectedClaims.filter((claim) => !deviceClaimRequiresStaleInspection(claim.classification));
  const claims = visible.map(serializeClaim);
  const devices = await reportDeviceAcquirability(
    inspectedClaims,
    hasSelector ? inspectDeviceClaims({}, host.env) : inspectedClaims,
    host.env,
  );
  const data = {
    claims,
    ...(flags.stale ? {} : { hiddenStaleClaims: staleClaims.length }),
    devices,
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

type DeviceAcquirabilityReport = {
  deviceKey: string;
  device: Record<string, unknown>;
  acquirable: boolean;
  /** Why a new session cannot take it now, and the holder to act on; absent when it can. */
  blockedBy?: DeviceAcquirabilityBlockReason;
  owner?: { session: string; workspace: string; stateDir: string };
};

/**
 * Whether a new session can take each device a selected claim names, weighed against every claim on
 * the host, as `open` does, so a selector that hides a host's or an app's claim never hides its
 * owner. One entry per device, in inspection order.
 *
 * Every device a claim names is reported, including one whose only claims are the stale ones this
 * view hides: their owner being reclaimable is exactly why they are hidden, and a caller choosing a
 * device needs that answer without asking for the hidden records. A device no claim names is
 * acquirable and absent; `agent-device devices` is what enumerates devices.
 */
async function reportDeviceAcquirability(
  inspectedClaims: readonly InspectedDeviceClaim[],
  weighedClaims: readonly InspectedDeviceClaim[],
  env: EnvMap,
): Promise<DeviceAcquirabilityReport[]> {
  const reports: DeviceAcquirabilityReport[] = [];
  const seen = new Set<string>();
  for (const entry of inspectedClaims) {
    const deviceKey = entry.deviceKey;
    const device = entry.claim?.device;
    if (!deviceKey || !device || seen.has(deviceKey)) continue;
    seen.add(deviceKey);
    const acquirability = await inspectDeviceAcquirability({
      device,
      claims: weighedClaims,
      env,
    });
    const holder = acquirability.claim;
    reports.push({
      deviceKey,
      device: serializeClaimDevice(device),
      acquirable: acquirability.acquirable,
      ...(acquirability.blockedBy ? { blockedBy: acquirability.blockedBy } : {}),
      ...(holder?.session
        ? {
            owner: {
              session: holder.session,
              workspace: holder.workspace ?? '',
              stateDir: holder.stateDir ?? '',
            },
          }
        : {}),
    });
  }
  return reports;
}

/**
 * `device release --stale`: settle and clear matching claims whose owner
 * provably cannot release them. Everything else fails closed and is reported
 * with the reason, so a live or uncertain owner is never interrupted.
 */
async function runDeviceRelease(flags: CliFlags, host: HostEnvironment): Promise<boolean> {
  if (flags.stale !== true) {
    throw new AppError(
      'INVALID_ARGS',
      'device release only releases provably stale claims; pass --stale to confirm.',
      {
        hint: 'A live owner is released by closing its session from its own workspace, or by stopping its daemon: agent-device daemon stop --state-dir <owner state dir>.',
      },
    );
  }
  const { runStaleDeviceClaimRelease } = await import('../../platform-runtime-claim-recovery.ts');
  const outcomes = await runStaleDeviceClaimRelease(
    {
      platform: flags.platform,
      device: flags.device,
      udid: flags.udid,
      serial: flags.serial,
    },
    host,
  );
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
  const owner = renderOutcomeOwner(outcome);
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

function renderOutcomeOwner(outcome: DeviceClaimStaleReleaseOutcome): string {
  return outcome.session ? ` session=${outcome.session} workspace=${outcome.workspace}` : '';
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
  const record = entry.claim;
  return {
    ...(entry.deviceKey ? { deviceKey: entry.deviceKey } : {}),
    ...(!record ? { fileName: entry.fileName } : {}),
    classification: entry.classification,
    ...(record ? { device: serializeClaimDevice(record.device) } : {}),
    ...(entry.claim
      ? {
          owner: {
            session: entry.claim.session,
            workspace: entry.claim.workspace,
            stateDir: entry.claim.stateDir,
            pid: entry.claim.ownerPid,
            startTime: entry.claim.ownerStartTime,
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
