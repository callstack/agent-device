import { randomUUID } from 'node:crypto';
import type { CliFlags } from '@agent-device/contracts/command';
import { publicPlatformString, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, throwDaemonError, toAppErrorCode } from '@agent-device/kernel/errors';
import type { AgentDeviceClient } from '../../agent-device-client.ts';
import { INTERNAL_COMMANDS } from '../../command-catalog.ts';
import { resolvePublicInventoryDevice } from '../../core/device-selection-resolver.ts';
import {
  ensureDaemon,
  resolveClientSettings,
} from '../../daemon/client/daemon-client-lifecycle.ts';
import { sendRequest } from '../../daemon/client/daemon-client-transport.ts';
import { buildDaemonHttpAuthHeaders } from '../../daemon/http-contract.ts';
import type {
  HumanControlHold,
  HumanControlHoldInput,
} from '../../daemon/human-control-contract.ts';
import { HUMAN_CONTROL_HTTP_PREFIX } from '../../daemon/human-control.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

const FOREGROUND_HOLD_TTL_MS = 15_000;
const FOREGROUND_HEARTBEAT_MS = 5_000;
const HUMAN_CONTROL_REQUEST_TIMEOUT_MS = 20_000;

type HumanControlListResponse = {
  ok: boolean;
  holds?: HumanControlHold[];
  error?: string;
  code?: string;
};

type HumanControlMutationResponse = {
  ok: boolean;
  hold?: HumanControlHold;
  released?: boolean;
  error?: string;
  code?: string;
};

type LocalHumanControlClient = {
  list(): Promise<HumanControlHold[]>;
  put(holdId: string, input: HumanControlHoldInput): Promise<HumanControlHold>;
  remove(holdId: string): Promise<boolean>;
};

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

async function createLocalHumanControlClient(flags: CliFlags): Promise<LocalHumanControlClient> {
  const settings = resolveClientSettings({
    session: 'default',
    command: 'takeover',
    positionals: [],
    flags: {
      stateDir: flags.stateDir,
      daemonBaseUrl: '',
      daemonTransport: 'auto',
    },
  });
  const daemon = await ensureDaemon(settings);
  if (daemon.info.port) {
    const run = async (positionals: string[]): Promise<Record<string, unknown>> => {
      const response = await sendRequest(
        daemon.info,
        {
          token: daemon.info.token,
          session: 'default',
          command: INTERNAL_COMMANDS.humanControl,
          positionals,
          flags: { stateDir: flags.stateDir },
        },
        'socket',
        settings.paths,
        HUMAN_CONTROL_REQUEST_TIMEOUT_MS,
      );
      if (!response.ok) throwDaemonError(response.error);
      return response.data ?? {};
    };
    return {
      list: async () => readHolds(await run(['list'])),
      put: async (holdId, input) => readHold(await run(['put', holdId, JSON.stringify(input)])),
      remove: async (holdId) => (await run(['remove', holdId])).released === true,
    };
  }
  if (!daemon.info.httpPort) {
    throw new AppError('COMMAND_FAILED', 'Local daemon management endpoint is unavailable.');
  }
  return createHttpHumanControlClient(daemon.info.httpPort, daemon.info.token);
}

function createHttpHumanControlClient(httpPort: number, token: string): LocalHumanControlClient {
  const baseUrl = `http://127.0.0.1:${String(httpPort)}`;
  const headers = {
    ...buildDaemonHttpAuthHeaders(token),
    'content-type': 'application/json',
  };
  return {
    list: async () => {
      const response = await requestHumanControl<HumanControlListResponse>(
        `${baseUrl}${HUMAN_CONTROL_HTTP_PREFIX}`,
        { headers },
      );
      return response.holds ?? [];
    },
    put: async (holdId, input) => {
      const response = await requestHumanControl<HumanControlMutationResponse>(
        holdUrl(baseUrl, holdId),
        { method: 'PUT', headers, body: JSON.stringify(input) },
      );
      if (!response.hold) {
        throw new AppError('COMMAND_FAILED', 'Daemon did not return the human-control hold.');
      }
      return response.hold;
    },
    remove: async (holdId) => {
      const response = await requestHumanControl<HumanControlMutationResponse>(
        holdUrl(baseUrl, holdId),
        { method: 'DELETE', headers },
      );
      return response.released === true;
    },
  };
}

function readHolds(data: Record<string, unknown>): HumanControlHold[] {
  return Array.isArray(data.holds) ? (data.holds as HumanControlHold[]) : [];
}

function readHold(data: Record<string, unknown>): HumanControlHold {
  if (!data.hold || typeof data.hold !== 'object' || Array.isArray(data.hold)) {
    throw new AppError('COMMAND_FAILED', 'Daemon did not return the human-control hold.');
  }
  return data.hold as HumanControlHold;
}

async function requestHumanControl<T extends { ok: boolean; error?: string; code?: string }>(
  url: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(HUMAN_CONTROL_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to reach the local daemon human-control endpoint.',
      undefined,
      error,
    );
  }
  let payload: T;
  try {
    payload = (await response.json()) as T;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Local daemon returned an invalid human-control response (${String(response.status)}).`,
      undefined,
      error,
    );
  }
  if (!response.ok || !payload.ok) {
    throw new AppError(
      toAppErrorCode(payload.code),
      payload.error ?? `Human-control request failed (${String(response.status)}).`,
    );
  }
  return payload;
}

function holdUrl(baseUrl: string, holdId: string): string {
  return `${baseUrl}${HUMAN_CONTROL_HTTP_PREFIX}/${encodeURIComponent(holdId)}`;
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
