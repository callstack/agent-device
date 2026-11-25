import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';

type Env = Readonly<Record<string, string | undefined>>;
export type Attach = Readonly<{ url: URL; token: string }>;
export type Credentials =
  | { kind: 'direct'; origin: URL; key: string }
  | { kind: 'attached'; access: Attach };

const leaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const leaseStates = new Set(['queued', 'active', 'released', 'expired', 'failed']);

function bearer(value: string) {
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(value) || /\s/.test(value))
    throw new AppError('INVALID_ARGS', 'Invalid ADC bearer credential.');
  return value;
}

function endpoint(value: string, protocol: 'https:' | 'wss:') {
  if (!URL.canParse(value)) throw new AppError('INVALID_ARGS', 'Invalid ADC endpoint.');
  const url = new URL(value);
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash)
    throw new AppError('INVALID_ARGS', 'ADC requires a secure endpoint.');
  return url;
}

function attach(origin: URL, urlString: string, secret: string, expectedId?: string): Attach {
  const token = bearer(secret);
  const url = endpoint(urlString, 'wss:');
  const id = url.pathname.split('/')[3];
  if (
    !id ||
    !leaseIdPattern.test(id) ||
    id === token ||
    url.pathname !== '/v2/leases/' + id + '/adb'
  )
    throw new AppError('INVALID_ARGS', 'Invalid ADC lease access.');
  if (origin.host !== url.host || (expectedId !== undefined && id !== expectedId))
    throw new AppError('COMMAND_FAILED', 'ADC returned access for a different endpoint.');
  return { url, token };
}

export function credentials(env: Env): Credentials {
  const origin = endpoint(env.ADC_API_URL ?? 'https://api.agentdevicecloud.xyz', 'https:');
  if (origin.pathname !== '/') throw new AppError('INVALID_ARGS', 'ADC_API_URL must be an origin.');
  const socket = env.ADC_ADB_WEBSOCKET_URL;
  const token = env.ADC_LEASE_TOKEN;
  if (socket || token) {
    if (!socket || !token || env.ADC_API_KEY)
      throw new AppError(
        'INVALID_ARGS',
        'For an attached ADC device, set only ADC_ADB_WEBSOCKET_URL and ADC_LEASE_TOKEN as credentials.',
      );
    return { kind: 'attached', access: attach(origin, socket, token) };
  }
  if (!env.ADC_API_KEY)
    throw new AppError('INVALID_ARGS', 'Set ADC_API_KEY to rent a device from ADC.');
  return { kind: 'direct', origin, key: bearer(env.ADC_API_KEY) };
}

export function adcClient(config: Extract<Credentials, { kind: 'direct' }>) {
  async function request(
    method: string,
    path: string,
    signal?: AbortSignal,
    body?: object,
  ): Promise<Response> {
    const url = new URL(path, config.origin);
    const timeout = AbortSignal.timeout(15_000);
    const budget = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: 'error',
        signal: budget,
        headers: { authorization: 'Bearer ' + config.key, 'content-type': 'application/json' },
        ...(body && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new AppError('COMMAND_FAILED', 'ADC request did not complete.');
    }
    if (!response.ok)
      throw new AppError('COMMAND_FAILED', `ADC ${method} failed (HTTP ${response.status}).`, {
        httpStatus: response.status,
      });
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new AppError('COMMAND_FAILED', 'ADC returned invalid JSON.');
    }
  }
  function lease(value: unknown) {
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      value.id === config.key ||
      !leaseIdPattern.test(value.id) ||
      typeof value.status !== 'string' ||
      !leaseStates.has(value.status)
    )
      throw new AppError('COMMAND_FAILED', 'ADC returned an invalid lease.');
    return { id: value.id, status: value.status };
  }
  return {
    verify: async () => {
      const response = await request('GET', '/v1/me');
      await response.body?.cancel();
    },
    create: async (id: string, tv: boolean, signal: AbortSignal) => {
      const response = await request('POST', '/v2/leases', signal, {
        name: 'agent-device',
        form_factor: tv ? 'tv' : 'phone',
        idempotency_key: id,
        max_duration_seconds: 7200,
      });
      const result = await json(response);
      return lease(result);
    },
    get: async (id: string, signal: AbortSignal) => {
      const response = await request('GET', '/v2/leases/' + id, signal);
      const result = await json(response);
      const record = lease(result);
      if (record.id !== id) throw new AppError('COMMAND_FAILED', 'ADC returned a different lease.');
      return record;
    },
    find: async (id: string) => {
      const query = new URLSearchParams({ idempotency_key: id });
      const response = await request('GET', '/v2/leases?' + query);
      const result = await json(response);
      if (!isRecord(result) || !Array.isArray(result.leases))
        throw new AppError('COMMAND_FAILED', 'Invalid ADC lease list.');
      const match = result.leases.find((entry) => isRecord(entry) && entry.idempotency_key === id);
      return match ? lease(match).id : undefined;
    },
    end: async (id: string) => {
      if (!leaseIdPattern.test(id) || id === config.key)
        throw new AppError('INVALID_ARGS', 'Invalid ADC rental identifier.');
      const response = await request('DELETE', '/v2/leases/' + id);
      await response.body?.cancel();
    },
    access: async (id: string, signal: AbortSignal) => {
      const response = await request('POST', '/v2/leases/' + id + '/access', signal);
      const result = await json(response);
      if (
        !isRecord(result) ||
        typeof result.websocket_url !== 'string' ||
        typeof result.token !== 'string' ||
        result.token === config.key
      )
        throw new AppError('COMMAND_FAILED', 'ADC returned invalid ADB credentials.');
      return attach(config.origin, result.websocket_url, result.token, id);
    },
  };
}
