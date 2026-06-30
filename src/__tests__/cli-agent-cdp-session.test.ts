import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../cli/commands/agent-cdp.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/commands/agent-cdp.ts')>();
  return {
    ...actual,
    runAgentCdpCommand: vi.fn(async () => 0),
  };
});

import { runCli } from '../cli.ts';
import { runAgentCdpCommand } from '../cli/commands/agent-cdp.ts';
import { installIsolatedCliTestEnv } from './cli-test-env.ts';
import {
  hashRemoteConfigFile,
  writeRemoteConnectionState,
} from '../remote/remote-connection-state.ts';
import type { DaemonResponse } from '../daemon-client.ts';

afterEach(() => {
  vi.clearAllMocks();
});

test('cdp receives active remote connection session and runtime after defaults are merged', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-agent-cdp-session-'));
  const stateDir = path.join(tempRoot, 'state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://daemon.example.test',
      platform: 'android',
      metroProxyBaseUrl: 'https://bridge.example.test',
      metroBearerToken: 'token',
    }),
  );
  const runtime = {
    platform: 'android' as const,
    bundleUrl: 'https://bridge.example.test/api/metro/runtimes/runtime-1/index.bundle',
  };
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example.test', transport: 'http' },
      tenant: 'tenant-1',
      runId: 'run-1',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      platform: 'android',
      runtime,
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });

  const originalExit = process.exit;
  let exitCode: number | undefined;
  const restoreEnv = installIsolatedCliTestEnv();
  (process as any).exit = ((code?: number) => {
    exitCode = code ?? 0;
  }) as typeof process.exit;

  const sendToDaemon = async (req: { command: string }): Promise<DaemonResponse> => {
    if (req.command === 'lease_heartbeat') {
      return {
        ok: true,
        data: {
          lease: {
            leaseId: 'lease-1',
            tenantId: 'tenant-1',
            runId: 'run-1',
            backend: 'android-instance',
          },
        },
      };
    }
    return { ok: true, data: {} };
  };

  try {
    await runCli(['--state-dir', stateDir, 'cdp', 'target', 'list'], { sendToDaemon });
  } finally {
    restoreEnv();
    process.exit = originalExit;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  assert.equal(exitCode, 0);
  assert.equal(vi.mocked(runAgentCdpCommand).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(runAgentCdpCommand).mock.calls[0]?.[0], ['target', 'list']);
  assert.equal(vi.mocked(runAgentCdpCommand).mock.calls[0]?.[1]?.flags?.session, 'adc-android');
  assert.deepEqual(vi.mocked(runAgentCdpCommand).mock.calls[0]?.[1]?.runtime, runtime);
});
