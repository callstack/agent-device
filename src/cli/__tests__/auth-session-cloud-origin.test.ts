import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveRemoteAuth, writeCliSession } from '../auth-session.ts';

const baseFlags = {
  json: false,
  help: false,
  version: false,
  daemonBaseUrl: 'https://daemon.example',
  tenant: 'acme',
  runId: 'run-123',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('a stored CLI session is sent only to the cloud that issued it, without redirects', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-auth-origin-');
  writeCliSession({
    stateDir: tempRoot,
    session: {
      version: 1,
      id: 'session-origin',
      cloudBaseUrl: 'https://cloud.example',
      refreshCredential: 'adc_refresh_secret',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const requests: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const refresh = (env: Record<string, string>) =>
    resolveRemoteAuth({
      command: 'snapshot',
      flags: { ...baseFlags, daemonBaseUrl: 'https://bridge.agent-device.dev' },
      stateDir: tempRoot,
      allowInteractiveLogin: false,
      env,
      io: {
        fetch: async (url, init) => {
          requests.push({ url: String(url), redirect: init?.redirect });
          return jsonResponse({ accessToken: 'adc_agent_fresh' });
        },
      },
    });

  await assert.rejects(
    () => refresh({ AGENT_DEVICE_CLOUD_BASE_URL: 'https://elsewhere.example' }),
    (error) => normalizeError(error).details?.reason === 'cloud_login_origin_mismatch',
  );
  assert.deepEqual(requests, []);

  const same = await refresh({ AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example/' });
  assert.equal(same.flags.daemonAuthToken, 'adc_agent_fresh');
  assert.deepEqual(requests, [
    { url: 'https://cloud.example/api/control-plane/cli-session/refresh', redirect: 'error' },
  ]);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
