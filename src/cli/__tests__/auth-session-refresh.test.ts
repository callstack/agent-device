import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  loginWithDeviceAuth,
  readCliSession,
  resolveCliSessionPath,
  resolveRemoteAuth,
  writeCliSession,
} from '../auth-session.ts';
import * as hostKitFile from '@agent-device/host-kit/file';
import { acquireProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { normalizeError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const baseFlags = {
  json: false,
  help: false,
  version: false,
  daemonBaseUrl: 'https://daemon.example',
  tenant: 'acme',
  runId: 'run-123',
};

const refreshFlags = { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Writes a stored session the refresh commands can rotate. */
function writeStoredSession(stateDir: string, overrides: Record<string, unknown> = {}): void {
  writeCliSession({
    stateDir,
    session: {
      version: 2,
      id: 'session-refresh',
      cloudBaseUrl: 'https://cloud.example',
      refreshCredential: 'adc_refresh_old',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
  });
}

test('a session lock held by a logout keeps a credential read without the lock from being sent', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-locked-read-');
  writeStoredSession(tempRoot);
  const owner = readCurrentOwnerIdentity();
  const releaseLock = await acquireProcessLock({
    lockDirPath: `${resolveCliSessionPath(tempRoot)}.lock`,
    owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
    description: 'test logout',
  });
  const sentCredentials: unknown[] = [];
  const refresh = resolveRemoteAuth({
    command: 'snapshot',
    flags: { ...refreshFlags, noLogin: true },
    stateDir: tempRoot,
    allowInteractiveLogin: false,
    env: {},
    io: {
      fetch: async (_url, init) => {
        sentCredentials.push(JSON.parse(String(init?.body)).refreshCredential);
        return jsonResponse({ accessToken: 'adc_agent_1', refreshCredential: 'adc_refresh_new' });
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  // No request is sent while another process holds the lock, so no credential goes out unlocked.
  assert.deepEqual(sentCredentials, []);
  assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_old');
  // The logout's removal lands, and the lock is given back.
  fs.rmSync(resolveCliSessionPath(tempRoot));
  await releaseLock();

  await assert.rejects(
    async () => await refresh,
    (error: unknown) => normalizeError(error).code === 'UNAUTHORIZED',
  );
  // The refresh re-read after taking the lock, found no session, and never sent the credential.
  assert.deepEqual(sentCredentials, []);
  assert.equal(readCliSession({ stateDir: tempRoot }), null);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a login whose approved access token already expired returns a fresh one', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-expired-');
  const sent: unknown[] = [];
  const login = await loginWithDeviceAuth({
    stateDir: tempRoot,
    flags: baseFlags,
    env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
    io: {
      // The approval arrives after the token that came with it had already expired: a wait for
      // another process's session lock can spend longer than the token's life.
      now: () => Date.parse('2026-02-01T01:00:00.000Z'),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      openBrowser: async () => {},
      fetch: async (url, init) => {
        const href = String(url);
        if (href.endsWith('/device-auth/start')) {
          return jsonResponse({
            deviceCode: 'device-secret',
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://cloud.example/authorize',
            interval: 1,
          });
        }
        if (href.endsWith('/device-auth/poll')) {
          return jsonResponse({
            status: 'approved',
            accessToken: ' adc_agent_expired ',
            expiresAt: '2026-02-01T00:30:00.000Z',
            cliSession: {
              id: 'session-expired',
              refreshCredential: 'adc_refresh_login',
              expiresAt: '2026-06-01T00:00:00.000Z',
            },
          });
        }
        sent.push(JSON.parse(String(init?.body)).refreshCredential);
        return jsonResponse({
          accessToken: 'adc_agent_fresh',
          expiresAt: '2026-02-01T02:00:00.000Z',
        });
      },
    },
  });

  assert.equal(login.accessToken, 'adc_agent_fresh');
  assert.equal(login.expiresAt, '2026-02-01T02:00:00.000Z');
  // The exchange ran on the session the login had just saved.
  assert.deepEqual(sent, ['adc_refresh_login']);
  assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_login');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a refresh that answers with an expired access token is asked again, and no further', async () => {
  const run = async (responses: unknown[]) => {
    const tempRoot = mkdtempForTestSync('agent-device-auth-refresh-expired-');
    writeStoredSession(tempRoot);
    const sent: unknown[] = [];
    try {
      const result = await resolveRemoteAuth({
        command: 'snapshot',
        flags: refreshFlags,
        stateDir: tempRoot,
        allowInteractiveLogin: false,
        env: {},
        io: {
          now: () => Date.parse('2026-02-01T01:00:00.000Z'),
          fetch: async (_url, init) => {
            sent.push(JSON.parse(String(init?.body)).refreshCredential);
            return jsonResponse(responses.shift());
          },
        },
      });
      return { sent, token: result.flags.daemonAuthToken };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };
  const expired = {
    accessToken: ' adc_agent_expired ',
    expiresAt: '2026-02-01T00:30:00.000Z',
    refreshCredential: 'adc_refresh_new',
  };

  // The replacement credential is exchanged for a token that is not expired.
  const once = await run([
    expired,
    { accessToken: 'adc_agent_fresh', expiresAt: '2026-02-01T02:00:00.000Z' },
  ]);
  assert.equal(once.token, 'adc_agent_fresh');
  assert.deepEqual(once.sent, ['adc_refresh_old', 'adc_refresh_new']);

  // A cloud that keeps answering with an expired token is asked twice, then answered with.
  const endless = await run([expired, expired]);
  assert.equal(endless.token, 'adc_agent_expired');
  assert.deepEqual(endless.sent, ['adc_refresh_old', 'adc_refresh_new']);
});

test('a rotated credential is stored with the session expiry the refresh response carries', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-rotate-expiry-');
  writeStoredSession(tempRoot, { expiresAt: '2026-06-01T00:00:00.000Z' });
  const stored = readCliSession({ stateDir: tempRoot })!;

  await resolveRemoteAuth({
    command: 'snapshot',
    flags: refreshFlags,
    stateDir: tempRoot,
    allowInteractiveLogin: false,
    env: {},
    io: {
      now: () => Date.parse('2026-02-01T00:00:00.000Z'),
      fetch: async () =>
        jsonResponse({
          accessToken: 'adc_agent_1',
          // The access token's own expiry, which is not the session's.
          expiresAt: '2026-02-01T01:00:00.000Z',
          refreshCredential: 'adc_refresh_new',
          cliSession: { expiresAt: '2026-12-24T00:00:00.000Z' },
        }),
    },
  });

  assert.deepEqual(readCliSession({ stateDir: tempRoot }), {
    ...stored,
    refreshCredential: 'adc_refresh_new',
    // A session expiry that slides with use replaces the one recorded at login.
    expiresAt: '2026-12-24T00:00:00.000Z',
  });

  // An expiry that cannot be read is not stored: it would read back as an expired session and lock
  // the CLI out of one that still works. The rotation itself is kept.
  writeCliSession({
    stateDir: tempRoot,
    session: { ...stored, refreshCredential: 'adc_refresh_b' },
  });
  await resolveRemoteAuth({
    command: 'snapshot',
    flags: refreshFlags,
    stateDir: tempRoot,
    allowInteractiveLogin: false,
    env: {},
    io: {
      now: () => Date.parse('2026-02-01T00:00:00.000Z'),
      fetch: async () =>
        jsonResponse({
          accessToken: 'adc_agent_2',
          refreshCredential: 'adc_refresh_c',
          cliSession: { expiresAt: 'soon' },
        }),
    },
  });
  assert.deepEqual(readCliSession({ stateDir: tempRoot }), {
    ...stored,
    refreshCredential: 'adc_refresh_c',
  });
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a refresh response that reports revocation is refused even when it carries tokens', async () => {
  const refusal = async (revokedField: { status: string } | { error: string }) => {
    const tempRoot = mkdtempForTestSync('agent-device-auth-revoked-tokens-');
    writeStoredSession(tempRoot, {
      id: 'session-revoked-tokens',
      refreshCredential: 'adc_refresh_stored',
    });
    try {
      await assert.rejects(
        async () =>
          await resolveRemoteAuth({
            command: 'snapshot',
            flags: refreshFlags,
            stateDir: tempRoot,
            allowInteractiveLogin: false,
            env: {},
            io: {
              fetch: async () =>
                jsonResponse({
                  ...revokedField,
                  accessToken: 'adc_agent_rogue',
                  refreshCredential: 'adc_refresh_rogue',
                }),
            },
          }),
        /Stored cloud CLI session was revoked/,
      );
      assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_stored');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };

  await refusal({ status: 'revoked' });
  await refusal({ error: 'revoked' });
});

test('a store of the rotated credential that fails keeps the access token and warns', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-rotate-write-');
  writeStoredSession(tempRoot, { id: 'session-write' });
  const sessionPath = resolveCliSessionPath(tempRoot);
  const realPublish = hostKitFile.publishFileSync;
  const publish = vi.spyOn(hostKitFile, 'publishFileSync');
  try {
    // The publish of the session file fails; the lock records beside it still publish.
    publish.mockImplementation((options) => {
      if (options.destination === sessionPath) throw new Error('ENOSPC');
      return realPublish(options);
    });
    let warning = '';
    const result = await resolveRemoteAuth({
      command: 'snapshot',
      flags: refreshFlags,
      stateDir: tempRoot,
      allowInteractiveLogin: false,
      env: {},
      io: {
        stderr: {
          write: (chunk: string) => {
            warning += chunk;
            return true;
          },
        },
        fetch: async () =>
          jsonResponse({ accessToken: 'adc_agent_1', refreshCredential: 'adc_refresh_new' }),
      },
    });

    assert.equal(result.flags.daemonAuthToken, 'adc_agent_1');
    assert.match(warning, /could not be saved.*agent-device auth login/);
    assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_old');
  } finally {
    publish.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

/**
 * An approved login has its session saved before the token exchange runs, so an exchange that fails
 * transiently is not the login's failure: `auth login` printed a session, not a token. A caller that
 * sends the token itself cannot recover, so it reports the same failure.
 */
test('an expired approval token whose exchange fails transiently keeps the login and fails the caller that spends the token', async () => {
  const run = async (requiresLiveToken: boolean) => {
    const tempRoot = mkdtempForTestSync('agent-device-auth-login-exchange-503-');
    const warnings: string[] = [];
    const requestPaths: string[] = [];
    const io = {
      now: () => Date.parse('2026-02-01T01:00:00.000Z'),
      stdinIsTTY: true as const,
      stdoutIsTTY: true as const,
      stderr: {
        write: (chunk: string) => {
          warnings.push(chunk);
          return true;
        },
      },
      openBrowser: async () => {},
      fetch: async (url: URL | RequestInfo) => {
        const href = String(url);
        requestPaths.push(new URL(href).pathname);
        if (href.endsWith('/device-auth/start')) {
          return jsonResponse({
            deviceCode: 'device-secret',
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://cloud.example/authorize',
            interval: 1,
          });
        }
        if (href.endsWith('/device-auth/poll')) {
          return jsonResponse({
            status: 'approved',
            accessToken: ' adc_agent_expired ',
            // Past on the pinned clock: the login has to exchange this token.
            expiresAt: '2026-02-01T00:30:00.000Z',
            cliSession: { id: 'session-503', refreshCredential: 'adc_refresh_503' },
          });
        }
        return new Response('<html>private-body-secret</html>', { status: 503 });
      },
    };
    try {
      const outcome = await (async () => {
        if (!requiresLiveToken) {
          const login = await loginWithDeviceAuth({
            stateDir: tempRoot,
            flags: baseFlags,
            env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
            io,
          });
          return { accessToken: login.accessToken, expiresAt: login.expiresAt };
        }
        const resolved = await resolveRemoteAuth({
          command: 'connect',
          flags: refreshFlags,
          stateDir: tempRoot,
          allowInteractiveLogin: true,
          env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
          io,
        });
        return { accessToken: resolved.flags.daemonAuthToken, expiresAt: undefined };
      })();
      return {
        outcome,
        warnings,
        requestPaths,
        stored: readCliSession({ stateDir: tempRoot }),
      };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };

  // `auth login` printed a session: it reports success, without the expiry of a token the cloud
  // already said was expired, and the saved session is there for the next command.
  const login = await run(false);
  assert.equal(login.outcome.accessToken, 'adc_agent_expired');
  assert.equal(login.outcome.expiresAt, undefined);
  assert.equal(login.stored?.id, 'session-503');
  assert.match(login.warnings.join(''), /could not be exchanged for a live access token/);
  assert.deepEqual(login.requestPaths, [
    '/api/control-plane/device-auth/start',
    '/api/control-plane/device-auth/poll',
    '/api/control-plane/cli-session/refresh',
  ]);

  // `connect` sends the token it is handed, so the same 503 fails it.
  await assert.rejects(
    async () => await run(true),
    (error: unknown) => normalizeError(error).details?.status === 503,
  );
});

/**
 * The login's save and the exchange of an expired approval token share one acquisition of the
 * session lock, so a sibling login cannot write its own session between them and have its
 * credential exchanged here.
 */
test('a login that exchanges an expired approval token does it under the acquisition that saved the session', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-one-lock-');
  const realAcquire = hostKitFile.acquireProcessLock;
  const acquire = vi.spyOn(hostKitFile, 'acquireProcessLock');
  const events: string[] = [];
  const sent: unknown[] = [];
  try {
    acquire.mockImplementation((async (params) => {
      const release = await realAcquire(params);
      events.push('acquire');
      return async () => {
        events.push('release');
        await release();
      };
    }) as typeof acquire);
    const login = await loginWithDeviceAuth({
      stateDir: tempRoot,
      flags: baseFlags,
      env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
      io: {
        now: () => Date.parse('2026-02-01T01:00:00.000Z'),
        stdinIsTTY: true,
        stdoutIsTTY: true,
        openBrowser: async () => {},
        fetch: async (url, init) => {
          const href = String(url);
          if (href.endsWith('/device-auth/start')) {
            return jsonResponse({
              deviceCode: 'device-secret',
              userCode: 'ABCD-EFGH',
              verificationUri: 'https://cloud.example/authorize',
              interval: 1,
            });
          }
          if (href.endsWith('/device-auth/poll')) {
            return jsonResponse({
              status: 'approved',
              accessToken: ' adc_agent_expired ',
              expiresAt: '2026-02-01T00:30:00.000Z',
              cliSession: { id: 'session-one-lock', refreshCredential: 'adc_refresh_one' },
            });
          }
          events.push('refresh');
          sent.push(JSON.parse(String(init?.body)).refreshCredential);
          return jsonResponse({
            accessToken: 'adc_agent_live',
            expiresAt: '2026-02-01T02:00:00.000Z',
          });
        },
      },
    });

    assert.equal(login.accessToken, 'adc_agent_live');
    assert.deepEqual(sent, ['adc_refresh_one']);
    assert.deepEqual(events, ['acquire', 'refresh', 'release']);
  } finally {
    acquire.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parallel commands each send the stored credential, so a replacement is sent once', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-rotate-parallel-');
  writeStoredSession(tempRoot, { id: 'session-parallel' });
  // The cloud's side of the contract: the first request gets the one replacement; a request that
  // presents the replaced credential is refused, which a serialized refresh never does.
  const sent: unknown[] = [];
  const refresh = () =>
    resolveRemoteAuth({
      command: 'snapshot',
      flags: refreshFlags,
      stateDir: tempRoot,
      allowInteractiveLogin: false,
      env: {},
      io: {
        fetch: async (_url, init) => {
          const credential = JSON.parse(String(init?.body)).refreshCredential;
          sent.push(credential);
          return jsonResponse(
            credential === 'adc_refresh_old'
              ? { accessToken: 'adc_agent_a', refreshCredential: 'adc_refresh_new' }
              : { accessToken: 'adc_agent_b' },
          );
        },
      },
    });

  const both = await Promise.all([refresh(), refresh()]);
  const tokens = both.map((result) => result.flags.daemonAuthToken);

  // The second command waited for the first to store, and read the replacement off the file.
  assert.deepEqual(tokens, ['adc_agent_a', 'adc_agent_b']);
  assert.deepEqual(sent, ['adc_refresh_old', 'adc_refresh_new']);
  assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_new');
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
