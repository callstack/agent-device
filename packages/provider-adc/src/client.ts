import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';

type Env = Readonly<Record<string, string | undefined>>;
export type Attach = Readonly<{ url: URL; token: string; leaseId: string }>;
export type Credentials =
  | { kind: 'direct'; origin: URL; key: string }
  | { kind: 'attached'; access: Attach };
const leaseIdPattern = /^[a-zA-Z0-9_-]+$/;

function endpoint(value: string, socket: boolean) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const secure = socket ? 'wss:' : 'https:';
  const local = socket ? 'ws:' : 'http:';
  if (
    (url.protocol !== secure && !(loopback && url.protocol === local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppError(
      'INVALID_ARGS',
      'ADC requires a secure endpoint or a loopback development endpoint.',
    );
  return url;
}

function attach(urlString: string, token: string): Attach {
  const url = endpoint(urlString, true);
  const match = /^\/v2\/leases\/([a-zA-Z0-9_-]+)\/adb$/.exec(url.pathname);
  if (!match?.[1] || !token) throw new AppError('INVALID_ARGS', 'Invalid ADC lease access.');
  return { url, token, leaseId: match[1] };
}

export function credentials(env: Env): Credentials {
  const socket = env.ADC_ADB_WEBSOCKET_URL?.trim();
  const token = env.ADC_LEASE_TOKEN?.trim();
  if (socket || token) {
    if (!socket || !token || env.ADC_API_KEY?.trim())
      throw new AppError(
        'INVALID_ARGS',
        'For an attached ADC device, set only ADC_ADB_WEBSOCKET_URL and ADC_LEASE_TOKEN.',
      );
    return { kind: 'attached', access: attach(socket, token) };
  }
  const key = env.ADC_API_KEY?.trim();
  if (!key) throw new AppError('INVALID_ARGS', 'Set ADC_API_KEY to rent a device from ADC.');
  const origin = endpoint(env.ADC_API_URL ?? 'https://api.agentdevicecloud.xyz', false);
  if (origin.pathname !== '/') throw new AppError('INVALID_ARGS', 'ADC_API_URL must be an origin.');
  return { kind: 'direct', origin, key };
}

export function adcClient(config: Extract<Credentials, { kind: 'direct' }>) {
  async function request(
    method: string,
    path: string,
    signal?: AbortSignal,
    body?: object,
  ): Promise<unknown> {
    const url = new URL(path, config.origin);
    const timeout = AbortSignal.timeout(15_000);
    const budget = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, {
      method,
      redirect: 'error',
      signal: budget,
      headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new AppError('COMMAND_FAILED', `ADC ${method} failed (HTTP ${response.status}).`);
    return await response.json();
  }
  function lease(value: unknown) {
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      !leaseIdPattern.test(value.id) ||
      typeof value.status !== 'string'
    )
      throw new AppError('COMMAND_FAILED', 'ADC returned an invalid lease.');
    return { id: value.id, status: value.status };
  }
  return {
    verify: async () => {
      await request('GET', '/v1/me');
    },
    create: async (id: string, tv: boolean, signal: AbortSignal) => {
      const body = {
        name: 'agent-device',
        form_factor: tv ? 'tv' : 'phone',
        idempotency_key: id,
        max_duration_seconds: 7200,
      };
      const result = await request('POST', '/v2/leases', signal, body);
      return lease(result);
    },
    get: async (id: string, signal: AbortSignal) => {
      const result = await request('GET', `/v2/leases/${id}`, signal);
      return lease(result);
    },
    find: async (id: string) => {
      const query = new URLSearchParams({ idempotency_key: id });
      const result = await request('GET', '/v2/leases?' + query);
      if (!isRecord(result) || !Array.isArray(result.leases))
        throw new AppError('COMMAND_FAILED', 'Invalid ADC lease list.');
      const match = result.leases.find((entry) => isRecord(entry) && entry.idempotency_key === id);
      return match ? lease(match).id : undefined;
    },
    end: async (id: string) => {
      await request('DELETE', `/v2/leases/${id}`);
    },
    access: async (id: string, signal: AbortSignal) => {
      const result = await request('POST', `/v2/leases/${id}/access`, signal);
      if (
        !isRecord(result) ||
        typeof result.websocket_url !== 'string' ||
        typeof result.token !== 'string'
      )
        throw new AppError('COMMAND_FAILED', 'ADC returned invalid ADB credentials.');
      const access = attach(result.websocket_url, result.token);
      if (access.url.host !== config.origin.host || access.leaseId !== id)
        throw new AppError('COMMAND_FAILED', 'ADC returned access for a different endpoint.');
      return access;
    },
  };
}
