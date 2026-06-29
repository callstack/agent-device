import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loginWithDeviceAuth,
  readCliSession,
  removeCliSession,
  resolveRemoteAuth,
  resolveCliSessionPath,
  summarizeCliSession,
  writeCliSession,
} from '../auth-session.ts';
import { normalizeError } from '../../kernel/errors.ts';

const baseFlags = {
  json: false,
  help: false,
  version: false,
  daemonBaseUrl: 'https://daemon.example',
  tenant: 'acme',
  runId: 'run-123',
};

test('remote auth uses AGENT_DEVICE_DAEMON_AUTH_TOKEN without login', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-auth-env-'));
  const calls: string[] = [];
  const result = await resolveRemoteAuth({
    command: 'connect',
    flags: baseFlags,
    stateDir: tempRoot,
    allowInteractiveLogin: true,
    env: { AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'adc_live_service' },
    io: {
      fetch: async (url) => {
        calls.push(String(url));
        return jsonResponse({});
      },
    },
  });

  assert.equal(result.source, 'env');
  assert.deepEqual(calls, []);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('remote auth fails in CI with service token instructions', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-auth-ci-'));

  await assert.rejects(
    async () =>
      await resolveRemoteAuth({
        command: 'connect',
        flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
        stateDir: tempRoot,
        allowInteractiveLogin: true,
        env: { CI: 'true' },
        io: { stdinIsTTY: true, stdoutIsTTY: true },
      }),
    /cannot perform interactive login/,
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('non-interactive auth hint preserves safe API-token setup URL', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-auth-url-hint-'));

  try {
    await resolveRemoteAuth({
      command: 'connect',
      flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
      stateDir: tempRoot,
      allowInteractiveLogin: true,
      env: {
        CI: 'true',
        AGENT_DEVICE_CLOUD_BASE_URL: 'https://bridge.agent-device.dev',
      },
      io: { stdinIsTTY: true, stdoutIsTTY: true },
    });
    assert.fail('expected non-interactive auth to fail');
  } catch (error) {
    const normalized = normalizeError(error);
    assert.match(normalized.hint ?? '', /https:\/\/bridge\.agent-device\.dev\/api-keys/);
    assert.doesNotMatch(normalized.hint ?? '', /\[REDACTED\]/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('remote auth leaves non-cloud remote daemons to existing daemon auth validation', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-auth-non-cloud-'));
  writeCliSession({
    stateDir: tempRoot,
    session: {
      version: 1,
      id: 'session-non-cloud',
      cloudBaseUrl: 'https://cloud.example',
      refreshCredential: 'adc_refresh_should_not_be_used',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const result = await resolveRemoteAuth({
    command: 'connect',
    flags: baseFlags,
    stateDir: tempRoot,
    allowInteractiveLogin: true,
    env: {},
    io: {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      fetch: async () => {
        throw new Error('non-cloud remote daemons must not refresh cloud sessions');
      },
    },
  });

  assert.equal(result.source, 'none');
  assert.equal(result.flags.daemonAuthToken, undefined);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('remote auth refreshes a stored CLI session into an agent token', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-auth-refresh-'));
  writeCliSession({
    stateDir: tempRoot,
    session: {
      version: 1,
      id: 'session-1',
      cloudBaseUrl: 'https://cloud.example',
      workspaceId: 'acme',
      refreshCredential: 'adc_refresh_secret',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
    },
  });

  const bodies: unknown[] = [];
  const result = await resolveRemoteAuth({
    command: 'snapshot',
    flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
    stateDir: tempRoot,
    allowInteractiveLogin: false,
    env: {},
    io: {
      now: () => Date.parse('2026-02-01T00:00:00.000Z'),
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ accessToken: 'adc_agent_fresh', expiresAt: '2026-02-01T01:00:00Z' });
      },
    },
  });

  assert.equal(result.source, 'cli-session');
  assert.equal(result.flags.daemonAuthToken, 'adc_agent_fresh');
  assert.deepEqual(bodies, [
    {
      refreshCredential: 'adc_refresh_secret',
      tenant: 'acme',
      runId: 'run-123',
      daemonBaseUrl: 'https://bridge.agent-device.dev',
    },
  ]);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('remote auth fails immediately when stored CLI session is revoked', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-auth-revoked-'));
  writeCliSession({
    stateDir: tempRoot,
    session: {
      version: 1,
      id: 'session-revoked',
      cloudBaseUrl: 'https://cloud.example',
      refreshCredential: 'adc_refresh_revoked',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });

  await assert.rejects(
    async () =>
      await resolveRemoteAuth({
        command: 'connect',
        flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
        stateDir: tempRoot,
        allowInteractiveLogin: true,
        env: {},
        io: {
          fetch: async () => jsonResponse({ status: 'revoked' }),
        },
      }),
    /Stored cloud CLI session was revoked/,
  );

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('device login opens browser, stores CLI session, and returns agent token', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-auth-login-'));
  const opened: string[] = [];
  let stderr = '';
  const requests: string[] = [];
  const bodies: unknown[] = [];

  const login = await loginWithDeviceAuth({
    stateDir: tempRoot,
    flags: baseFlags,
    env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
    io: {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
      openBrowser: async (url) => {
        opened.push(url);
      },
      fetch: async (url, init) => {
        requests.push(String(url));
        bodies.push(JSON.parse(String(init?.body)));
        if (String(url).endsWith('/api/control-plane/device-auth/start')) {
          return jsonResponse({
            deviceCode: 'device-secret',
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://cloud.example/authorize',
            verificationUriComplete: 'https://cloud.example/device?user_code=ABCD-EFGH',
            expiresIn: 600,
            interval: 1,
          });
        }
        return jsonResponse({
          status: 'approved',
          accessToken: 'adc_agent_login',
          expiresAt: '2026-02-01T01:00:00Z',
          cliSession: {
            id: 'session-2',
            refreshCredential: 'adc_refresh_login',
            workspaceId: 'acme',
            accountId: 'acct-1',
            name: 'CLI on laptop',
            expiresAt: '2026-06-01T00:00:00Z',
          },
        });
      },
    },
  });

  assert.equal(login.accessToken, 'adc_agent_login');
  assert.deepEqual(opened, ['https://cloud.example/device?user_code=ABCD-EFGH']);
  assert.match(stderr, /Opening https:\/\/cloud\.example\/authorize/);
  assert.doesNotMatch(stderr, /ABCD-EFGH/);
  assert.deepEqual(requests, [
    'https://cloud.example/api/control-plane/device-auth/start',
    'https://cloud.example/api/control-plane/device-auth/poll',
  ]);
  assert.deepEqual(bodies[0], {
    client: 'agent-device',
    tenant: 'acme',
    runId: 'run-123',
    daemonBaseUrl: 'https://daemon.example',
  });
  assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_login');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(resolveCliSessionPath(tempRoot)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('auth summary and logout do not expose stored refresh credentials', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-auth-summary-'));
  writeCliSession({
    stateDir: tempRoot,
    session: {
      version: 1,
      id: 'session-3',
      cloudBaseUrl: 'https://cloud.example',
      refreshCredential: 'adc_refresh_hidden',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });

  const status = summarizeCliSession({ stateDir: tempRoot });
  assert.equal(status.authenticated, true);
  assert.equal(JSON.stringify(status).includes('adc_refresh_hidden'), false);
  assert.equal(removeCliSession({ stateDir: tempRoot }), true);
  assert.equal(summarizeCliSession({ stateDir: tempRoot }).authenticated, false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
