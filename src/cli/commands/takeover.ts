import { randomUUID } from 'node:crypto';
import type { CliFlags } from '@agent-device/contracts/command';
import type { HumanControlHold } from '@agent-device/contracts/client';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';
import { writeStdout } from '../process-exit.ts';

const FOREGROUND_HOLD_TTL_MS = 15_000;
const FOREGROUND_HEARTBEAT_MS = 5_000;
const LEASE_HOLD_TTL_MS = 60_000;
const LEASE_HOLD_REASON = 'A script outside agent-device is holding this device.';

export const takeoverCommand: ClientCommandHandler = async ({ positionals, flags, client }) => {
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
    await holdTakeover(flags, client);
    return true;
  }
  if (action === 'release') {
    if (positionals.length !== 2 || !positionals[1]) {
      throw new AppError('INVALID_ARGS', 'takeover release requires a hold id.');
    }
    await releaseTakeover(flags, client, positionals[1]);
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

async function holdTakeover(flags: CliFlags, agentDeviceClient: AgentDeviceClient): Promise<void> {
  const holdId = `takeover-${randomUUID()}`;
  const input = {
    reason: flags.reason?.trim() || LEASE_HOLD_REASON,
    ttlMs: flags.ttlMs ?? LEASE_HOLD_TTL_MS,
  };
  const hold = await agentDeviceClient.leases.humanControl.put(holdId, input);
  await writeCommandOutput(flags, { hold, state: 'active' }, () =>
    renderTakeoverHold(hold, flags.session),
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
  const { promise: stopped, resolve: finish } = Promise.withResolvers<void>();
  const stop = () => finish();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const heartbeat = setInterval(() => {
    if (heartbeatRequest) return;
    heartbeatRequest = client
      .put(holdId, input)
      .then(() => undefined)
      .catch((error: unknown) => {
        heartbeatError = error;
        finish();
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
    writeStdout(
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

export function renderTakeoverHold(hold: HumanControlHold, session?: string): string {
  const target = hold.scope.deviceKey;
  const sessionFlag = session
    ? session.startsWith('-')
      ? ` --session=${shellQuoteIfNeeded(session)}`
      : ` --session ${shellQuoteIfNeeded(session)}`
    : '';
  return [
    `Human control active for ${target}.`,
    `Agent interactions are paused. Release with: agent-device takeover release ${hold.id}${sessionFlag}`,
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
