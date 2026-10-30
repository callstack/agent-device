import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

const ensuring = vi.hoisted(() => ({
  hosts: [] as unknown[],
  requests: [] as string[],
}));

// The ensuring transport is the production entry's; its ensure-then-attach behavior is pinned in
// the daemon-client package. What these tests pin is what the MCP default client factory asks of it.
vi.mock('@agent-device/daemon-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/daemon-client')>()),
  createEnsuredDaemonTransport: (options: { host?: unknown } = {}) => {
    ensuring.hosts.push(options.host);
    return async (req: { command: string }) => {
      ensuring.requests.push(req.command);
      return { ok: true as const, data: { devices: [] } };
    };
  },
}));

import * as hostProcess from '@agent-device/host-kit/process';
import { createCommandToolExecutor } from '../command-tools.ts';

// An MCP tool call builds its own client, so each call has to ensure the daemon it is about to use
// and then attach to it. This drives the default client factory, not an injected one.

afterEach(() => {
  vi.restoreAllMocks();
  ensuring.hosts.length = 0;
  ensuring.requests.length = 0;
});

test('each MCP tool call builds an ensuring transport from the host it captured', async () => {
  const capture = vi.spyOn(hostProcess, 'captureHostEnvironment');
  const executor = createCommandToolExecutor();

  const first = await executor.execute('devices', {});
  const second = await executor.execute('devices', {});

  assert.equal(first.isError, false, JSON.stringify(first.structuredContent));
  assert.equal(second.isError, false, JSON.stringify(second.structuredContent));
  assert.equal(ensuring.hosts.length, 2, 'one ensuring transport per tool call');
  assert.equal(capture.mock.calls.length, 2, 'one host capture per tool call');
  // The host the ensuring transport used is the one the call captured, not a second capture.
  assert.equal(ensuring.hosts[0], capture.mock.results[0]?.value);
  assert.equal(ensuring.hosts[1], capture.mock.results[1]?.value);
  assert.deepEqual(ensuring.requests, ['devices', 'devices']);
});
