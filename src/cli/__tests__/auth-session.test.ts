import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import * as hostKitFile from '@agent-device/host-kit/file';
import { acquireProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import {
  mkdtempForTestSync,
  recordCommandSpawns,
  type RecordedSpawn,
  withMockedPlatform,
} from '@agent-device/test-kit';

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
      acceptsRotatedRefreshCredential: true,
      tenant: 'acme',
      runId: 'run-123',
      daemonBaseUrl: 'https://bridge.agent-device.dev',
    },
  ]);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('remote auth stores a refresh credential that the cloud rotated', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-rotate-');
  const session = {
    version: 1 as const,
    id: 'session-rotate',
    cloudBaseUrl: 'https://cloud.example',
    refreshCredential: 'adc_refresh_old',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
  };
  writeCliSession({ stateDir: tempRoot, session });
  const sent: unknown[] = [];
  const responses = [
    { accessToken: 'adc_agent_1', refreshCredential: 'adc_refresh_new' },
    { accessToken: 'adc_agent_2' },
  ];
  const refresh = () =>
    resolveRemoteAuth({
      command: 'snapshot',
      flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
      stateDir: tempRoot,
      allowInteractiveLogin: false,
      env: {},
      io: {
        now: () => Date.parse('2026-02-01T00:00:00.000Z'),
        fetch: async (_url, init) => {
          sent.push(JSON.parse(String(init?.body)).refreshCredential);
          return jsonResponse(responses.shift());
        },
      },
    });

  assert.equal((await refresh()).flags.daemonAuthToken, 'adc_agent_1');
  assert.deepEqual(readCliSession({ stateDir: tempRoot }), {
    ...session,
    refreshCredential: 'adc_refresh_new',
  });
  // The next command sends the rotated credential; a response without one keeps it.
  assert.equal((await refresh()).flags.daemonAuthToken, 'adc_agent_2');
  assert.deepEqual(sent, ['adc_refresh_old', 'adc_refresh_new']);
  assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('parallel commands under the rotation contract leave the one replacement stored', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-rotate-parallel-');
  const session = {
    version: 1 as const,
    id: 'session-parallel',
    cloudBaseUrl: 'https://cloud.example',
    refreshCredential: 'adc_refresh_old',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  writeCliSession({ stateDir: tempRoot, session });
  // The cloud's side of the contract: the first request gets the one replacement; a request
  // that still presents the replaced credential gets an access token and no replacement.
  let rotated = false;
  const release: Array<() => void> = [];
  const refresh = () =>
    resolveRemoteAuth({
      command: 'snapshot',
      flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
      stateDir: tempRoot,
      allowInteractiveLogin: false,
      env: {},
      io: {
        fetch: async (_url, init) => {
          const sent = JSON.parse(String(init?.body)).refreshCredential;
          const first = sent === 'adc_refresh_old' && !rotated;
          rotated = true;
          // Both requests are in flight before either response is stored.
          await new Promise<void>((resolve) => release.push(resolve));
          return jsonResponse(
            first
              ? { accessToken: 'adc_agent_a', refreshCredential: 'adc_refresh_new' }
              : { accessToken: 'adc_agent_b' },
          );
        },
      },
    });

  const both = [refresh(), refresh()];
  while (release.length < 2) await Promise.resolve();
  // The command without a replacement finishes first, then the one that holds it.
  release[1]!();
  release[0]!();
  const tokens = (await Promise.all(both)).map((result) => result.flags.daemonAuthToken);

  assert.deepEqual(tokens, ['adc_agent_a', 'adc_agent_b']);
  assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a rotated credential does not replace a session that changed during the refresh', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-rotate-race-');
  const session = {
    version: 1 as const,
    id: 'session-race',
    cloudBaseUrl: 'https://cloud.example',
    refreshCredential: 'adc_refresh_old',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const refreshWhile = (
    change: () => void,
    response: object,
    stderr?: { write: (chunk: string) => boolean },
  ) =>
    resolveRemoteAuth({
      command: 'snapshot',
      flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
      stateDir: tempRoot,
      allowInteractiveLogin: false,
      env: {},
      io: {
        stderr,
        fetch: async () => {
          change();
          return jsonResponse(response);
        },
      },
    });
  const rotated = { accessToken: 'adc_agent_1', refreshCredential: 'adc_refresh_late' };

  // Another command stored its own rotated credential first.
  writeCliSession({ stateDir: tempRoot, session });
  const other = { ...session, refreshCredential: 'adc_refresh_other' };
  await refreshWhile(() => writeCliSession({ stateDir: tempRoot, session: other }), rotated);
  assert.deepEqual(readCliSession({ stateDir: tempRoot }), other);

  // A logout during the refresh stays a logout.
  writeCliSession({ stateDir: tempRoot, session });
  await refreshWhile(() => removeCliSession({ stateDir: tempRoot }), rotated);
  assert.equal(readCliSession({ stateDir: tempRoot }), null);

  // A cloud that returns the same credential causes no write.
  writeCliSession({ stateDir: tempRoot, session });
  const before = fs.statSync(resolveCliSessionPath(tempRoot)).ino;
  await refreshWhile(() => {}, {
    accessToken: 'adc_agent_2',
    refreshCredential: 'adc_refresh_old',
  });
  assert.equal(fs.statSync(resolveCliSessionPath(tempRoot)).ino, before);

  // A write that fails keeps the access token and warns.
  if (process.platform !== 'win32') {
    const authDir = path.dirname(resolveCliSessionPath(tempRoot));
    let warning = '';
    fs.chmodSync(authDir, 0o500);
    try {
      const result = await refreshWhile(() => {}, rotated, {
        write: (chunk: string) => {
          warning += chunk;
          return true;
        },
      });
      assert.equal(result.flags.daemonAuthToken, 'adc_agent_1');
      assert.match(warning, /could not be saved.*agent-device auth login/);
    } finally {
      fs.chmodSync(authDir, 0o700);
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a rotated credential waits for a logout that holds the session file lock', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-rotate-lock-');
  writeCliSession({
    stateDir: tempRoot,
    session: {
      version: 1,
      id: 'session-lock',
      cloudBaseUrl: 'https://cloud.example',
      refreshCredential: 'adc_refresh_old',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const owner = readCurrentOwnerIdentity();
  const releaseLock = await acquireProcessLock({
    lockDirPath: `${resolveCliSessionPath(tempRoot)}.lock`,
    owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
    description: 'test logout',
  });
  let responded!: () => void;
  const response = new Promise<void>((resolve) => (responded = resolve));
  const refresh = resolveRemoteAuth({
    command: 'snapshot',
    flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
    stateDir: tempRoot,
    allowInteractiveLogin: false,
    env: {},
    io: {
      fetch: async () => {
        responded();
        return jsonResponse({ accessToken: 'adc_agent_1', refreshCredential: 'adc_refresh_new' });
      },
    },
  });

  await response;
  await new Promise((resolve) => setTimeout(resolve, 200));
  // The store has not written while the logout holds the lock.
  assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_old');
  fs.rmSync(resolveCliSessionPath(tempRoot));
  await releaseLock();

  assert.equal((await refresh).flags.daemonAuthToken, 'adc_agent_1');
  assert.equal(readCliSession({ stateDir: tempRoot }), null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('logout without a stored session takes no lock and writes nothing', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-logout-empty-');

  assert.equal(await removeCliSession({ stateDir: tempRoot }), false);
  assert.equal(fs.existsSync(path.dirname(resolveCliSessionPath(tempRoot))), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a stored rotation is kept when the lock release fails, and the warning is best effort', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-release-');
  const session = {
    version: 1 as const,
    id: 'session-release',
    cloudBaseUrl: 'https://cloud.example',
    refreshCredential: 'adc_refresh_old',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const failingRelease = async () => {
    throw new Error('lock standing under a spent claim');
  };
  const acquire = vi.spyOn(hostKitFile, 'acquireProcessLock');
  const refresh = (stderr: { write: (chunk: string) => boolean }) =>
    resolveRemoteAuth({
      command: 'snapshot',
      flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
      stateDir: tempRoot,
      allowInteractiveLogin: false,
      env: {},
      io: {
        stderr,
        fetch: async () =>
          jsonResponse({ accessToken: 'adc_agent_1', refreshCredential: 'adc_refresh_new' }),
      },
    });

  try {
    writeCliSession({ stateDir: tempRoot, session });
    acquire.mockResolvedValueOnce(failingRelease);
    const warnings: string[] = [];
    const result = await refresh({ write: (chunk) => warnings.push(chunk) > 0 });
    assert.equal(result.flags.daemonAuthToken, 'adc_agent_1');
    assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_new');
    assert.match(warnings.join(''), /lock could not be released cleanly/);

    // A stderr that throws does not fail the change either.
    writeCliSession({ stateDir: tempRoot, session });
    acquire.mockResolvedValueOnce(failingRelease);
    const thrown = await refresh({
      write: () => {
        throw new Error('EPIPE');
      },
    });
    assert.equal(thrown.flags.daemonAuthToken, 'adc_agent_1');
    assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_new');
  } finally {
    acquire.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a timed-out session lock wait keeps waiting and never drops a rotated credential or a login', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-lock-timeout-');
  const timeout = new AppError('COMMAND_FAILED', 'Timed out waiting for cloud CLI session file', {
    reason: 'process_lock_timeout',
  });
  const acquire = vi.spyOn(hostKitFile, 'acquireProcessLock');
  const warnings: string[] = [];
  const stderr = { write: (chunk: string) => warnings.push(chunk) > 0 };
  try {
    writeCliSession({
      stateDir: tempRoot,
      session: {
        version: 1,
        id: 'session-timeout',
        cloudBaseUrl: 'https://cloud.example',
        refreshCredential: 'adc_refresh_old',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    acquire.mockRejectedValueOnce(timeout);
    let refreshes = 0;
    await resolveRemoteAuth({
      command: 'snapshot',
      flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
      stateDir: tempRoot,
      allowInteractiveLogin: false,
      env: {},
      io: {
        stderr,
        fetch: async () => {
          refreshes += 1;
          return jsonResponse({ accessToken: 'adc_agent_1', refreshCredential: 'adc_refresh_new' });
        },
      },
    });
    assert.equal(refreshes, 1);
    assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_new');

    acquire.mockRejectedValueOnce(timeout);
    let approvals = 0;
    await loginWithDeviceAuth({
      stateDir: tempRoot,
      flags: baseFlags,
      env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
      io: {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stderr,
        openBrowser: async () => {},
        fetch: async (url) => {
          if (String(url).endsWith('/device-auth/start')) {
            approvals += 1;
            return jsonResponse({
              deviceCode: 'device-secret',
              userCode: 'ABCD-EFGH',
              verificationUri: 'https://cloud.example/authorize',
              expiresIn: 600,
              interval: 1,
            });
          }
          return jsonResponse({
            status: 'approved',
            accessToken: 'adc_agent_login',
            cliSession: { id: 'session-login', refreshCredential: 'adc_refresh_login' },
          });
        },
      },
    });
    assert.equal(approvals, 1);
    assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_login');
    assert.equal(
      warnings.filter((line) => line.startsWith('Waiting for another agent-device process')).length,
      2,
    );
  } finally {
    acquire.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('device login does not print a user code that carries control characters', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-code-');
  let stderr = '';
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
      openBrowser: async () => {},
      fetch: async (url) =>
        String(url).endsWith('/start')
          ? jsonResponse({
              deviceCode: 'device-secret',
              userCode: 'AB\u001b[2JCD',
              verificationUri: 'https://cloud.example/authorize',
              interval: 1,
            })
          : jsonResponse({
              status: 'approved',
              accessToken: 'adc_agent_login',
              cliSession: { id: 'session-code', refreshCredential: 'adc_refresh_login' },
            }),
    },
  });
  assert.equal(stderr, 'Opening https://cloud.example/authorize...\n');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('remote auth does not fall back to login when session refresh gets 503', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-refresh-503-');
  const session = {
    version: 1 as const,
    id: 'session-503',
    cloudBaseUrl: 'https://cloud.example',
    refreshCredential: 'adc_refresh_503',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  writeCliSession({ stateDir: tempRoot, session });
  let fetchCalls = 0;
  let browserOpened = false;
  try {
    await assert.rejects(
      resolveRemoteAuth({
        command: 'connect',
        flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
        stateDir: tempRoot,
        allowInteractiveLogin: true,
        env: {},
        io: {
          stdinIsTTY: true,
          stdoutIsTTY: true,
          openBrowser: async () => {
            browserOpened = true;
          },
          fetch: async () => {
            fetchCalls += 1;
            return new Response('<html>private-body-secret</html>', { status: 503 });
          },
        },
      }),
      (error: unknown) => {
        const normalized = normalizeError(error);
        assert.equal(normalized.code, 'COMMAND_FAILED');
        assert.equal(normalized.details?.status, 503);
        assert.equal(normalized.retriable, true);
        return true;
      },
    );
    assert.equal(fetchCalls, 1);
    assert.equal(browserOpened, false);
    assert.equal(readCliSession({ stateDir: tempRoot })?.id, session.id);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
  assert.match(stderr, /Confirm that the browser shows this code: ABCD-EFGH\n/);
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

test('auth summary and logout do not expose stored refresh credentials', async () => {
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
  assert.equal(await removeCliSession({ stateDir: tempRoot }), true);
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

test('a rewritten CLI session replaces the file, so a reader never sees a partial record', () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-session-replace-');
  const session = {
    version: 1 as const,
    id: 'session-first',
    cloudBaseUrl: 'https://cloud.example',
    refreshCredential: 'adc_refresh_first',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  try {
    writeCliSession({ stateDir: tempRoot, session });
    const sessionPath = resolveCliSessionPath(tempRoot);
    fs.chmodSync(sessionPath, 0o644);
    const openedBeforeRewrite = fs.openSync(sessionPath, 'r');
    try {
      writeCliSession({ stateDir: tempRoot, session: { ...session, id: 'session-second' } });
      assert.equal(JSON.parse(fs.readFileSync(openedBeforeRewrite, 'utf8')).id, 'session-first');
    } finally {
      fs.closeSync(openedBeforeRewrite);
    }
    assert.equal(readCliSession({ stateDir: tempRoot })?.id, 'session-second');
    if (process.platform !== 'win32') assert.equal(fs.statSync(sessionPath).mode & 0o077, 0);
    assert.deepEqual(fs.readdirSync(path.dirname(sessionPath)), [path.basename(sessionPath)]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
