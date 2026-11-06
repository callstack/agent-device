import { buildDaemonHttpAuthHeaders } from '@agent-device/contracts/daemon-http';
import type {
  HumanControlHold,
  HumanControlHoldOptions,
  HumanControlHoldScope,
} from '@agent-device/contracts/client';
import type { CliFlags } from '@agent-device/contracts/command';
import { normalizeHumanControlHold } from '@agent-device/client';
import { readRegisteredDaemon } from '@agent-device/daemon-client';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { AppError, toAppErrorCode } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  loadNodeHttpRequester,
  readNodeHttpResponseBody,
  type NodeHttpRequester,
} from '@agent-device/host-kit/transport';

const HOST_HOLD_HTTP_TIMEOUT_MS = 10_000;

/** The daemon host-admin surface `takeover hold` and host `takeover release` ride. */
export type HostHoldAdminConnection = {
  baseUrl: string;
  token?: string;
};

export type HostHoldAdminRequester = Pick<NodeHttpRequester, 'request'>;

/**
 * Names the daemon a host hold rides: the explicit base URL and token when the
 * operator passed them, else the local daemon's loopback HTTP listener and its
 * own token. It never starts a daemon; a hold must outlive this one command.
 */
export async function resolveHostHoldAdmin(
  flags: CliFlags,
  host: HostEnvironment,
): Promise<HostHoldAdminConnection> {
  const baseUrl = flags.daemonBaseUrl?.trim().replace(/\/+$/, '');
  if (baseUrl !== undefined && baseUrl !== '') {
    assertHttpBaseUrl(baseUrl);
    const token = flags.daemonAuthToken?.trim();
    return { baseUrl, ...(token ? { token } : {}) };
  }
  const paths = resolveDaemonPaths(flags.stateDir, { env: host.env, cwd: host.cwd });
  const info = await readRegisteredDaemon(paths);
  if (!info) {
    throw new AppError('COMMAND_FAILED', `No daemon is registered in ${paths.baseDir}.`, {
      reason: 'daemon-not-running',
      stateDir: paths.baseDir,
      hint: 'Run any agent-device command once to start the local daemon, or pass --daemon-base-url and --daemon-auth-token.',
    });
  }
  if (!info.httpPort) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'The local daemon has no HTTP listener for the host hold API.',
      {
        reason: 'daemon-http-listener-missing',
        ...(info.transport ? { transport: info.transport } : {}),
        hint: 'Start the daemon with --daemon-server-mode http or dual, or pass --daemon-base-url and --daemon-auth-token.',
      },
    );
  }
  return { baseUrl: `http://127.0.0.1:${info.httpPort}`, token: info.token };
}

export async function putHostHumanControlHold(params: {
  connection: HostHoldAdminConnection;
  holdId: string;
  scope: HumanControlHoldScope;
  input: HumanControlHoldOptions;
  requester?: HostHoldAdminRequester;
}): Promise<HumanControlHold> {
  const { connection, holdId } = params;
  const url = new URL(
    `${connection.baseUrl}/admin/human-control/holds/${encodeURIComponent(holdId)}`,
  );
  const response = await requestJson({
    method: 'PUT',
    url,
    token: connection.token,
    body: { scope: params.scope, ...params.input },
    requester: params.requester,
  });
  return normalizeHumanControlHold(response.hold);
}

export async function removeHostHumanControlHold(params: {
  connection: HostHoldAdminConnection;
  holdId: string;
  requester?: HostHoldAdminRequester;
}): Promise<boolean> {
  const { connection, holdId } = params;
  const url = new URL(
    `${connection.baseUrl}/admin/human-control/holds/${encodeURIComponent(holdId)}`,
  );
  const response = await requestJson({
    method: 'DELETE',
    url,
    token: connection.token,
    requester: params.requester,
  });
  return response.released === true;
}

function assertHttpBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AppError('INVALID_ARGS', '--daemon-base-url must be a valid URL.', {
      reason: 'daemon-base-url-invalid',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('INVALID_ARGS', '--daemon-base-url must be an http or https URL.', {
      reason: 'daemon-base-url-invalid',
    });
  }
}

async function requestJson(params: {
  method: 'PUT' | 'DELETE';
  url: URL;
  token?: string;
  body?: unknown;
  requester?: HostHoldAdminRequester;
}): Promise<Record<string, unknown>> {
  const requester = params.requester ?? (await loadNodeHttpRequester(params.url.protocol));
  const body = params.body === undefined ? undefined : JSON.stringify(params.body);
  const { status, raw } = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
    const request = requester.request(
      {
        protocol: params.url.protocol,
        host: params.url.hostname,
        ...(params.url.port ? { port: Number(params.url.port) } : {}),
        path: `${params.url.pathname}${params.url.search}`,
        method: params.method,
        headers: {
          ...buildDaemonHttpAuthHeaders(params.token),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
        },
      },
      (response) => {
        readNodeHttpResponseBody(response).then(
          (raw) => resolve({ status: response.statusCode ?? 0, raw }),
          reject,
        );
      },
    );
    request.on('error', reject);
    request.setTimeout(HOST_HOLD_HTTP_TIMEOUT_MS, () => {
      request.destroy(new AppError('COMMAND_FAILED', 'The daemon host hold request timed out.'));
    });
    request.end(body);
  });
  return readHostHoldResponse(status, raw);
}

function readHostHoldResponse(status: number, raw: string): Record<string, unknown> {
  const parsed: unknown = raw.trim() === '' ? undefined : JSON.parse(raw);
  if (status < 200 || status > 299) throw hostHoldRestError(status, parsed);
  if (!isRecord(parsed) || parsed.ok !== true) {
    throw new AppError('COMMAND_FAILED', 'The daemon returned an invalid host hold response.', {
      statusCode: status,
    });
  }
  return parsed;
}

function hostHoldRestError(status: number, parsed: unknown): AppError {
  const record = isRecord(parsed) ? parsed : undefined;
  const code = toAppErrorCode(
    typeof record?.code === 'string' ? record.code : undefined,
    'COMMAND_FAILED',
  );
  const reason = typeof record?.reason === 'string' ? record.reason : undefined;
  const hint = typeof record?.hint === 'string' ? record.hint : undefined;
  return new AppError(
    code,
    typeof record?.error === 'string'
      ? record.error
      : `The daemon refused the host hold request (HTTP ${status}).`,
    {
      statusCode: status,
      ...(reason ? { reason } : {}),
      ...(hint ? { hint } : {}),
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
