import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  loginWithDeviceAuth,
  readCliSession,
  resolveRemoteAuth,
  writeCliSession,
} from '../auth-session.ts';

const baseFlags = {
  json: false,
  help: false,
  version: false,
  daemonBaseUrl: 'https://bridge.agent-device.dev',
  tenant: 'acme',
  runId: 'run-123',
};

const START = 'https://cloud.example/api/control-plane/device-auth/start';
const POLL = 'https://cloud.example/api/control-plane/device-auth/poll';
const REFRESH = 'https://cloud.example/api/control-plane/cli-session/refresh';

type SentRequest = {
  url: string;
  method?: string;
  body?: unknown;
  contentType?: string | null;
  redirect?: RequestRedirect;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

/**
 * A cloud that answers each URL from `routes` and records every request it receives. A URL without
 * a route answers 404, so a request that reaches an unexpected target is visible in `sent`.
 */
function fakeCloud(routes: Record<string, () => Response>) {
  const sent: SentRequest[] = [];
  const fetch = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      contentType: new Headers(init?.headers).get('content-type'),
      redirect: init?.redirect,
    });
    return routes[String(url)]?.() ?? new Response('{}', { status: 404 });
  };
  return { sent, fetch };
}

const startAnswer = () =>
  jsonResponse({
    deviceCode: 'device-secret',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://cloud.example/authorize',
  });
const pollAnswer = () =>
  jsonResponse({
    status: 'approved',
    accessToken: 'adc_agent_login',
    cliSession: { id: 'session-login', refreshCredential: 'adc_refresh_login' },
  });

function login(stateDir: string, fetch: typeof globalThis.fetch) {
  return loginWithDeviceAuth({
    stateDir,
    flags: baseFlags,
    env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
    io: {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderr: { write: () => true },
      openBrowser: async () => {},
      fetch,
    },
  });
}

function refresh(stateDir: string, fetch: typeof globalThis.fetch) {
  writeCliSession({
    stateDir,
    session: {
      version: 2,
      id: 'session-stored',
      cloudBaseUrl: 'https://cloud.example',
      issuerOrigin: 'https://cloud.example',
      refreshCredential: 'adc_refresh_stored',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
  return resolveRemoteAuth({
    command: 'snapshot',
    flags: baseFlags,
    stateDir,
    allowInteractiveLogin: false,
    env: {},
    io: { fetch },
  });
}

const hasReason = (reason: string) => (error: unknown) =>
  normalizeError(error).details?.reason === reason;

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = mkdtempForTestSync('agent-device-auth-redirect-');
  try {
    await run(stateDir);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test('a login follows a same-origin 307 at device-auth start and a 308 at poll with the same POST', async () => {
  await withStateDir(async (stateDir) => {
    const cloud = fakeCloud({
      [START]: () => redirect(307, '/v2/device-auth/start'),
      'https://cloud.example/v2/device-auth/start': startAnswer,
      [POLL]: () => redirect(308, 'https://cloud.example/v2/device-auth/poll'),
      'https://cloud.example/v2/device-auth/poll': pollAnswer,
    });

    const result = await login(stateDir, cloud.fetch);

    assert.equal(result.accessToken, 'adc_agent_login');
    assert.deepEqual(
      cloud.sent.map(({ url, method, redirect }) => ({ url, method, redirect })),
      [
        START,
        'https://cloud.example/v2/device-auth/start',
        POLL,
        'https://cloud.example/v2/device-auth/poll',
      ].map((url) => ({ url, method: 'POST', redirect: 'manual' })),
    );
    assert.deepEqual(cloud.sent[1]?.body, cloud.sent[0]?.body);
    assert.deepEqual(cloud.sent[3]?.body, { deviceCode: 'device-secret' });
  });
});

test('a login stops at a cross-origin redirect at device-auth start before it is followed', async () => {
  await withStateDir(async (stateDir) => {
    const cloud = fakeCloud({
      [START]: () => redirect(307, 'https://elsewhere.example/device-auth/start'),
    });

    await assert.rejects(
      () => login(stateDir, cloud.fetch),
      hasReason('cloud_auth_redirect_cross_origin'),
    );
    assert.deepEqual(
      cloud.sent.map(({ url }) => url),
      [START],
    );
  });
});

test('a login stops at a cross-origin redirect at device-auth poll and stores nothing', async () => {
  await withStateDir(async (stateDir) => {
    const cloud = fakeCloud({
      [START]: startAnswer,
      [POLL]: () => redirect(308, 'https://elsewhere.example/device-auth/poll'),
    });

    await assert.rejects(
      () => login(stateDir, cloud.fetch),
      hasReason('cloud_auth_redirect_cross_origin'),
    );
    assert.deepEqual(
      cloud.sent.map(({ url }) => url),
      [START, POLL],
    );
    assert.equal(readCliSession({ stateDir }), null);
  });
});

test('a refresh follows a same-origin 307 and sends the credential again only there', async () => {
  await withStateDir(async (stateDir) => {
    const cloud = fakeCloud({
      [REFRESH]: () => redirect(307, '/unlock'),
      'https://cloud.example/unlock': () => jsonResponse({ accessToken: 'adc_agent_fresh' }),
    });

    const result = await refresh(stateDir, cloud.fetch);

    assert.equal(result.flags.daemonAuthToken, 'adc_agent_fresh');
    assert.deepEqual(
      cloud.sent.map(({ url, method }) => ({ url, method })),
      [
        { url: REFRESH, method: 'POST' },
        { url: 'https://cloud.example/unlock', method: 'POST' },
      ],
    );
    assert.deepEqual(cloud.sent[1]?.body, cloud.sent[0]?.body);
  });
});

test('a refresh stops at a cross-origin 308 and never sends the credential there', async () => {
  await withStateDir(async (stateDir) => {
    const cloud = fakeCloud({
      [REFRESH]: () => redirect(308, 'https://elsewhere.example/refresh'),
    });

    await assert.rejects(
      () => refresh(stateDir, cloud.fetch),
      hasReason('cloud_auth_redirect_cross_origin'),
    );
    assert.deepEqual(
      cloud.sent.map(({ url }) => url),
      [REFRESH],
    );
  });
});

test('a refresh follows three same-origin redirects and refuses a fourth', async () => {
  await withStateDir(async (stateDir) => {
    const hops = (count: number) => {
      const routes: Record<string, () => Response> = {};
      let from = REFRESH;
      for (let hop = 1; hop <= count; hop += 1) {
        routes[from] = () => redirect(307, `/hop-${hop}`);
        from = `https://cloud.example/hop-${hop}`;
      }
      routes[from] = () => jsonResponse({ accessToken: 'adc_agent_fresh' });
      return fakeCloud(routes);
    };

    const three = hops(3);
    assert.equal((await refresh(stateDir, three.fetch)).flags.daemonAuthToken, 'adc_agent_fresh');
    assert.equal(three.sent.length, 4);

    const four = hops(4);
    await assert.rejects(
      () => refresh(stateDir, four.fetch),
      hasReason('cloud_auth_redirect_limit'),
    );
    assert.equal(four.sent.length, 4);
  });
});

const requestShape = ({ url, method, body, contentType }: SentRequest) => ({
  url,
  method,
  body,
  contentType,
});
const sentAsGet = (url: string) => ({ url, method: 'GET', body: undefined, contentType: null });
const flagFields = {
  tenant: 'acme',
  runId: 'run-123',
  daemonBaseUrl: 'https://bridge.agent-device.dev',
};
const postedAs = (body: Record<string, unknown>) => ({
  method: 'POST',
  body,
  contentType: 'application/json',
});
const postedStart = postedAs({ client: 'agent-device', ...flagFields });
const postedPoll = postedAs({ deviceCode: 'device-secret' });
const postedRefresh = postedAs({
  refreshCredential: 'adc_refresh_stored',
  acceptsRotatedRefreshCredential: true,
  ...flagFields,
});

for (const status of [301, 302, 303]) {
  test(`a login follows a same-origin ${status} at device-auth start and poll as a GET without the body`, async () => {
    await withStateDir(async (stateDir) => {
      const cloud = fakeCloud({
        [START]: () => redirect(status, '/v2/device-auth/start'),
        'https://cloud.example/v2/device-auth/start': startAnswer,
        [POLL]: () => redirect(status, 'https://cloud.example/v2/device-auth/poll'),
        'https://cloud.example/v2/device-auth/poll': pollAnswer,
      });

      const result = await login(stateDir, cloud.fetch);

      assert.equal(result.accessToken, 'adc_agent_login');
      assert.deepEqual(cloud.sent.map(requestShape), [
        { url: START, ...postedStart },
        sentAsGet('https://cloud.example/v2/device-auth/start'),
        { url: POLL, ...postedPoll },
        sentAsGet('https://cloud.example/v2/device-auth/poll'),
      ]);
    });
  });

  test(`a refresh follows a same-origin ${status} as a GET without the credential`, async () => {
    await withStateDir(async (stateDir) => {
      const cloud = fakeCloud({
        [REFRESH]: () => redirect(status, '/unlock'),
        'https://cloud.example/unlock': () => jsonResponse({ accessToken: 'adc_agent_fresh' }),
      });

      const result = await refresh(stateDir, cloud.fetch);

      assert.equal(result.flags.daemonAuthToken, 'adc_agent_fresh');
      assert.deepEqual(cloud.sent.map(requestShape), [
        { url: REFRESH, ...postedRefresh },
        sentAsGet('https://cloud.example/unlock'),
      ]);
    });
  });
}

test('a refresh keeps the POST through a 307 and continues as a GET after a 303', async () => {
  await withStateDir(async (stateDir) => {
    const cloud = fakeCloud({
      [REFRESH]: () => redirect(307, '/a'),
      'https://cloud.example/a': () => redirect(303, '/b'),
      'https://cloud.example/b': () => redirect(307, '/c'),
      'https://cloud.example/c': () => jsonResponse({ accessToken: 'adc_agent_fresh' }),
    });

    const result = await refresh(stateDir, cloud.fetch);

    assert.equal(result.flags.daemonAuthToken, 'adc_agent_fresh');
    assert.deepEqual(cloud.sent.map(requestShape), [
      { url: REFRESH, ...postedRefresh },
      { url: 'https://cloud.example/a', ...postedRefresh },
      sentAsGet('https://cloud.example/b'),
      sentAsGet('https://cloud.example/c'),
    ]);
  });
});

const CREDENTIAL_REDIRECT_MESSAGE =
  'Cloud auth endpoint redirected the request to a URL with a username or password.';

async function assertCredentialRedirectRefused(
  attempt: () => Promise<unknown>,
  secret: string,
): Promise<void> {
  await assert.rejects(attempt, (error: unknown) => {
    const normalized = normalizeError(error);
    assert.equal(normalized.message, CREDENTIAL_REDIRECT_MESSAGE);
    assert.equal(normalized.details?.reason, 'cloud_auth_redirect_unsupported');
    assert.equal(JSON.stringify(normalized).includes(secret), false);
    return true;
  });
}

test('a login refuses a redirect with a username or password at device-auth start before it is followed', async () => {
  await withStateDir(async (stateDir) => {
    const cloud = fakeCloud({
      [START]: () => redirect(307, 'https://user:start-secret@cloud.example/v2/device-auth/start'),
    });

    await assertCredentialRedirectRefused(() => login(stateDir, cloud.fetch), 'start-secret');
    assert.deepEqual(
      cloud.sent.map(({ url }) => url),
      [START],
    );
  });
});

test('a login refuses a poll redirect that echoes the device code as a username', async () => {
  await withStateDir(async (stateDir) => {
    const cloud = fakeCloud({
      [START]: startAnswer,
      [POLL]: () => redirect(308, 'https://device-secret@cloud.example/v2/device-auth/poll'),
    });

    await assertCredentialRedirectRefused(() => login(stateDir, cloud.fetch), 'device-secret');
    assert.deepEqual(
      cloud.sent.map(({ url }) => url),
      [START, POLL],
    );
    assert.equal(readCliSession({ stateDir }), null);
  });
});

test('a refresh refuses a redirect that echoes the refresh credential as a password', async () => {
  await withStateDir(async (stateDir) => {
    const cloud = fakeCloud({
      [REFRESH]: () => redirect(307, 'https://session:adc_refresh_stored@cloud.example/unlock'),
    });

    await assertCredentialRedirectRefused(
      () => refresh(stateDir, cloud.fetch),
      'adc_refresh_stored',
    );
    assert.deepEqual(
      cloud.sent.map(({ url }) => url),
      [REFRESH],
    );
  });
});
