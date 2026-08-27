import { randomUUID } from 'node:crypto';
import type { CliFlags } from '@agent-device/contracts/command';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceClient } from '../../agent-device-client.ts';
import { resolvePublicInventoryDevice } from '../../core/device-selection-resolver.ts';
import type {
  HumanControlHold,
  HumanControlHoldInput,
} from '../../daemon/human-control-contract.ts';
import { writeCommandOutput } from './shared.ts';
import { createLocalHumanControlClient } from './takeover-client.ts';
import type { ClientCommandHandler } from './router-types.ts';

const FOREGROUND_HOLD_TTL_MS = 15_000;
const FOREGROUND_HEARTBEAT_MS = 5_000;
export const takeoverCommand: ClientCommandHandler = async ({ positionals, flags, client }) => {
  const action = positionals[0]?.toLowerCase();
  if (action === 'status') {
    if (positionals.length !== 1) {
      throw new AppError('INVALID_ARGS', 'takeover status does not accept additional arguments.');
    }
    await showTakeoverStatus(flags);
    return true;
  }
  if (action === 'release') {
    if (positionals.length !== 2 || !positionals[1]) {
      throw new AppError('INVALID_ARGS', 'takeover release requires a hold id.');
    }
    await releaseTakeover(flags, positionals[1]);
    return true;
  }
  if (positionals.length > 0) {
    throw new AppError('INVALID_ARGS', 'takeover accepts only: status or release <hold-id>.');
  }

  await runForegroundTakeover(flags, client);
  return true;
};

async function runForegroundTakeover(
  flags: CliFlags,
  agentDeviceClient: AgentDeviceClient,
): Promise<void> {
  const device = await resolveTakeoverDevice(agentDeviceClient, flags);
  const holdId = `takeover-${randomUUID()}`;
  const input = buildForegroundHoldInput(device);
  const client = await createLocalHumanControlClient(flags);
  const hold = await client.put(holdId, input);
  writeCommandOutput(flags, { hold, state: 'active' }, () => renderTakeoverStarted(hold));

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

async function resolveTakeoverDevice(
  client: AgentDeviceClient,
  flags: CliFlags,
): Promise<DeviceInfo> {
  return await resolvePublicInventoryDevice(client.devices, flags);
}

async function showTakeoverStatus(flags: CliFlags): Promise<void> {
  const holds = await (await createLocalHumanControlClient(flags)).list();
  writeCommandOutput(flags, { holds }, () => renderTakeoverStatus(holds));
}

async function releaseTakeover(flags: CliFlags, holdId: string): Promise<void> {
  const released = await (await createLocalHumanControlClient(flags)).remove(holdId);
  writeCommandOutput(flags, { holdId, released }, () =>
    released ? `Released human-control hold ${holdId}.` : `No active hold found for ${holdId}.`,
  );
}

function buildForegroundHoldInput(device: DeviceInfo): HumanControlHoldInput {
  return {
    scope: {
      deviceKey: device.id,
      deviceName: device.name,
      platform: publicPlatformString(device),
      kind: device.kind,
    },
    reason: 'Human is interacting with the simulator or device.',
    ttlMs: FOREGROUND_HOLD_TTL_MS,
  };
}

export function renderTakeoverStarted(hold: HumanControlHold): string {
  const target = hold.scope.deviceName
    ? `${hold.scope.deviceName} (${hold.scope.deviceKey})`
    : hold.scope.deviceKey;
  return [
    `Human control active for ${target}.`,
    'Agent interactions are paused. Press Ctrl+C to return control.',
    `Hold: ${hold.id}`,
  ].join('\n');
}

export function renderTakeoverStatus(holds: HumanControlHold[]): string {
  if (holds.length === 0) return 'No active human-control holds.';
  return [
    'Active human-control holds:',
    ...holds.map((hold) => {
      const target = hold.scope.deviceName
        ? `${hold.scope.deviceName} (${hold.scope.deviceKey})`
        : hold.scope.deviceKey;
      return `  ${hold.id}: ${target}`;
    }),
  ].join('\n');
}
