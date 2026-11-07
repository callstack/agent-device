import { randomUUID } from 'node:crypto';
import type { CliFlags } from '@agent-device/contracts/command';
import type { HumanControlHold, HumanControlHoldScope } from '@agent-device/contracts/client';
import { leaseDeviceKey } from '@agent-device/contracts/lease-scope';
import { leaseBackendForPlatform } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { writeCommandOutput } from './shared.ts';
import {
  putHostHumanControlHold,
  removeHostHumanControlHold,
  resolveHostHoldAdmin,
} from './takeover-hold-admin.ts';
import type { ClientCommandHandler } from './router-types.ts';

const FOREGROUND_HOLD_TTL_MS = 15_000;
const FOREGROUND_HEARTBEAT_MS = 5_000;
const HOST_HOLD_TTL_MS = 60_000;
const HOST_HOLD_REASON = 'A script outside agent-device is holding this device.';
export const takeoverCommand: ClientCommandHandler = async ({
  positionals,
  flags,
  client,
  host,
}) => {
  const action = positionals[0]?.toLowerCase();
  if (action === 'status') {
    if (positionals.length !== 1) {
      throw new AppError('INVALID_ARGS', 'takeover status does not accept additional arguments.');
    }
    await showTakeoverStatus(flags, client);
    return true;
  }
  if (action === 'hold') {
    if (positionals.length !== 1) {
      throw new AppError('INVALID_ARGS', 'takeover hold does not accept positional arguments.');
    }
    await holdTakeover(flags, host, client);
    return true;
  }
  if (action === 'release') {
    if (positionals.length !== 2 || !positionals[1]) {
      throw new AppError('INVALID_ARGS', 'takeover release requires a hold id.');
    }
    if (hasLeaseScope(flags)) await releaseTakeover(flags, client, positionals[1]);
    else await releaseHostTakeover(flags, host, positionals[1]);
    return true;
  }
  if (positionals.length > 0) {
    throw new AppError(
      'INVALID_ARGS',
      'takeover accepts only: status, hold, or release <hold-id>.',
    );
  }

  await runForegroundTakeover(flags, client);
  return true;
};

function hasLeaseScope(flags: CliFlags): boolean {
  return (
    flags.session !== undefined ||
    flags.leaseId !== undefined ||
    flags.tenant !== undefined ||
    flags.runId !== undefined
  );
}

/**
 * The device a host hold pins: the exact `--device-key`, or the one device the
 * selectors resolve to, spelled the way the daemon spells a lease device key.
 */
async function resolveHoldScope(
  flags: CliFlags,
  agentDeviceClient: AgentDeviceClient,
): Promise<HumanControlHoldScope> {
  const selectors = hasDeviceSelector(flags);
  const deviceKey = flags.deviceKey?.trim();
  if (deviceKey && selectors) {
    throw new AppError(
      'INVALID_ARGS',
      'takeover hold accepts --device-key or device selectors, not both.',
      { reason: 'hold-device-double-named' },
    );
  }
  const backend = flags.leaseBackend ?? leaseBackendForPlatform(flags.platform);
  if (!backend) {
    throw new AppError(
      'INVALID_ARGS',
      'takeover hold requires --platform or --lease-backend to name the lease backend.',
      { reason: 'hold-backend-unnamed' },
    );
  }
  if (deviceKey) return { backend, deviceKey };
  return { backend, deviceKey: await resolveSelectedDeviceKey(flags, agentDeviceClient) };
}

function hasDeviceSelector(flags: CliFlags): boolean {
  return (
    flags.target !== undefined ||
    flags.device !== undefined ||
    flags.udid !== undefined ||
    flags.serial !== undefined
  );
}

async function resolveSelectedDeviceKey(
  flags: CliFlags,
  agentDeviceClient: AgentDeviceClient,
): Promise<string> {
  const devices = await agentDeviceClient.devices.list({
    platform: flags.platform,
    target: flags.target,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
  });
  if (devices.length !== 1) {
    throw new AppError(
      'INVALID_ARGS',
      devices.length === 0
        ? 'No device matches the takeover hold selectors.'
        : 'Several devices match the takeover hold selectors. Name one with --device-key.',
      { reason: 'hold-device-selection-ambiguous', matches: devices.length },
    );
  }
  const device = devices[0]!;
  return leaseDeviceKey({ platform: device.platform, target: device.target, id: device.id });
}

async function holdTakeover(
  flags: CliFlags,
  host: HostEnvironment,
  agentDeviceClient: AgentDeviceClient,
): Promise<void> {
  const scope = await resolveHoldScope(flags, agentDeviceClient);
  const holdId = `takeover-${randomUUID()}`;
  const input = {
    reason: flags.reason?.trim() || HOST_HOLD_REASON,
    ttlMs: flags.ttlMs ?? HOST_HOLD_TTL_MS,
  };
  const connection = await resolveHostHoldAdmin(flags, host);
  const hold = await putHostHumanControlHold({ connection, holdId, scope, input });
  await writeCommandOutput(flags, { hold, state: 'active' }, () => renderTakeoverHold(hold));
}

async function releaseHostTakeover(
  flags: CliFlags,
  host: HostEnvironment,
  holdId: string,
): Promise<void> {
  const connection = await resolveHostHoldAdmin(flags, host);
  const released = await removeHostHumanControlHold({ connection, holdId });
  await writeCommandOutput(flags, { holdId, released }, () =>
    released ? `Released human-control hold ${holdId}.` : `No active hold found for ${holdId}.`,
  );
}

async function runForegroundTakeover(
  flags: CliFlags,
  agentDeviceClient: AgentDeviceClient,
): Promise<void> {
  const holdId = `takeover-${randomUUID()}`;
  const input = {
    reason: 'Human is interacting with the simulator or device.',
    ttlMs: FOREGROUND_HOLD_TTL_MS,
  };
  const client = agentDeviceClient.leases.humanControl;
  const hold = await client.put(holdId, input);
  await writeCommandOutput(flags, { hold, state: 'active' }, () => renderTakeoverStarted(hold));

  let heartbeatError: unknown;
  let heartbeatRequest: Promise<void> | undefined;
  let released = false;
  let finish: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => finish?.();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const heartbeat = setInterval(() => {
    if (heartbeatRequest) return;
    heartbeatRequest = client
      .put(holdId, input)
      .then(() => undefined)
      .catch((error: unknown) => {
        heartbeatError = error;
        finish?.();
      })
      .finally(() => {
        heartbeatRequest = undefined;
      });
  }, FOREGROUND_HEARTBEAT_MS);

  try {
    await stopped;
  } finally {
    clearInterval(heartbeat);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await heartbeatRequest;
    released = await client.remove(holdId).catch(() => false);
  }
  if (heartbeatError) throw heartbeatError;
  if (!flags.json) {
    process.stdout.write(
      released
        ? 'Human control released. Agent interactions are enabled.\n'
        : 'Release could not be confirmed. The safety TTL will re-enable agent interactions automatically.\n',
    );
  }
}

async function showTakeoverStatus(flags: CliFlags, client: AgentDeviceClient): Promise<void> {
  const holds = await client.leases.humanControl.list();
  await writeCommandOutput(flags, { holds }, () => renderTakeoverStatus(holds));
}

async function releaseTakeover(
  flags: CliFlags,
  client: AgentDeviceClient,
  holdId: string,
): Promise<void> {
  const released = await client.leases.humanControl.remove(holdId);
  await writeCommandOutput(flags, { holdId, released }, () =>
    released ? `Released human-control hold ${holdId}.` : `No active hold found for ${holdId}.`,
  );
}

export function renderTakeoverStarted(hold: HumanControlHold): string {
  const target = hold.scope.deviceKey;
  return [
    `Human control active for ${target}.`,
    'Agent interactions are paused. Press Ctrl+C to return control.',
    `Hold: ${hold.id}`,
  ].join('\n');
}

export function renderTakeoverHold(hold: HumanControlHold): string {
  const target = hold.scope.deviceKey;
  return [
    `Human control active for ${target}.`,
    `Agent interactions are paused. Release with: agent-device takeover release ${hold.id}`,
    `Hold: ${hold.id}`,
  ].join('\n');
}

export function renderTakeoverStatus(holds: HumanControlHold[]): string {
  if (holds.length === 0) return 'No active human-control holds.';
  return [
    'Active human-control holds:',
    ...holds.map((hold) => {
      const target = hold.scope.deviceKey;
      return `  ${hold.id}: ${target}`;
    }),
  ].join('\n');
}
