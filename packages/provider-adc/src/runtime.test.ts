import { LEASE_REASONS } from '@agent-device/contracts/lease-scope';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { adcClient, credentials } from './client.ts';
import { createRegistration } from './runtime.ts';
import { connectAdb } from './tunnel.ts';

vi.mock('./tunnel.ts', () => ({ connectAdb: vi.fn() }));
const lease: DeviceLease = {
  leaseId: 'session-one',
  tenantId: 'tenant',
  runId: 'run',
  backend: 'android-instance',
  leaseProvider: 'adc',
  createdAt: 1,
  expiresAt: 1000,
  heartbeatAt: 1,
};
const url = 'wss://adc.test/v2/leases/a0000000-0000-4000-8000-000000000001/adb';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('attaches an Android TV and closes only its local tunnel', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const close = vi.fn(async () => {});
  vi.mocked(connectAdb).mockResolvedValue({
    serial: '127.0.0.1:1234',
    closed: new AbortController().signal,
    socketSpec: 'localfilesystem:/test',
    close,
  });
  const config = credentials({
    ADC_API_URL: 'https://adc.test',
    ADC_LEASE_TOKEN: 'lease-token',
    ADC_ADB_WEBSOCKET_URL: url,
  });
  const { runtime, platformModule } = createRegistration(
    config,
    {},
    { createLeaseInteractor: vi.fn(), getForegroundApp: vi.fn(), bindDeployment: vi.fn() },
  );
  expect(platformModule.owner.provider).toBe('adc');
  const result = await runtime.leaseLifecycle.allocate?.(lease, { flags: { target: 'tv' } });
  expect(result).toMatchObject({
    device: { target: 'tv', id: '127.0.0.1:1234' },
  });
  const request = { leaseProvider: 'adc', leaseId: lease.leaseId };
  const visible = await runtime.deviceInventoryProvider(request);
  expect(visible).toEqual([result?.device]);
  const device = visible?.[0];
  if (!device) throw new Error('Expected a live device.');
  expect(runtime.ownsDevice(device)).toBe(true);

  const foreign = await runtime.deviceInventoryProvider({ ...request, leaseProvider: 'other' });
  expect(foreign).toBeNull();
  const ios = await runtime.deviceInventoryProvider({ ...request, platform: 'ios' });
  expect(ios).toEqual([]);
  const release = await runtime.leaseLifecycle.release?.(lease);
  expect(release).toEqual({ release: 'confirmed' });
  expect(runtime.ownsDevice(device)).toBe(false);
  expect(runtime.getInteractor(device)).toBeUndefined();
  const afterRelease = await runtime.deviceInventoryProvider(request);
  expect(afterRelease).toEqual([]);
  expect(close).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it('releases a direct ADC booking when its tunnel fails', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (input: URL, init: RequestInit) => {
    requests.push(`${init.method} ${input.pathname}`);
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    const body = input.pathname.endsWith('/access')
      ? { token: 'lease', websocket_url: url }
      : { id: 'a0000000-0000-4000-8000-000000000001', status: 'active' };
    return Response.json(body);
  });
  vi.mocked(connectAdb).mockRejectedValue(new Error('ADB unavailable'));
  const config = credentials({ ADC_API_KEY: 'workspace', ADC_API_URL: 'https://adc.test' });
  const { runtime, platformModule } = createRegistration(
    config,
    {},
    { createLeaseInteractor: vi.fn(), getForegroundApp: vi.fn(), bindDeployment: vi.fn() },
  );
  expect(platformModule.owner.provider).toBe('adc');
  await expect(runtime.leaseLifecycle.allocate?.(lease)).rejects.toThrow('ADB unavailable');
  expect(requests).toEqual([
    'POST /v2/leases',
    'POST /v2/leases/a0000000-0000-4000-8000-000000000001/access',
    'DELETE /v2/leases/a0000000-0000-4000-8000-000000000001',
  ]);
});

it('only recovers a booking that echoes the requested idempotency key', async () => {
  const unrelated = { id: 'foreign', status: 'active' };
  const expected = {
    id: 'a0000000-0000-4000-8000-000000000001',
    status: 'active',
    idempotency_key: 'mine',
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ leases: [unrelated] }))
    .mockResolvedValueOnce(Response.json({ leases: [unrelated, expected] }));
  vi.stubGlobal('fetch', fetch);
  const client = adcClient({ kind: 'direct', origin: new URL('https://adc.test'), key: 'key' });
  await expect(client.find('mine')).resolves.toBeUndefined();
  await expect(client.find('mine')).resolves.toBe('a0000000-0000-4000-8000-000000000001');
});

it('reserves one broker device before dialing and frees it when the endpoint closes', async () => {
  const closed = new AbortController();
  const close = vi.fn(async () => {});
  type Tunnel = Awaited<ReturnType<typeof connectAdb>>;
  let finish!: (tunnel: Tunnel) => void;
  const pending = new Promise<Tunnel>((resolve) => {
    finish = resolve;
  });
  vi.mocked(connectAdb).mockReturnValueOnce(pending);
  const config = credentials({
    ADC_API_URL: 'https://adc.test',
    ADC_ADB_WEBSOCKET_URL: url,
    ADC_LEASE_TOKEN: 'scoped',
  });
  const host = {
    createLeaseInteractor: vi.fn(),
    getForegroundApp: vi.fn(),
    bindDeployment: vi.fn(),
  };
  const { runtime } = createRegistration(config, {}, host);
  const first = runtime.leaseLifecycle.allocate!(lease);
  const other = { ...lease, leaseId: 'other-session' };
  await expect(runtime.leaseLifecycle.allocate!(other)).rejects.toMatchObject({
    code: 'DEVICE_IN_USE',
  });
  expect(connectAdb).toHaveBeenCalledOnce();
  finish({
    serial: 'localfilesystem:/test-device',
    socketSpec: 'localfilesystem:/test-server',
    closed: closed.signal,
    close,
  });
  const ready = await first;
  expect(ready).not.toHaveProperty('providerSessionId');
  closed.abort();
  const devices = await runtime.deviceInventoryProvider({
    leaseProvider: 'adc',
    leaseId: lease.leaseId,
  });
  expect(devices).toEqual([]);
  await expect(runtime.leaseLifecycle.allocate!(lease)).rejects.toMatchObject({
    details: { reason: LEASE_REASONS.instanceEnded.reason },
  });
  expect(connectAdb).toHaveBeenCalledOnce();
  await expect(runtime.leaseLifecycle.heartbeat!(lease)).rejects.toMatchObject({
    details: { reason: LEASE_REASONS.instanceEnded.reason },
  });
  await runtime.leaseLifecycle.release!(lease);
  expect(close).toHaveBeenCalledOnce();
});

it('keeps an ambiguous create pending and recovers its confirmed ADC booking after restart', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const id = 'a0000000-0000-4000-8000-000000000001';
  const config = credentials({ ADC_API_KEY: 'workspace', ADC_API_URL: 'https://adc.test' });
  const host = {
    createLeaseInteractor: vi.fn(),
    getForegroundApp: vi.fn(),
    bindDeployment: vi.fn(),
  };
  const { runtime } = createRegistration(config, {}, host);
  const beforeCreate = vi.fn();
  const rented = vi.fn();
  fetch
    .mockRejectedValueOnce(new Error('disconnected'))
    .mockImplementation(async () => Response.json({ leases: [] }));
  await expect(
    runtime.leaseLifecycle.allocate!(lease, { rental: { beforeCreate, rented } }),
  ).rejects.toThrow();
  const key = beforeCreate.mock.calls[0]?.[0];
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(fetch.mock.calls[0]![1].body).idempotency_key).toBe(key);
  expect(rented).not.toHaveBeenCalled();
  expect(await runtime.leaseLifecycle.release!(lease)).toMatchObject({ release: 'unknown' });
  const restarted = createRegistration(config, {}, host).runtime;
  const record = vi.fn();
  const recover = () =>
    restarted.leaseLifecycle.recoverRental!(lease, { reconciliationKey: key }, record);
  expect(await recover()).toBe(false);
  fetch.mockResolvedValueOnce(
    Response.json({ leases: [{ id, status: 'active', idempotency_key: key }] }),
  );
  fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect(await recover()).toBe(true);
  expect(record).toHaveBeenCalledWith(id);
  expect(fetch.mock.lastCall?.[0].pathname).toBe('/v2/leases/' + id);
  expect(fetch.mock.lastCall?.[1].method).toBe('DELETE');
});

it.each([402, 429])(
  'clears a rejected booking (HTTP %i) without trying to recover it',
  async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', fetch);
    const config = credentials({ ADC_API_KEY: 'workspace', ADC_API_URL: 'https://adc.test' });
    const host = {
      createLeaseInteractor: vi.fn(),
      getForegroundApp: vi.fn(),
      bindDeployment: vi.fn(),
    };
    const { runtime } = createRegistration(config, {}, host);
    await expect(runtime.leaseLifecycle.allocate!(lease)).rejects.toMatchObject({
      details: { httpStatus: status },
    });
    await expect(runtime.leaseLifecycle.release!(lease)).resolves.toEqual({ release: 'confirmed' });
    expect(fetch).toHaveBeenCalledOnce();
  },
);
