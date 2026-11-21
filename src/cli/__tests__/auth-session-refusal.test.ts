import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
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
      version: 1,
      id: 'session-refusal',
      cloudBaseUrl: 'https://cloud.example',
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
 * recognize an opaque credential, so `--json` would print one.
 */
test('a refused refresh carries its reason and no text from the response', async () => {
  const refusals: Array<{ name: string; body: unknown }> = [
    {
      name: 'revoked with tokens and an echoed credential in error',
      body: { status: 'revoked', error: ECHOED_CREDENTIAL, accessToken: 'adc_agent_rogue' },
    },
    {
      name: 'revoked with tokens and an echoed credential in status',
      body: { status: ECHOED_CREDENTIAL, error: 'revoked', accessToken: 'adc_agent_rogue' },
    },
    {
      name: 'no token and an echoed credential in error',
      body: { status: 'unknown_status', error: ECHOED_CREDENTIAL },
    },
    {
      name: 'no token and an echoed credential in status',
      body: { status: ECHOED_CREDENTIAL, error: 'unknown_error' },
    },
  ];

  for (const { name, body } of refusals) {
    const tempRoot = mkdtempForTestSync('agent-device-auth-refusal-');
    writeStoredSession(tempRoot);
    try {
      await assert.rejects(
        async () => await refreshWithResponse(tempRoot, body),
        (error: unknown) => {
          const normalized = normalizeError(error);
          assert.equal(normalized.code, 'UNAUTHORIZED', name);
          assert.equal(normalized.details?.reason, 'cli_session_revoked', name);
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
