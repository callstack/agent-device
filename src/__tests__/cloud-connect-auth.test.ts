import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeError } from '@agent-device/kernel/errors';
import fs from 'node:fs';
import path from 'node:path';
import { connectCommand } from '../cli/commands/connection.ts';
import { runCliCapture } from './cli-capture.ts';
import { resolveHostedCloudAccess } from '../cli/connection/cloud-access.ts';
import { readActiveConnectionState } from '@agent-device/remote/remote-connection-state';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import {
  mkdtempForTestSync,
  bindTestCommandHost,
  createTestHostEnvironment,
  beginStdoutCapture,
} from '@agent-device/test-kit';

bindTestCommandHost();

test('non-interactive hosted access names the hosted key and custom issuer', async () => {
  await assert.rejects(
    resolveHostedCloudAccess({
      stateDir: mkdtempForTestSync('hosted-ci-auth-'),
      interactive: true,
      env: { CI: 'true', AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example' },
    }),
    (error: unknown) => {
      const result = normalizeError(error);
      assert.match(result.hint ?? '', /AGENT_DEVICE_CLOUD_API_KEY/);
      assert.match(result.hint ?? '', /AGENT_DEVICE_CLOUD_API_KEY_ORIGIN/);
      assert.doesNotMatch(result.hint ?? '', /AGENT_DEVICE_DAEMON_AUTH_TOKEN/);
      return true;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('refuses a typed TV target before authenticating or creating a hosted mobile session', async () => {
  const fetchMock = mockCloudSessionCreate();
  const result = await runCliCapture(
    [
      'connect',
      'cloud',
      '--platform',
      'ios',
      '--target',
      'tv',
      '--session',
      'ci',
      '--no-login',
      '--json',
    ],
    { stateDirPrefix: 'agent-device-hosted-target-' },
  );
  const response = JSON.parse(result.stdout);
  assert.equal(response.error?.code, 'INVALID_ARGS', result.stdout);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('cloud connect reuses explicit env auth when login is disabled', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-cloud-auth-');
  const stateDir = path.join(tempRoot, '.state');
  const fetchMock = mockCloudSessionCreate();
  vi.stubEnv('AGENT_DEVICE_CLOUD_API_KEY', 'adc_live_service');
  vi.stubEnv('AGENT_DEVICE_CLOUD_BASE_URL', 'https://cloud.example');
  vi.stubEnv('AGENT_DEVICE_CLOUD_API_KEY_ORIGIN', 'https://cloud.example');

  try {
    await connectWithNoLogin(stateDir);

    const state = readActiveConnectionState({ stateDir });
    assert.equal(state?.cloudSession?.id, '00000000-0000-4000-8000-000000000001');
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(fetchMock.mock.calls[0]?.[0]?.toString(), 'https://cloud.example/v1/sessions');
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    assert.ok(request);
    const headers = request.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer adc_live_service');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('cloud access with no-login reports auth requirement after reuse options are exhausted', async () => {
  await assert.rejects(
    resolveHostedCloudAccess({
      stateDir: mkdtempForTestSync('agent-device-connect-cloud-auth-miss-'),
      noLogin: true,
      env: {},
      interactive: true,
    }),
    (error) => normalizeError(error).details?.reason === 'cloud_api_key_required',
  );
});

function mockCloudSessionCreate(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: '00000000-0000-4000-8000-000000000001',
          platform: 'ios',
          vendor: 'provider-a',
          transport: 'agent-device-daemon',
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
          attach: {
            daemonBaseUrl: 'https://daemon.example/device',
            daemonAuthToken: 'scoped-test-token',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function connectWithNoLogin(stateDir: string): Promise<void> {
  const stdoutCapture = beginStdoutCapture();
  try {
    await connectCommand({
      host: createTestHostEnvironment(),
      positionals: ['cloud'],
      flags: {
        json: true,
        help: false,
        version: false,
        noLogin: true,
        platform: 'ios',
        session: 'auth-check',
        stateDir,
      },
      client: {} as AgentDeviceClient,
    });
  } finally {
    stdoutCapture.restore();
  }
}
