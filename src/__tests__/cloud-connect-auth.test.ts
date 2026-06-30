import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectCommand } from '../cli/commands/connection.ts';
import { resolveCloudAccessForConnect } from '../cli/auth-session.ts';
import { readActiveConnectionState } from '../remote/remote-connection-state.ts';
import type { AgentDeviceClient } from '../client.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('cloud connect reuses explicit env auth when login is disabled', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-cloud-auth-'));
  const stateDir = path.join(tempRoot, '.state');
  const fetchMock = mockConnectionProfileFetch();
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'adc_live_service');
  vi.stubEnv('AGENT_DEVICE_CLOUD_BASE_URL', 'https://cloud.example');

  try {
    await connectWithNoLogin(stateDir);

    const state = readActiveConnectionState({ stateDir });
    assert.equal(state?.tenant, 'acme');
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(
      fetchMock.mock.calls[0]?.[0]?.toString(),
      'https://cloud.example/api/control-plane/connection-profile',
    );
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
    resolveCloudAccessForConnect({
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-connect-cloud-auth-miss-')),
      flags: {
        json: false,
        help: false,
        version: false,
        noLogin: true,
      },
      env: {},
      io: {
        env: {},
        fetch: vi.fn(),
      },
    }),
    /Cloud connection profile authentication is required/,
  );
});

function mockConnectionProfileFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          connection: {
            remoteConfigProfile: {
              daemonBaseUrl: 'https://bridge.example.com/agent-device',
              daemonTransport: 'http',
              tenant: 'acme',
              runId: 'demo-run-001',
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function connectWithNoLogin(stateDir: string): Promise<void> {
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await connectCommand({
      positionals: [],
      flags: {
        json: true,
        help: false,
        version: false,
        noLogin: true,
        stateDir,
      },
      client: {} as AgentDeviceClient,
    });
  } finally {
    stdoutWrite.mockRestore();
  }
}
