import type { CliFlags } from '@agent-device/contracts/command';
import { AppError, throwDaemonError, toAppErrorCode } from '@agent-device/kernel/errors';
import { INTERNAL_COMMANDS } from '../../command-catalog.ts';
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

export type LocalHumanControlClient = {
  list(): Promise<HumanControlHold[]>;
  put(holdId: string, input: HumanControlHoldInput): Promise<HumanControlHold>;
  remove(holdId: string): Promise<boolean>;
};

export async function createLocalHumanControlClient(
  flags: CliFlags,
): Promise<LocalHumanControlClient> {
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
