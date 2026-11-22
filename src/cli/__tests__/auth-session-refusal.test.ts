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

/** The credential a hostile response can echo back in a field the CLI does not recognize. */
const ECHOED_CREDENTIAL = 'adc_echoed_opaque_credential';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function writeStoredSession(stateDir: string): void {
  writeCliSession({
    stateDir,
    session: {
      version: 2,
      id: 'session-refusal',
      cloudBaseUrl: 'https://cloud.example',
      issuerOrigin: 'https://cloud.example',
      refreshCredential: 'adc_refresh_stored',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
}

function refreshWithResponse(stateDir: string, body: unknown): Promise<unknown> {
  return resolveRemoteAuth({
    command: 'snapshot',
    flags: baseFlags,
    stateDir,
    allowInteractiveLogin: false,
    env: {},
    io: { fetch: async () => jsonResponse(body) },
  });
}

/**
 * A refresh refusal carries the reason this CLI declares and nothing the response supplied: the
 * cloud's `status` and `error` are its text, and under those keys the redaction step does not
 * recognize an opaque credential, so `--json` would print one. Only the exact `revoked` marker is
 * confirmed revocation; an answer without an access token gets the tokenless reason.
 */
test('a refused refresh carries its reason and no text from the response', async () => {
  const revoked = 'cli_session_revoked';
  const tokenless = 'cli_session_refresh_unanswered';
  const refusals: Array<{ name: string; body: unknown; reason: string }> = [
    {
      name: 'revoked with tokens and an echoed credential in error',
      body: { status: 'revoked', error: ECHOED_CREDENTIAL, accessToken: 'adc_agent_rogue' },
      reason: revoked,
    },
    {
      name: 'revoked with tokens and an echoed credential in status',
      body: { status: ECHOED_CREDENTIAL, error: 'revoked', accessToken: 'adc_agent_rogue' },
      reason: revoked,
    },
    {
      name: 'no token and an echoed credential in error',
      body: { status: 'unknown_status', error: ECHOED_CREDENTIAL },
      reason: tokenless,
    },
    {
      name: 'no token and an echoed credential in status',
      body: { status: ECHOED_CREDENTIAL, error: 'unknown_error' },
      reason: tokenless,
    },
    {
      name: 'a successful answer that carries no access token',
      body: { cliSession: { expiresAt: '2026-12-24T00:00:00.000Z' } },
      reason: tokenless,
    },
  ];

  for (const { name, body, reason } of refusals) {
    const tempRoot = mkdtempForTestSync('agent-device-auth-refusal-');
    writeStoredSession(tempRoot);
    try {
      await assert.rejects(
        async () => await refreshWithResponse(tempRoot, body),
        (error: unknown) => {
          const normalized = normalizeError(error);
          assert.equal(normalized.code, 'UNAUTHORIZED', name);
          assert.equal(normalized.details?.reason, reason, name);
          assert.equal(normalized.details?.status, undefined, name);
          assert.equal(normalized.details?.error, undefined, name);
          // The recovery hint is this CLI's own.
          assert.match(normalized.hint ?? '', /agent-device auth login/, name);
          // Neither the message nor any serialized detail can carry the echoed value.
          assert.equal(JSON.stringify(normalized).includes(ECHOED_CREDENTIAL), false, name);
          return true;
        },
        name,
      );
      // A refusal stores nothing: the session stays as it was.
      assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_stored');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

test('an approval that reports revocation over HTTP is refused and never echoes its body', async () => {
  const revokedBodies: unknown[] = [
    { status: 'revoked', error: ECHOED_CREDENTIAL },
    { status: ECHOED_CREDENTIAL, error: 'revoked' },
  ];
  for (const body of revokedBodies) {
    for (const status of [401, 403, 503]) {
      const tempRoot = mkdtempForTestSync('agent-device-auth-revoked-http-');
      writeStoredSession(tempRoot);
      try {
        await assert.rejects(
          async () =>
            await resolveRemoteAuth({
              command: 'snapshot',
              flags: baseFlags,
              stateDir: tempRoot,
              allowInteractiveLogin: false,
              env: {},
              io: { fetch: async () => new Response(JSON.stringify(body), { status }) },
            }),
          (error: unknown) => {
            const normalized = normalizeError(error);
            assert.equal(normalized.code, 'UNAUTHORIZED', `${status} ${JSON.stringify(body)}`);
            assert.equal(
              normalized.details?.reason,
              'cli_session_revoked',
              `${status} ${JSON.stringify(body)}`,
            );
            // The generic status details are not attached to a classified refusal, and no text from
            // the body accompanies it.
            assert.equal(normalized.details?.status, undefined, `${status}`);
            assert.equal(
              JSON.stringify(normalized).includes(ECHOED_CREDENTIAL),
              false,
              `${status}`,
            );
            return true;
          },
        );
        assert.equal(
          readCliSession({ stateDir: tempRoot })?.refreshCredential,
          'adc_refresh_stored',
        );
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  }
});

/**
 * A rejected response that does not carry this CLI's exact `revoked` marker keeps the generic HTTP
 * refusal, so a transient status stays retriable and a credential echoed in its body stays out of it.
 */
test('a rejected refresh without the revocation marker keeps the generic status refusal', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-revoked-http-plain-');
  writeStoredSession(tempRoot);
  try {
    await assert.rejects(
      async () =>
        await resolveRemoteAuth({
          command: 'snapshot',
          flags: baseFlags,
          stateDir: tempRoot,
          allowInteractiveLogin: false,
          env: {},
          io: {
            fetch: async () =>
              new Response(
                JSON.stringify({ status: 'authorization_pending', error: ECHOED_CREDENTIAL }),
                { status: 503 },
              ),
          },
        }),
      (error: unknown) => {
        const normalized = normalizeError(error);
        assert.equal(normalized.code, 'COMMAND_FAILED');
        assert.equal(normalized.details?.status, 503);
        assert.equal(normalized.details?.reason, undefined);
        assert.equal(normalized.retriable, true);
        assert.equal(JSON.stringify(normalized).includes(ECHOED_CREDENTIAL), false);
        return true;
      },
    );
    assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_stored');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

/**
 * A refresh that answers without an access token is not proof the session is gone, so an explicit
 * login that has already saved its session keeps it and succeeds. Only the exact `revoked` marker
 * takes a saved login back.
 */
test('a tokenless refresh keeps the session an explicit login saved and a revoked one fails it', async () => {
  const run = async (refreshBody: unknown) => {
    const tempRoot = mkdtempForTestSync('agent-device-auth-tokenless-login-');
    let warnings = '';
    try {
      const login = await loginWithDeviceAuth({
        stateDir: tempRoot,
        flags: { ...baseFlags, daemonBaseUrl: 'https://cloud.example' },
        env: { AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
        io: {
          // Past the approved token's expiry, so the login has to exchange it.
          now: () => Date.parse('2026-02-01T01:00:00.000Z'),
          stdinIsTTY: true,
          stdoutIsTTY: true,
          stderr: {
            write: (chunk: string) => {
              warnings += chunk;
              return true;
            },
          },
          openBrowser: async () => {},
          fetch: async (url) =>
            String(url).endsWith('/device-auth/start')
              ? jsonResponse({
                  deviceCode: 'device-secret',
                  userCode: 'ABCD-EFGH',
                  verificationUri: 'https://cloud.example/authorize',
                  interval: 1,
                })
              : String(url).endsWith('/device-auth/poll')
                ? jsonResponse({
                    status: 'approved',
                    accessToken: 'adc_agent_expired',
                    expiresAt: '2026-02-01T00:30:00.000Z',
                    cliSession: {
                      id: 'session-tokenless',
                      refreshCredential: 'adc_refresh_tokenless',
                    },
                  })
                : jsonResponse(refreshBody),
        },
      });
      return { login, warnings, error: undefined as unknown };
    } catch (error) {
      return { login: undefined, warnings, error };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };

  const tokenless = await run({ cliSession: { expiresAt: '2099-12-24T00:00:00.000Z' } });
  // The login keeps the session it saved and reports no token expiry: no token came back.
  assert.equal(tokenless.error, undefined);
  assert.equal(tokenless.login?.accessToken, 'adc_agent_expired');
  assert.equal(tokenless.login?.expiresAt, undefined);
  assert.equal(tokenless.login?.session.id, 'session-tokenless');
  assert.match(tokenless.warnings, /could not be exchanged for a live access token/);

  // The exact marker is still a refusal, even to an explicit login that has saved its session.
  const revoked = await run({ status: 'revoked' });
  assert.equal(normalizeError(revoked.error).details?.reason, 'cli_session_revoked');
});

test.skipIf(process.platform === 'win32')(
  'a session store that cannot be written refuses with the directory to repair',
  async () => {
    const tempRoot = mkdtempForTestSync('agent-device-auth-store-unwritable-');
    writeStoredSession(tempRoot);
    const authDir = path.dirname(resolveCliSessionPath(tempRoot));
    fs.chmodSync(authDir, 0o500);
    try {
      let sent = 0;
      await assert.rejects(
        async () =>
          await resolveRemoteAuth({
            command: 'snapshot',
            flags: baseFlags,
            stateDir: tempRoot,
            allowInteractiveLogin: false,
            env: {},
            io: {
              fetch: async () => {
                sent += 1;
                return jsonResponse({ accessToken: 'adc_agent_1' });
              },
            },
          }),
        (error: unknown) => {
          const normalized = normalizeError(error);
          assert.equal(normalized.details?.reason, 'cli_session_store_unwritable');
          assert.equal(normalized.details?.authDir, authDir);
          // The hint names the exact directory and the command that ends the problem.
          assert.ok(normalized.hint?.includes(`chmod 700 ${authDir}`));
          return true;
        },
      );
      assert.equal(sent, 0);
      assert.equal(readCliSession({ stateDir: tempRoot })?.refreshCredential, 'adc_refresh_stored');
    } finally {
      fs.chmodSync(authDir, 0o700);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
