import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  loginWithDeviceAuth,
  readCliSession,
  removeCliSession,
  resolveRemoteAuth,
  resolveCliSessionPath,
  summarizeCliSession,
  writeCliSession,
} from '../auth-session.ts';
import { normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  recordCommandSpawns,
  withMockedPlatform,
  type RecordedSpawn,
} from '../../__tests__/test-utils/host-execution.ts';

const baseFlags = {
  json: false,
  help: false,
  version: false,
  daemonBaseUrl: 'https://daemon.example',
  tenant: 'acme',
  runId: 'run-123',
};

test('remote auth uses AGENT_DEVICE_DAEMON_AUTH_TOKEN without login', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-env-');
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
  const tempRoot = mkdtempForTestSync('agent-device-auth-ci-');

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
  const tempRoot = mkdtempForTestSync('agent-device-auth-url-hint-');

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
  const tempRoot = mkdtempForTestSync('agent-device-auth-non-cloud-');
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
  const tempRoot = mkdtempForTestSync('agent-device-auth-refresh-');
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
  const tempRoot = mkdtempForTestSync('agent-device-auth-revoked-');
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
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-');
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
  const tempRoot = mkdtempForTestSync('agent-device-auth-summary-');
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

test('device login on Windows launches a verification URL containing & without a shell', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-win32-');
  const verificationUriComplete =
    'https://cloud.example/device?user_code=ABCD-EFGH&calc&next=%2Fstart';
  const launches = recordCommandSpawns();

  const login = await withMockedPlatform(
    'win32',
    async () =>
      await launches.run(
        async () =>
          await loginWithDeviceAuth({
            stateDir: tempRoot,
            flags: baseFlags,
            env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
            io: {
              stdinIsTTY: true,
              stdoutIsTTY: true,
              stderr: { write: () => true },
              fetch: deviceAuthFetch({ verificationUriComplete }),
            },
          }),
      ),
  );

  assert.equal(login.accessToken, 'adc_agent_login');
  assert.deepEqual(launches.spawns, [
    { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', verificationUriComplete] },
  ]);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('device login shows the verification URL when no browser launcher can run', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-launch-failure-');
  let stderr = '';
  const launches = recordCommandSpawns({ spawnFails: true });

  await withMockedPlatform(
    'win32',
    async () =>
      await launches.run(
        async () =>
          await loginWithDeviceAuth({
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
              fetch: deviceAuthFetch({}),
            },
          }),
      ),
  );

  assert.deepEqual(launches.spawns, [
    {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'https://cloud.example/authorize'],
    },
  ]);
  assert.match(stderr, /Open this URL on your machine:\nhttps:\/\/cloud\.example\/authorize\n/);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('device login falls back to verificationUri when the complete URI is blank', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-blank-complete-');
  for (const verificationUriComplete of [undefined, null, '']) {
    const opened: string[] = [];
    const login = await loginWithDeviceAuth({
      stateDir: tempRoot,
      flags: baseFlags,
      env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
      io: {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        openBrowser: async (url) => {
          opened.push(url);
        },
        stderr: { write: () => true },
        fetch: deviceAuthFetch({ verificationUriComplete }),
      },
    });
    assert.equal(login.accessToken, 'adc_agent_login');
    assert.deepEqual(opened, ['https://cloud.example/authorize']);
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('device login rejects a verification URI that is not an http(s) URL', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-bad-uri-');
  const refused = await runRefusedDeviceLogin({
    stateDir: tempRoot,
    startOverrides: {
      verificationUri: 'javascript:alert(document.cookie)',
      verificationUriComplete: 'https://cloud.example/device/ABCD-EFGH',
    },
  });

  assert.equal(refused.normalized.code, 'COMMAND_FAILED');
  assert.deepEqual(refused.normalized.details, { field: 'verificationUri' });
  assertRefusedWithoutOutput(refused);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('device login rejects a complete verification URI that is not an http(s) URL', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-bad-complete-uri-');
  const refused = await runRefusedDeviceLogin({
    stateDir: tempRoot,
    startOverrides: { verificationUriComplete: 'javascript:alert(document.cookie)' },
  });

  assert.deepEqual(refused.normalized.details, { field: 'verificationUriComplete' });
  assertRefusedWithoutOutput(refused);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('device login rejects a verification URI carrying terminal escape bytes before printing it', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-escaped-uri-');
  const refused = await runRefusedDeviceLogin({
    stateDir: tempRoot,
    env: {
      AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example',
      SSH_CONNECTION: '10.0.0.2 22 10.0.0.1 5',
    },
    startOverrides: {
      verificationUri:
        'https://cloud.example/\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007',
    },
  });

  assert.deepEqual(refused.normalized.details, { field: 'verificationUri' });
  assertRefusedWithoutOutput(refused);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('device login names the unusable field of a start response missing credentials', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-missing-credentials-');
  for (const missingField of ['deviceCode', 'userCode'] as const) {
    const refused = await runRefusedDeviceLogin({
      stateDir: tempRoot,
      startOverrides: { [missingField]: '' },
    });

    assert.deepEqual(refused.normalized.details, { field: missingField });
    assertRefusedWithoutOutput(refused);
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deviceAuthStartBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    deviceCode: 'device-secret',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://cloud.example/authorize',
    ...overrides,
  };
}

function deviceAuthFetch(startOverrides: Record<string, unknown>): typeof fetch {
  return async (url) =>
    String(url).endsWith('/api/control-plane/device-auth/start')
      ? jsonResponse(deviceAuthStartBody(startOverrides))
      : jsonResponse({
          status: 'approved',
          accessToken: 'adc_agent_login',
          cliSession: { id: 'session-4', refreshCredential: 'adc_refresh_login' },
        });
}

type RefusedDeviceLogin = {
  normalized: NormalizedError;
  stderr: string;
  spawns: RecordedSpawn[];
};

/** Runs a device login whose start response the auth guard must refuse, capturing what it showed
 * and what it would have spawned. */
async function runRefusedDeviceLogin(options: {
  stateDir: string;
  startOverrides: Record<string, unknown>;
  env?: Record<string, string>;
}): Promise<RefusedDeviceLogin> {
  let stderr = '';
  const launches = recordCommandSpawns();
  let normalized: NormalizedError | undefined;
  try {
    await launches.run(
      async () =>
        await loginWithDeviceAuth({
          stateDir: options.stateDir,
          flags: baseFlags,
          env: options.env ?? { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
          io: {
            stdinIsTTY: true,
            stdoutIsTTY: true,
            stderr: {
              write: (chunk: string) => {
                stderr += chunk;
                return true;
              },
            },
            fetch: deviceAuthFetch(options.startOverrides),
          },
        }),
    );
  } catch (error) {
    normalized = normalizeError(error);
  }
  assert.ok(normalized, 'expected the device-auth start response to be refused');
  return { normalized, stderr, spawns: launches.spawns };
}

function assertRefusedWithoutOutput(refused: RefusedDeviceLogin): void {
  assert.deepEqual(refused.spawns, []);
  assert.equal(refused.stderr, '');
}
