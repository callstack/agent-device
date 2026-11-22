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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A refresh of the stored session that records each request URL and answers with a token. */
function refreshWith(stateDir: string, env: Record<string, string>, requests: string[]) {
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
        cloudBaseUrl: 'https://cloud.example',
        issuerOrigin: 'https://cloud.example',
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
    assert.deepEqual(requests, ['https://cloud.example/api/control-plane/cli-session/refresh']);
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
      issuerOrigin: 'https://cloud.example',
      refreshCredential: 'adc_refresh_old',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeCliSession({ stateDir: tempRoot, session });
    const moved = {
      ...session,
      cloudBaseUrl: 'https://other-cloud.example',
      issuerOrigin: 'https://other-cloud.example',
    };

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

    const login = await loginWithDeviceAuth({
      stateDir: tempRoot,
      flags: baseFlags,
      env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example/' },
      io: {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stderr: { write: () => true },
        openBrowser: async () => {},
        fetch: async (url) =>
          String(url).endsWith('/device-auth/start')
            ? jsonResponse({
                deviceCode: 'device-secret',
                userCode: 'ABCD-EFGH',
                verificationUri: 'https://cloud.example/authorize',
              })
            : jsonResponse({
                status: 'approved',
                accessToken: 'adc_agent_login',
                cliSession: { id: 'session-new', refreshCredential: 'adc_refresh_new' },
              }),
      },
    });
    assert.equal(login.session.version, 2);
    assert.equal(login.session.issuerOrigin, 'https://cloud.example');

    const refreshed = await refreshWith(tempRoot, {}, requests);
    assert.equal(refreshed.flags.daemonAuthToken, 'adc_agent_fresh');
    assert.deepEqual(requests, ['https://cloud.example/api/control-plane/cli-session/refresh']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a session whose recorded issuer is not the origin of its URL is refused', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-origin-issuer-');
  try {
    writeRawSession(tempRoot, {
      version: 2,
      id: 'session-edited',
      cloudBaseUrl: 'https://cloud.example',
      issuerOrigin: 'https://other-cloud.example',
      refreshCredential: 'adc_refresh_other',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const requests: string[] = [];

    await assert.rejects(() => refreshWith(tempRoot, {}, requests), isIssuerUnverified);
    assert.deepEqual(requests, []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
