import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  loginWithDeviceAuth,
  readCliSession,
  resolveCliSessionPath,
  resolveCloudAccessForConnect,
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

test.each([{ status: 'denied' }, { status: 'approved', error: 'response-secret' }])(
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

test('authorization can succeed with credentials and no status or error', async () => {
  const stateDir = mkdtempForTestSync('agent-device-auth-token-only-');
  const login = await loginAt(stateDir, async (url) =>
    String(url) === POLL ? jsonResponse(suppliedCredentials) : deviceAuthCloud(url),
  );
  assert.equal(login.accessToken, suppliedCredentials.accessToken);
  assert.equal(readCliSession({ stateDir })?.id, suppliedCredentials.cliSession.id);
});

test('legacy cloud connection identity keeps the validated URL path', async () => {
  const result = await resolveCloudAccessForConnect({
    stateDir: mkdtempForTestSync('agent-device-auth-path-'),
    flags: { ...baseFlags, daemonAuthToken: 'fixture-token' },
    env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example/console/' },
  });
  assert.equal(result.cloudBaseUrl, 'https://cloud.example/console');
});
