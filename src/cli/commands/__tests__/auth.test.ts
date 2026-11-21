import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { runCliCapture } from '../../../__tests__/cli-capture.ts';
import { writeCliSession } from '../../auth-session.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function writeStoredCliSession(
  stateDir: string,
  overrides: Partial<Parameters<typeof writeCliSession>[0]['session']> = {},
) {
  writeCliSession({
    stateDir,
    session: {
      version: 1,
      id: 'cli-1',
      cloudBaseUrl: 'https://cloud.example.test',
      refreshCredential: 'refresh-credential',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
  });
}

test('auth with no subcommand renders an unauthenticated status', async () => {
  const stateDir = mkdtempForTestSync('agent-device-auth-status-');
  const result = await runCliCapture(['auth', '--state-dir', stateDir]);

  assert.equal(result.code, null);
  assert.equal(result.stdout, 'Not authenticated.\n');
});

test('auth status renders every stored session field', async () => {
  const stateDir = mkdtempForTestSync('agent-device-auth-status-full-');
  writeStoredCliSession(stateDir, {
    id: 'cli-42',
    workspaceId: 'ws-7',
    accountId: 'acct-9',
    expiresAt: '2020-01-01T00:00:00.000Z',
  });

  const result = await runCliCapture(['auth', 'status', '--state-dir', stateDir]);

  assert.equal(result.code, null);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'Authenticated with cloud CLI session.',
    'cloud=https://cloud.example.test',
    'session=cli-42',
    'workspace=ws-7',
    'account=acct-9',
    'expiresAt=2020-01-01T00:00:00.000Z',
    'status=expired',
  ]);
});

test('auth status omits optional fields a minimal session does not carry', async () => {
  const stateDir = mkdtempForTestSync('agent-device-auth-status-minimal-');
  writeStoredCliSession(stateDir);

  const result = await runCliCapture(['auth', 'status', '--state-dir', stateDir]);

  assert.equal(result.code, null);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'Authenticated with cloud CLI session.',
    'cloud=https://cloud.example.test',
    'session=cli-1',
  ]);
});

test('auth login completes a device-code flow and stores the CLI session', async () => {
  const stateDir = mkdtempForTestSync('agent-device-auth-login-');
  const requestUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      requestUrls.push(url.pathname);
      if (url.pathname === '/api/control-plane/device-auth/start') {
        return new Response(
          JSON.stringify({
            deviceCode: 'device-code-1',
            userCode: 'ABCD-1234',
            verificationUri: 'https://cloud.example.test/login',
            interval: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return jsonResponse({
        status: 'approved',
        accessToken: 'access-token-1',
        // Both far future: a login whose approved token is still live asks for nothing, so start
        // and poll are the only calls.
        expiresAt: '2099-01-01T00:00:00.000Z',
        cliSession: {
          id: 'cli-7',
          refreshCredential: 'refresh-credential-7',
          workspaceId: 'ws-7',
          accountId: 'acct-7',
          expiresAt: '2099-06-01T00:00:00.000Z',
        },
      });
    }),
  );

  const previousStdinIsTTY = process.stdin.isTTY;
  const previousStdoutIsTTY = process.stdout.isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = true;
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  try {
    const result = await runCliCapture(['auth', 'login', '--state-dir', stateDir], {
      env: {
        AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example.test',
        // A remote shell with interactive TTYs takes the device-code branch,
        // which prints the URL instead of launching a browser.
        SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22',
        CI: undefined,
        GITHUB_ACTIONS: undefined,
        BUILDKITE: undefined,
      },
    });

    assert.equal(result.code, null);
    assert.equal(result.stdout, 'Authenticated with cloud CLI session.\n');
    assert.match(result.stderr, /Open this URL on your machine/);
    assert.deepEqual(requestUrls, [
      '/api/control-plane/device-auth/start',
      '/api/control-plane/device-auth/poll',
    ]);
    const stored = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'auth', 'cli-session.json'), 'utf8'),
    ) as { id: string; workspaceId?: string };
    assert.equal(stored.id, 'cli-7');
    assert.equal(stored.workspaceId, 'ws-7');
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = previousStdinIsTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = previousStdoutIsTTY;
  }
});

test('auth login exchanges an approved access token that already expired for a live one', async () => {
  const stateDir = mkdtempForTestSync('agent-device-auth-login-expired-token-');
  const requestUrls: string[] = [];
  let sentCredential: unknown;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      requestUrls.push(url.pathname);
      if (url.pathname === '/api/control-plane/cli-session/refresh') {
        sentCredential = JSON.parse(String(init?.body)).refreshCredential;
        return jsonResponse({
          accessToken: 'access-token-live',
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
      if (url.pathname === '/api/control-plane/device-auth/start') {
        return jsonResponse({
          deviceCode: 'device-code-1',
          userCode: 'ABCD-1234',
          verificationUri: 'https://cloud.example.test/login',
          interval: 1,
        });
      }
      return jsonResponse({
        status: 'approved',
        accessToken: 'access-token-expired',
        // Past, against any clock this run happens on: the token the login must not hand back.
        expiresAt: '2001-01-01T00:00:00.000Z',
        cliSession: {
          id: 'cli-8',
          refreshCredential: 'refresh-credential-8',
          // Far future: the saved session stays usable, which is what lets the exchange run.
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      });
    }),
  );

  const previousStdinIsTTY = process.stdin.isTTY;
  const previousStdoutIsTTY = process.stdout.isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = true;
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  try {
    const result = await runCliCapture(['auth', 'login', '--state-dir', stateDir, '--json'], {
      env: {
        AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example.test',
        SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22',
        CI: undefined,
        GITHUB_ACTIONS: undefined,
        BUILDKITE: undefined,
      },
    });

    assert.equal(result.code, null);
    const data = JSON.parse(result.stdout).data as {
      agentTokenExpiresAt?: string;
      sessionId?: string;
    };
    // The login reports the token it exchanged, and the expiry that came with it.
    assert.equal(data.agentTokenExpiresAt, '2099-01-01T00:00:00.000Z');
    assert.equal(data.sessionId, 'cli-8');
    assert.deepEqual(requestUrls, [
      '/api/control-plane/device-auth/start',
      '/api/control-plane/device-auth/poll',
      '/api/control-plane/cli-session/refresh',
    ]);
    assert.equal(sentCredential, 'refresh-credential-8');
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = previousStdinIsTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = previousStdoutIsTTY;
  }
});

test('auth logout removes a stored session and reports it', async () => {
  const stateDir = mkdtempForTestSync('agent-device-auth-logout-removed-');
  writeStoredCliSession(stateDir);

  const result = await runCliCapture(['auth', 'logout', '--state-dir', stateDir]);

  assert.equal(result.code, null);
  assert.equal(result.stdout, 'Removed stored cloud CLI session.\n');
  assert.equal(fs.existsSync(path.join(stateDir, 'auth', 'cli-session.json')), false);
});

test('auth logout without a stored session reports nothing to remove', async () => {
  const stateDir = mkdtempForTestSync('agent-device-auth-logout-none-');
  const result = await runCliCapture(['auth', 'logout', '--state-dir', stateDir]);

  assert.equal(result.code, null);
  assert.equal(result.stdout, 'No stored cloud CLI session.\n');
});

test('auth rejects a subcommand outside status, login, and logout', async () => {
  const stateDir = mkdtempForTestSync('agent-device-auth-invalid-');
  const result = await runCliCapture(['auth', 'rotate', '--state-dir', stateDir]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /INVALID_ARGS/);
  assert.match(result.stderr, /auth accepts only: status, login, logout/);
});
