import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveHostedCloudAccess } from '../connection/cloud-access.ts';
import {
  loginWithDeviceAuth,
  readCliSession,
  resolveCliSessionPath,
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A refresh of the stored session that records each request URL and answers with a token. */
function refreshWith(stateDir: string, env: NodeJS.ProcessEnv, requests: string[]) {
  return resolveRemoteAuth({
    command: 'snapshot',
    flags: baseFlags,
    stateDir,
    allowInteractiveLogin: false,
    env,
    io: {
      fetch: async (url) => {
        requests.push(String(url));
        return jsonResponse({ accessToken: 'adc_agent_fresh' });
      },
    },
  });
}

/** Answers device-auth start and poll with an approved login, and any other URL with a 404. */
const deviceAuthCloud = async (url: URL | RequestInfo): Promise<Response> => {
  if (String(url) === START) {
    return jsonResponse({
      deviceCode: 'device-secret',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://cloud.example/authorize',
    });
  }
  if (String(url) === POLL) {
    return jsonResponse({
      status: 'approved',
      accessToken: 'adc_agent_login',
      cliSession: { id: 'session-new', refreshCredential: 'adc_refresh_new' },
    });
  }
  return new Response('{}', { status: 404 });
};

function loginAt(
  stateDir: string,
  fetch: typeof globalThis.fetch,
  issuer = 'https://cloud.example/',
) {
  return loginWithDeviceAuth({
    stateDir,
    flags: baseFlags,
    env: { AGENT_DEVICE_CLOUD_BASE_URL: issuer },
    io: {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderr: { write: () => true },
      openBrowser: async () => {},
      fetch,
    },
  });
}

/** Writes the session file as raw JSON, the way an older CLI or a hand edit leaves it. */
function writeRawSession(stateDir: string, record: Record<string, unknown>): void {
  const filePath = resolveCliSessionPath(stateDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(record));
}

test.each([
  ['unverified', 'cli_session_issuer_unverified'],
  ['revoked', 'cli_session_revoked'],
  ['tokenless', 'cli_session_refresh_unanswered'],
])('hosted login reports its own credential hint for a %s session', async (kind, reason) => {
  const stateDir = mkdtempForTestSync('agent-device-hosted-auth-hint-');
  const cloudBaseUrl = 'https://cloud.example';
  const session = {
    id: 'fixture-id',
    refreshCredential: 'fixture-refresh',
    createdAt: new Date().toISOString(),
  };
  if (kind === 'unverified') writeRawSession(stateDir, { ...session, version: 1 });
  else writeCliSession({ stateDir, session: { ...session, version: 2, cloudBaseUrl } });
  const fetchMock = vi.fn(async () =>
    Response.json(kind === 'revoked' ? { status: 'revoked' } : {}),
  );
  vi.stubGlobal('fetch', fetchMock);
  try {
    await assert.rejects(
      resolveHostedCloudAccess({
        stateDir,
        env: { CI: '1', AGENT_DEVICE_CLOUD_BASE_URL: cloudBaseUrl },
      }),
      (error: unknown) => {
        const normalized = normalizeError(error);
        assert.equal(normalized.code, 'UNAUTHORIZED');
        assert.equal(normalized.details?.reason, reason);
        assert.match(normalized.hint ?? '', /AGENT_DEVICE_CLOUD_API_KEY_ORIGIN/);
        assert.doesNotMatch(normalized.hint ?? '', /AGENT_DEVICE_DAEMON_AUTH_TOKEN/);
        return true;
      },
    );
    assert.equal(fetchMock.mock.calls.length, kind === 'unverified' ? 0 : 1);
  } finally {
    vi.unstubAllGlobals();
  }
});

const isIssuerUnverified = (error: unknown) => {
  const normalized = normalizeError(error);
  return (
    normalized.details?.reason === 'cli_session_issuer_unverified' &&
    String(normalized.hint).includes('agent-device auth login')
  );
};

test('a stored CLI session is sent only to the cloud that issued it', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-origin-');
  try {
    writeCliSession({
      stateDir: tempRoot,
      session: {
        version: 2,
        id: 'session-origin',
        cloudBaseUrl: 'https://cloud.example/console',
        refreshCredential: 'adc_refresh_secret',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const requests: string[] = [];

    await assert.rejects(
      () =>
        refreshWith(
          tempRoot,
          { AGENT_DEVICE_CLOUD_BASE_URL: 'https://elsewhere.example' },
          requests,
        ),
      (error) => normalizeError(error).details?.reason === 'cloud_login_origin_mismatch',
    );
    assert.deepEqual(requests, []);

    const same = await refreshWith(
      tempRoot,
      { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example/' },
      requests,
    );
    assert.equal(same.flags.daemonAuthToken, 'adc_agent_fresh');
    assert.deepEqual(requests, [REFRESH]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a rotation is not stored over a session that a login moved to another cloud', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-origin-rotate-');
  try {
    const session = {
      version: 2 as const,
      id: 'session-moved',
      cloudBaseUrl: 'https://cloud.example',
      refreshCredential: 'adc_refresh_old',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeCliSession({ stateDir: tempRoot, session });
    const moved = { ...session, cloudBaseUrl: 'https://other-cloud.example' };

    await resolveRemoteAuth({
      command: 'snapshot',
      flags: baseFlags,
      stateDir: tempRoot,
      allowInteractiveLogin: false,
      env: {},
      io: {
        fetch: async () => {
          // Another process logs in to another cloud while this refresh is in flight.
          writeCliSession({ stateDir: tempRoot, session: moved });
          return jsonResponse({ accessToken: 'adc_agent_1', refreshCredential: 'adc_refresh_new' });
        },
      },
    });

    assert.deepEqual(readCliSession({ stateDir: tempRoot }), moved);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a version 1 session is refused with a re-login reason, and a fresh login is used', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-origin-legacy-');
  try {
    writeRawSession(tempRoot, {
      version: 1,
      id: 'session-legacy',
      cloudBaseUrl: 'https://cloud.example',
      refreshCredential: 'adc_refresh_legacy',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const requests: string[] = [];

    await assert.rejects(() => refreshWith(tempRoot, {}, requests), isIssuerUnverified);
    assert.deepEqual(requests, []);
    assert.equal(readCliSession({ stateDir: tempRoot }), null);

    const login = await loginAt(tempRoot, deviceAuthCloud);
    assert.equal(login.session.version, 2);

    const refreshed = await refreshWith(tempRoot, {}, requests);
    assert.equal(refreshed.flags.daemonAuthToken, 'adc_agent_fresh');
    assert.deepEqual(requests, [REFRESH]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// Every auth route goes through the redirect-checked transport, whose cases are proven in
// cloud-auth-request.test.ts. A route that called fetch directly would follow this redirect.
test.each([START, POLL, REFRESH])(
  'a cross-origin redirect from %s is refused before it is followed, and nothing is stored',
  async (redirected) => {
    const tempRoot = mkdtempForTestSync('agent-device-auth-origin-redirect-');
    try {
      const sent: string[] = [];
      const fetch = async (url: URL | RequestInfo) => {
        sent.push(String(url));
        return String(url) === redirected
          ? new Response(null, {
              status: 307,
              headers: { location: 'https://elsewhere.example/auth' },
            })
          : await deviceAuthCloud(url);
      };
      if (redirected === REFRESH) await loginAt(tempRoot, deviceAuthCloud);
      const stored = readCliSession({ stateDir: tempRoot });

      await assert.rejects(
        () =>
          redirected === REFRESH
            ? resolveRemoteAuth({
                command: 'snapshot',
                flags: baseFlags,
                stateDir: tempRoot,
                allowInteractiveLogin: false,
                env: {},
                io: { fetch },
              })
            : loginAt(tempRoot, fetch),
        (error) => normalizeError(error).details?.reason === 'cloud_auth_redirect_refused',
      );
      assert.equal(sent.at(-1), redirected);
      assert.deepEqual(readCliSession({ stateDir: tempRoot }), stored);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test.each(['http://issuer.example', 'https://user:secret@issuer.example'])(
  'refuses unsafe stored and configured origins before sending credentials (%s)',
  async (issuer) => {
    const stateDir = mkdtempForTestSync('agent-device-auth-unsafe-origin-');
    writeCliSession({
      stateDir,
      session: {
        version: 2,
        id: 'unsafe-origin',
        cloudBaseUrl: issuer,
        refreshCredential: 'refresh-secret',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const requests: string[] = [];
    for (const env of [{}, { AGENT_DEVICE_CLOUD_BASE_URL: issuer }]) {
      await assert.rejects(
        () => refreshWith(stateDir, env, requests),
        (error) => {
          const failure = normalizeError(error);
          return (
            failure.details?.reason === 'cloud_invalid_origin' &&
            failure.message ===
              (env.AGENT_DEVICE_CLOUD_BASE_URL
                ? 'Invalid AGENT_DEVICE_CLOUD_BASE_URL.'
                : 'Invalid saved cloud API origin.') &&
            !JSON.stringify(failure).includes(issuer)
          );
        },
      );
    }
    await assert.rejects(
      () =>
        loginAt(
          stateDir,
          async (url) => {
            requests.push(String(url));
            return jsonResponse({});
          },
          issuer,
        ),
      (error) => normalizeError(error).details?.reason === 'cloud_invalid_origin',
    );
    assert.deepEqual(requests, []);
  },
);

const suppliedCredentials = {
  accessToken: 'fixture-access-token',
  cliSession: { id: 'fixture-session', refreshCredential: 'fixture-refresh-token' },
};

test.each([
  { status: 'denied' },
  { status: 'denied', error: '' },
  { status: 'approved', error: 'response-secret' },
])(
  'authorization denial beats supplied credentials and omits response details (%j)',
  async (denial) => {
    const stateDir = mkdtempForTestSync('agent-device-auth-denial-');
    await assert.rejects(
      () =>
        loginAt(stateDir, async (url) =>
          String(url) === POLL
            ? jsonResponse({ ...suppliedCredentials, ...denial })
            : deviceAuthCloud(url),
        ),
      (error) => {
        const reported = normalizeError(error);
        return reported.code === 'UNAUTHORIZED' && reported.details === undefined;
      },
    );
    assert.equal(readCliSession({ stateDir }), null);
  },
);

test.each([{}, { status: 'approved', error: null }, { status: 'approved', error: '' }])(
  'authorization succeeds with credentials and no error (%j)',
  async (outcome) => {
    const stateDir = mkdtempForTestSync('agent-device-auth-approval-');
    const login = await loginAt(stateDir, async (url) =>
      String(url) === POLL
        ? jsonResponse({ ...suppliedCredentials, ...outcome })
        : deviceAuthCloud(url),
    );
    assert.equal(login.accessToken, suppliedCredentials.accessToken);
    assert.equal(readCliSession({ stateDir })?.id, suppliedCredentials.cliSession.id);
  },
);

test('authorization keeps polling when a pending response carries an empty error', async () => {
  const stateDir = mkdtempForTestSync('agent-device-auth-pending-');
  let polls = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const result = loginAt(stateDir, async (url) => {
      if (String(url) === POLL && ++polls === 1) {
        return jsonResponse({ status: 'authorization_pending', error: '' });
      }
      return deviceAuthCloud(url);
    });
    const [login] = await Promise.all([result, vi.runAllTimersAsync()]);
    assert.equal(polls, 2);
    assert.equal(readCliSession({ stateDir })?.id, login.session.id);
  } finally {
    vi.useRealTimers();
  }
});
