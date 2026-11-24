import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { DEFAULT_CLOUD_BASE_URL, writeCliSession } from '../cli/auth-session.ts';
import { runCliCapture } from './cli-capture.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('catalog ignores ambient daemon settings and requires cloud authentication', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const result = await runCliCapture(['connect', 'list', '--json'], {
    env: { AGENT_DEVICE_DAEMON_BASE_URL: 'https://daemon.example' },
  });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'cloud_api_key_required' },
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.calls).toEqual([]);
});

test.each([DEFAULT_CLOUD_BASE_URL, 'https://issuer.example'])(
  'catalog exchanges a stored session with its issuer %s for account access',
  async (issuer) => {
    const stateDir = storeSession(issuer);
    const fetchMock = vi.fn(async (url: URL, _init: RequestInit) =>
      url.pathname.endsWith('/refresh')
        ? Response.json({ accessToken: 'catalog-access-key' })
        : Response.json([]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await runCliCapture(['connect', 'list', '--json'], {
      env: {
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_BASE_URL: 'https://daemon.example',
        AGENT_DEVICE_SESSION: 'other-session',
      },
    });
    expect(result.code).toBeNull();
    expect(JSON.parse(result.stdout).data).toEqual([]);
    expect(fetchMock.mock.calls.map(([url]) => url.href)).toEqual([
      `${issuer}/api/control-plane/cli-session/refresh`,
      `${issuer}/v1/vendors`,
    ]);
    const [, refresh] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(refresh.body))).toEqual({
      refreshCredential: 'catalog-refresh-key',
      acceptsRotatedRefreshCredential: true,
    });
    const [, list] = fetchMock.mock.calls[1]!;
    expect(new Headers(list.headers).get('authorization')).toBe('Bearer catalog-access-key');
  },
);

test.each([
  ['http://issuer.example', undefined, 'cloud_invalid_origin'],
  ['https://issuer.example', 'invalid origin secret', 'cloud_invalid_origin'],
  ['https://issuer.example', 'https://elsewhere.example', 'cloud_login_origin_mismatch'],
])(
  'catalog rejects stored origin %s with override %s before fetching',
  async (issuer, override, reason) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await runCliCapture(['connect', 'list', '--json'], {
      env: {
        AGENT_DEVICE_STATE_DIR: storeSession(issuer),
        AGENT_DEVICE_CLOUD_BASE_URL: override,
      },
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.details.reason).toBe(reason);
    expect(result.stdout + result.stderr).not.toContain('invalid origin secret');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

function storeSession(cloudBaseUrl: string): string {
  const stateDir = mkdtempForTestSync('agent-device-catalog-session-');
  writeCliSession({
    stateDir,
    session: {
      version: 2,
      id: 'catalog-session',
      cloudBaseUrl,
      createdAt: '2026-01-01T00:00:00.000Z',
      refreshCredential: 'catalog-refresh-key',
    },
  });
  return stateDir;
}

test('lists authenticated cloud vendors in text and JSON without a named session', async () => {
  const rows = [
    {
      vendor: 'provider-a',
      platform: 'ios',
      usdPerMinute: 0.03,
      capabilities: ['viewer', 'runtime-preview'],
      viewer: true,
      available: true,
      catalogVersion: 2,
      maxMinutes: 115,
    },
    {
      vendor: 'provider-b',
      platform: 'android',
      usdPerMinute: 0.05,
      capabilities: ['adb'],
      viewer: false,
      available: false,
      catalogVersion: 2,
      maxMinutes: 115,
    },
  ];
  const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => Response.json(rows));
  vi.stubGlobal('fetch', fetchMock);
  const env = {
    AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example',
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'cloud-api-test-key',
  };
  const options = { env, stateDirPrefix: 'agent-device-cloud-catalog-' };
  const human = await runCliCapture(['connect', 'list'], options);
  expect(human.code, human.stderr || human.stdout).toBeNull();
  expect(human.stdout.trim().split('\n')).toEqual([
    'provider-a ios  $0.03/min  capabilities: viewer, runtime-preview  live view: yes  available: yes',
    'provider-b android  $0.05/min  capabilities: adb  live view: no  available: no',
  ]);
  expect(human.calls).toEqual([]);
  const json = await runCliCapture(['connect', 'list', '--json'], {
    ...options,
    env: { ...env, AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'cloud-api-test-key' },
  });
  expect(json.code).toBeNull();
  expect(JSON.parse(json.stdout).data).toEqual(rows);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url.href).toBe('https://cloud.example/v1/vendors');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer cloud-api-test-key');
  }
  const invalid = await runCliCapture(['connect', 'list', '--os', '26'], options);
  expect(invalid.code).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('connect list --live asks for fresh availability and renders it with an API key', async () => {
  const checkedAt = '2026-11-22T12:00:00.000Z';
  const rows = [
    {
      vendor: 'provider-a',
      platform: 'ios',
      usdPerMinute: 0.1,
      capabilities: ['viewer'],
      viewer: true,
      available: true,
      usdMicrosPerMinute: '100000',
      minMinutes: 5,
      availability: {
        state: 'unavailable',
        reason: 'sessions_paused',
        checkedAt,
        scope: 'broker_vendor',
      },
    },
    {
      vendor: 'provider-b',
      platform: 'android',
      usdPerMinute: 0.04,
      capabilities: ['adb'],
      viewer: false,
      available: true,
    },
  ];
  const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => Response.json(rows));
  vi.stubGlobal('fetch', fetchMock);
  const options = {
    env: {
      AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example',
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'cloud-api-test-key',
    },
    stateDirPrefix: 'agent-device-cloud-catalog-',
  };
  const human = await runCliCapture(['connect', 'list', '--live'], options);
  expect(human.code, human.stderr || human.stdout).toBeNull();
  expect(human.stdout.trim().split('\n')).toEqual([
    'provider-a ios  $0.1/min  minimum: 5 min  capabilities: viewer  live view: yes  available: yes  availability: unavailable (sessions_paused)',
    expect.stringMatching(
      /^provider-b android {2}\$0\.04\/min {2}capabilities: adb {2}live view: no {2}available: yes {2}availability: unknown \(live_availability_unsupported\)$/,
    ),
  ]);
  const json = await runCliCapture(['connect', 'list', '--live', '--json'], options);
  const data = JSON.parse(json.stdout).data;
  expect(data[0]).toEqual(rows[0]);
  expect(data[1].availability).toMatchObject({
    state: 'unknown',
    reason: 'live_availability_unsupported',
    scope: 'broker_vendor',
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url.href).toBe('https://cloud.example/v1/vendors?availability=live');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer cloud-api-test-key');
  }
  const refused = await runCliCapture(['connect', 'cloud', '--platform', 'ios', '--live'], options);
  expect(refused.code).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
