// `connect cloud` sends its bearer token to the cloud profile endpoint only over https, or plain
// http to loopback.

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
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

test('connect cloud never sends its bearer token to a plain http cloud off loopback', async () => {
  const stateDir = path.join(mkdtempForTestSync('agent-device-connect-cloud-transport-'), '.state');
  vi.mocked(resolveCloudAccessForConnect).mockResolvedValue({
    accessToken: 'adc_agent_cloud',
    cloudBaseUrl: 'http://cloud.example',
  });
  const send = vi.spyOn(globalThis, 'fetch');
  const stdoutCapture = beginStdoutCapture();

  try {
    await assert.rejects(
      async () =>
        await connectCommand({
          host: createTestHostEnvironment(),
          positionals: [],
          flags: { json: true, help: false, version: false, stateDir },
          client: {} as AgentDeviceClient,
        }),
      (error: unknown) => normalizeError(error).details?.reason === 'insecure_credential_transport',
    );
    assert.equal(send.mock.calls.length, 0);
  } finally {
    stdoutCapture.restore();
    send.mockRestore();
  }
});
