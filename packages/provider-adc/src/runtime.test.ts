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
const url = 'wss://adc.test/v2/leases/one/adb';
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
    socketSpec: 'localfilesystem:/test',
    close,
  });
  const config = credentials({ ADC_LEASE_TOKEN: 'lease-token', ADC_ADB_WEBSOCKET_URL: url });
  const { runtime, platformModule } = createRegistration(
    config,
    {},
    { createLeaseInteractor: vi.fn(), getForegroundApp: vi.fn(), bindDeployment: vi.fn() },
  );
  expect(platformModule.owner.provider).toBe('adc');
  const result = await runtime.leaseLifecycle.allocate?.(lease, { flags: { target: 'tv' } });
  expect(result).toMatchObject({
    providerSessionId: 'one',
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
    const body = input.pathname.endsWith('/access')
      ? { token: 'lease', websocket_url: url }
      : { id: 'one', status: 'active' };
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
    'POST /v2/leases/one/access',
    'DELETE /v2/leases/one',
  ]);
});

it('only recovers a booking that echoes the requested idempotency key', async () => {
  const unrelated = { id: 'foreign', status: 'active' };
  const expected = { id: 'own', status: 'active', idempotency_key: 'mine' };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ leases: [unrelated] }))
    .mockResolvedValueOnce(Response.json({ leases: [unrelated, expected] }));
  vi.stubGlobal('fetch', fetch);
  const client = adcClient({ kind: 'direct', origin: new URL('https://adc.test'), key: 'key' });
  await expect(client.find('mine')).resolves.toBeUndefined();
  await expect(client.find('mine')).resolves.toBe('own');
});
