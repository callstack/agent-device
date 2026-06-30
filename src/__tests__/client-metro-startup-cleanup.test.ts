import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/exec.ts', () => ({
  runCmdDetached: vi.fn(),
  runCmdSync: vi.fn(),
}));

vi.mock('../utils/process-identity.ts', () => ({
  waitForProcessExit: vi.fn(),
}));

import { runCmdDetached } from '../utils/exec.ts';
import { waitForProcessExit } from '../utils/process-identity.ts';
import { prepareMetroRuntime } from '../metro/client-metro.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('prepareMetroRuntime stops a spawned Metro process when startup readiness times out', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-startup-cleanup-'));
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-cleanup-test',
      private: true,
      dependencies: {
        'react-native': '0.0.0-test',
      },
    }),
  );

  vi.mocked(runCmdDetached).mockReturnValue(987);
  vi.mocked(waitForProcessExit).mockResolvedValue(true);
  const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => 'packager-status:not-running',
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();

  try {
    const preparePromise = prepareMetroRuntime({
      projectRoot,
      publicBaseUrl: 'https://public.example.test',
      metroPort: 8081,
      reuseExisting: true,
      installDependenciesIfNeeded: false,
      probeTimeoutMs: 10,
      startupTimeoutMs: 30_000,
      env: { ...process.env, AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'daemon-token' },
    });

    const expectedFailure = assert.rejects(
      preparePromise,
      /Metro did not become ready at http:\/\/127\.0\.0\.1:8081\/status within 30000ms/,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expectedFailure;
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 1);
    assert.deepEqual(killSpy.mock.calls[0], [987, 'SIGTERM']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
