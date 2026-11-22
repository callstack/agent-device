import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  loginWithDeviceAuth,
  readCliSession,
  resolveRemoteAuth,
  writeCliSession,
} from '../auth-session.ts';
import * as hostKitFile from '@agent-device/host-kit/file';
import { normalizeError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const baseFlags = {
  json: false,
  help: false,
  version: false,
  daemonBaseUrl: 'https://bridge.agent-device.dev',
  tenant: 'acme',
  runId: 'run-123',
};

/** Pinned clock: every expiry before `2026-02-01T01:00:00.000Z` used in this file is past. */
const now = () => Date.parse('2026-02-01T01:00:00.000Z');
const expiredToken = { accessToken: 'adc_agent_expired', expiresAt: '2026-02-01T00:30:00.000Z' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function writeStoredSession(stateDir: string, overrides: Record<string, unknown> = {}): void {
  writeCliSession({
    stateDir,
    session: {
      version: 1,
      id: 'session-pairing',
      cloudBaseUrl: 'https://cloud.example',
      refreshCredential: 'adc_refresh_old',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
  });
}

/**
 * A device-code login whose approval has arrived with an access token this file's clock calls
 * expired, so the login goes on to exchange it, and a refresh endpoint answering with `responses`.
 */
function deviceAuthIo(options: {
  refreshResponses: Response[];
  warnings: string[];
  requestPaths: string[];
}) {
  const { refreshResponses, warnings, requestPaths } = options;
  return {
    now,
    stdinIsTTY: true as const,
    stdoutIsTTY: true as const,
    stderr: {
      write: (chunk: string) => {
        warnings.push(chunk);
        return true;
      },
    },
    openBrowser: async () => {},
    fetch: async (url: URL | RequestInfo): Promise<Response> => {
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
          ...expiredToken,
          cliSession: {
            id: 'session-pairing',
            refreshCredential: 'adc_refresh_login',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        });
      }
      return refreshResponses.shift() ?? jsonResponse({});
    },
  };
}

/**
 * A refresh whose access token the CLI's own clock calls expired is still the token the cloud would
 * accept, so the command uses it: the exchange that asks again is optional, and a transient failure
 * of it cannot take that token back. A response that reports revocation is never transient.
 */
test('an optional second exchange that fails transiently keeps the token already answered', async () => {
  const run = async (secondResponse: Response) => {
    const tempRoot = mkdtempForTestSync('agent-device-auth-optional-exchange-');
    writeStoredSession(tempRoot);
    const sent: unknown[] = [];
    try {
      const resolved = await resolveRemoteAuth({
        command: 'snapshot',
        flags: baseFlags,
        stateDir: tempRoot,
        allowInteractiveLogin: false,
        env: {},
        io: {
          now,
          fetch: async (_url, init) => {
            sent.push(JSON.parse(String(init?.body)).refreshCredential);
            return sent.length === 1 ? jsonResponse(expiredToken) : secondResponse;
          },
        },
      });
      return { sent, token: resolved.flags.daemonAuthToken, error: undefined as unknown };
    } catch (error) {
      return { sent, token: undefined, error };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };

  const unavailable = await run(new Response('<html>unavailable</html>', { status: 503 }));
  assert.equal(unavailable.token, 'adc_agent_expired');
  assert.deepEqual(unavailable.sent, ['adc_refresh_old', 'adc_refresh_old']);
  assert.equal(unavailable.error, undefined);

  // A transport failure of the optional exchange is transient as well.
  const offline = await run(Promise.reject(new Error('offline')) as unknown as Response);
  assert.equal(offline.token, 'adc_agent_expired');

  // The token is kept, so a session the cloud reports revoked is still refused.
  const revoked = await run(jsonResponse({ status: 'revoked' }));
  assert.equal(revoked.token, undefined);
  assert.equal(normalizeError(revoked.error).details?.reason, 'cli_session_revoked');
});

/**
 * Only a nonempty string is the approval's access-token expiry. A response that carries any other
 * value has it omitted: the login neither reads liveness from a value it cannot read nor prints an
 * expiry no token was issued against.
 */
test('an approval whose access-token expiry is not a string is reported without an expiry', async () => {
  const run = async (expiresAt: unknown) => {
    const tempRoot = mkdtempForTestSync('agent-device-auth-approval-expiry-type-');
    const requestPaths: string[] = [];
    try {
      const login = await loginWithDeviceAuth({
        stateDir: tempRoot,
        flags: baseFlags,
        env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
        io: {
          now,
          stdinIsTTY: true,
          stdoutIsTTY: true,
          stderr: { write: () => true },
          openBrowser: async () => {},
          fetch: async (url): Promise<Response> => {
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
                accessToken: 'adc_agent_approved',
                // Neither of the values a real approval sends. Read as an expiry, the object is an
                // unparseable timestamp, which says expired, and the number is a date far ahead of
                // the pinned clock, which says live and gets printed.
                expiresAt,
                cliSession: {
                  id: 'session-pairing',
                  refreshCredential: 'adc_refresh_login',
                  expiresAt: '2099-01-01T00:00:00.000Z',
                },
              });
            }
            return jsonResponse({ accessToken: 'adc_agent_exchanged' });
          },
        },
      });
      return { login, requestPaths };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };

  // The value is omitted, so nothing tells this login its token is expired: it keeps the approved
  // pair and asks for nothing.
  const object = await run({});
  assert.equal(object.login.accessToken, 'adc_agent_approved');
  assert.equal(object.login.expiresAt, undefined);
  assert.deepEqual(object.requestPaths, [
    '/api/control-plane/device-auth/start',
    '/api/control-plane/device-auth/poll',
  ]);

  // The number is omitted as well, so no expiry is reported for a token nothing issued it against.
  const number = await run(2272143600000);
  assert.equal(number.login.accessToken, 'adc_agent_approved');
  assert.equal(number.login.expiresAt, undefined);

  // The saved session's expiry comes from the session object, which is read the same way.
  assert.equal(object.login.session.expiresAt, '2099-01-01T00:00:00.000Z');
});

/**
 * The login reports the session it saved. A rotation the cloud handed over that the disk refused was
 * not saved, so it is not reported: the credential is still asked with next time, and the token
 * keeps the expiry that arrived with it.
 */
test('a login whose rotation could not be saved reports the record on disk and its own token expiry', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-unsaved-rotation-');
  const sessionPath = `${tempRoot}/auth/cli-session.json`;
  const realPublish = hostKitFile.publishFileSync;
  const publish = vi.spyOn(hostKitFile, 'publishFileSync');
  try {
    // The login's own write lands; the write of the rotation does not.
    let writesToSessionFile = 0;
    publish.mockImplementation((options) => {
      if (options.destination === sessionPath) {
        writesToSessionFile += 1;
        if (writesToSessionFile > 1) throw new Error('ENOSPC');
      }
      return realPublish(options);
    });
    const warnings: string[] = [];
    const requestPaths: string[] = [];
    const login = await loginWithDeviceAuth({
      stateDir: tempRoot,
      flags: baseFlags,
      env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
      io: deviceAuthIo({
        warnings,
        requestPaths,
        refreshResponses: [
          jsonResponse({
            accessToken: 'adc_agent_live',
            expiresAt: '2026-02-01T02:00:00.000Z',
            refreshCredential: 'adc_refresh_rotated',
            cliSession: { expiresAt: '2099-12-24T00:00:00.000Z' },
          }),
        ],
      }),
    });

    // The token the exchange answered with, with the expiry that arrived with it.
    assert.equal(login.accessToken, 'adc_agent_live');
    assert.equal(login.expiresAt, '2026-02-01T02:00:00.000Z');
    // The record reported is the one the file holds, not the one the failed write would have made.
    const stored = readCliSession({ stateDir: tempRoot })!;
    assert.deepEqual(
      {
        id: login.session.id,
        refreshCredential: login.session.refreshCredential,
        expiresAt: login.session.expiresAt,
      },
      {
        id: stored.id,
        refreshCredential: stored.refreshCredential,
        expiresAt: stored.expiresAt,
      },
    );
    assert.equal(login.session.refreshCredential, 'adc_refresh_login');
    assert.equal(login.session.expiresAt, '2099-01-01T00:00:00.000Z');
    assert.equal(
      JSON.stringify(login.session).includes('2099-12-24'),
      false,
      'the expiry of a rotation that was not saved is not reported',
    );
    assert.match(warnings.join(''), /renewed CLI session could not be saved/);
    assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_login');
  } finally {
    publish.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

/**
 * When the optional second exchange fails, the login still reports the record its first exchange
 * stored: the session expiry `auth status` will show, not the one the approval wrote.
 */
test('a login whose second exchange fails reports the session its first exchange stored', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-login-rotated-then-503-');
  const warnings: string[] = [];
  const requestPaths: string[] = [];
  try {
    const login = await loginWithDeviceAuth({
      stateDir: tempRoot,
      flags: baseFlags,
      env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
      io: deviceAuthIo({
        warnings,
        requestPaths,
        refreshResponses: [
          // The rotation is stored, and the access token comes back expired on this clock, so a
          // second exchange is asked for and fails.
          jsonResponse({
            ...expiredToken,
            refreshCredential: 'adc_refresh_rotated',
            cliSession: { expiresAt: '2099-12-24T00:00:00.000Z' },
          }),
          new Response('<html>unavailable</html>', { status: 503 }),
        ],
      }),
    });

    assert.deepEqual(login.session, readCliSession({ stateDir: tempRoot }));
    assert.equal(login.session.refreshCredential, 'adc_refresh_rotated');
    assert.equal(login.session.expiresAt, '2099-12-24T00:00:00.000Z');
    // The token kept is the one the cloud answered, with its own expiry.
    assert.equal(login.accessToken, 'adc_agent_expired');
    assert.equal(login.expiresAt, '2026-02-01T00:30:00.000Z');
    // Nothing was lost: the login is not told to sign in again.
    assert.equal(warnings.join('').includes('could not be'), false);
    assert.deepEqual(requestPaths.slice(2), [
      '/api/control-plane/cli-session/refresh',
      '/api/control-plane/cli-session/refresh',
    ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
