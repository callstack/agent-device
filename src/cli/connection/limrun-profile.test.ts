import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connectCommand } from '../commands/connection.ts';
import {
  readActiveConnectionState,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { verifyLimrunConnection } from '@agent-device/provider-limrun';
import {
  beginStdoutCapture,
  bindTestCommandHost,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';

bindTestCommandHost();

vi.mock('@agent-device/provider-limrun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/provider-limrun')>()),
  verifyLimrunConnection: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

vi.mocked(verifyLimrunConnection).mockResolvedValue({
  provider: 'limrun',
  service: 'Limrun',
  verificationMessage: 'Credentials and Android instance access verified.',
  device: { status: 'deferred', name: 'Provider-selected Android emulator', platform: 'android' },
  app: { status: 'missing', message: 'Run apps to choose an uploaded asset before allocation.' },
});

test('connect limrun repeated for the same session reuses its connection and profile', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-limrun-repeat-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', 'lim_test_key');
  vi.useFakeTimers({ toFake: ['Date'] });
  const connect = async () =>
    await captureConnectStdout(async () => {
      await connectCommand({
        host: createTestHostEnvironment(),
        positionals: ['limrun'],
        flags: {
          json: true,
          help: false,
          version: false,
          stateDir,
          platform: 'android',
          session: 'limrun-repeat',
        },
        client: {} as AgentDeviceClient,
      });
    });

  try {
    vi.setSystemTime(1_000);
    await connect();
    const first = readRequiredActiveState(stateDir);
    // Time passes between the two connects; the connection identity must not depend on it.
    vi.setSystemTime(90_000);
    await connect();
    const second = readRequiredActiveState(stateDir);

    assert.equal(second.runId, first.runId);
    assert.equal(second.remoteConfigPath, first.remoteConfigPath);
    assert.deepEqual(fs.readdirSync(path.join(stateDir, 'remote-connections', 'generated')), [
      path.basename(first.remoteConfigPath),
    ]);
  } finally {
    vi.useRealTimers();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('separate unscoped connect limrun calls get separate run ids', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-limrun-unscoped-');
  const stateDir = path.join(tempRoot, '.state');
  vi.stubEnv('LIMRUN_API_KEY', 'lim_test_key');
  const connect = async () => {
    await captureConnectStdout(async () => {
      await connectCommand({
        host: createTestHostEnvironment(),
        positionals: ['limrun'],
        flags: { json: true, help: false, version: false, stateDir, platform: 'android' },
        client: {} as AgentDeviceClient,
      });
    });
    return readRequiredActiveState(stateDir);
  };

  try {
    const first = await connect();
    const second = await connect();

    assert.notEqual(second.session, first.session);
    assert.notEqual(second.runId, first.runId);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

async function captureConnectStdout(task: () => Promise<void>): Promise<void> {
  const stdoutCapture = beginStdoutCapture();
  try {
    await task();
  } finally {
    stdoutCapture.restore();
  }
}

function readRequiredActiveState(stateDir: string): RemoteConnectionState {
  const state = readActiveConnectionState({ stateDir });
  assert.ok(state);
  return state;
}
