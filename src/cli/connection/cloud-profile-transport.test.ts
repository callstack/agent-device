// `connect cloud` sends its bearer token to the cloud profile endpoint only over https (or plain
// http to loopback), and never follows a redirect to another origin.

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { connectCommand } from '../commands/connection.ts';
import { resolveCloudAccessForConnect } from '../auth-session.ts';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  beginStdoutCapture,
  bindTestCommandHost,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';

bindTestCommandHost();

vi.mock('../auth-session.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth-session.ts')>()),
  resolveCloudAccessForConnect: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function connectCloud(stateDir: string): Promise<void> {
  const stdoutCapture = beginStdoutCapture();
  try {
    await connectCommand({
      host: createTestHostEnvironment(),
      positionals: [],
      flags: { json: true, help: false, version: false, stateDir },
      client: {} as AgentDeviceClient,
    });
  } finally {
    stdoutCapture.restore();
  }
}

async function connectCloudAt(
  cloudBaseUrl: string,
  answer: () => Response,
): Promise<{ reason: unknown; urls: string[] }> {
  const tempRoot = mkdtempForTestSync('agent-device-connect-cloud-transport-');
  vi.mocked(resolveCloudAccessForConnect).mockResolvedValue({
    accessToken: 'adc_agent_cloud',
    cloudBaseUrl,
  });
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return answer();
    }),
  );
  vi.spyOn(http, 'request').mockImplementation(((target: unknown) => {
    urls.push(JSON.stringify(target));
    throw new Error('nothing may be sent over plain http');
  }) as typeof http.request);
  try {
    const refusal = await connectCloud(path.join(tempRoot, '.state')).then(
      () => assert.fail('expected connect cloud to be refused'),
      (error: unknown) => error,
    );
    return { reason: normalizeError(refusal).details?.reason, urls };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('connect cloud never sends its bearer token to a plain http cloud off loopback', async () => {
  const { reason, urls } = await connectCloudAt('http://cloud.example', () => new Response('{}'));

  assert.equal(reason, 'insecure_credential_transport');
  assert.deepEqual(urls, []);
});

test('connect cloud refuses a profile redirect to another origin before sending to it', async () => {
  const { reason, urls } = await connectCloudAt(
    'https://cloud.example',
    () => new Response(null, { status: 302, headers: { location: 'http://other.example/x' } }),
  );

  assert.equal(reason, 'cloud_auth_redirect_refused');
  assert.deepEqual(urls, ['https://cloud.example/api/control-plane/connection-profile']);
});
