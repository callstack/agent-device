import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetached: vi.fn(),
  runCmdSync: vi.fn(),
}));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  waitForProcessExit: vi.fn(),
}));

import { runCmdDetached } from '@agent-device/host-kit/command';
import { waitForProcessExit } from '@agent-device/host-kit/process';

import { prepareMetroRuntime } from '../metro/client-metro.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createMetroProject(label: string): string {
  const tempRoot = mkdtempForTestSync(`agent-device-metro-startup-cleanup-${label}-`);
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
  return projectRoot;
}

function metroPrepareInput(projectRoot: string) {
  return {
    projectRoot,
    publicBaseUrl: 'https://public.example.test',
    metroPort: 8081,
    reuseExisting: true,
    installDependenciesIfNeeded: false,
    probeTimeoutMs: 10,
    startupTimeoutMs: 30_000,
    env: { ...process.env, AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'daemon-token' },
  } as const;
}

/** Starts a prepare whose Metro never becomes ready, letting readiness time out under fake timers. */
async function runMetroPrepareThroughTimeout(projectRoot: string): Promise<void> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => 'packager-status:not-running',
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
  const preparePromise = prepareMetroRuntime(metroPrepareInput(projectRoot));
  const expectedFailure = assert.rejects(
    preparePromise,
    /React Native dev server did not become ready at http:\/\/127\.0\.0\.1:8081\/status within 30000ms/,
  );
  await vi.advanceTimersByTimeAsync(30_000);
  await expectedFailure;
}

type KillSignal = 'SIGTERM' | 'SIGKILL';

function spyOnKill(behavior: (signal: KillSignal) => boolean): {
  signals: Array<[number, string]>;
} {
  const signals: Array<[number, string]> = [];
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    const name = (signal ?? 'SIGTERM') as KillSignal;
    signals.push([pid, name]);
    return behavior(name) as true;
  }) as typeof process.kill);
  return { signals };
}

function killError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`kill failed: ${code}`), { code });
}

test('prepareMetroRuntime stops a spawned Metro process when startup readiness times out', async () => {
  const projectRoot = createMetroProject('timeout');
  vi.mocked(runCmdDetached).mockReturnValue(987);
  vi.mocked(waitForProcessExit).mockResolvedValue(true);
  const kill = spyOnKill(() => true);

  try {
    await runMetroPrepareThroughTimeout(projectRoot);
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 1);
    assert.deepEqual(kill.signals, [[987, 'SIGTERM']]);
    assert.deepEqual(vi.mocked(waitForProcessExit).mock.calls, [[987, 1_000]]);
  } finally {
    fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
  }
});

test('stopSpawnedMetroProcess gives up cleanup (best effort) when SIGTERM throws ESRCH or EPERM', async () => {
  for (const code of ['ESRCH', 'EPERM']) {
    vi.clearAllMocks();
    const projectRoot = createMetroProject(`term-${code}`);
    vi.mocked(runCmdDetached).mockReturnValue(987);
    const kill = spyOnKill(() => {
      throw killError(code);
    });

    try {
      await runMetroPrepareThroughTimeout(projectRoot);
      assert.deepEqual(kill.signals, [[987, 'SIGTERM']], `${code} on SIGTERM must stop cleanup`);
      assert.equal(vi.mocked(waitForProcessExit).mock.calls.length, 0, code);
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  }
});

test('stopSpawnedMetroProcess escalates to SIGKILL when SIGTERM does not exit the process', async () => {
  const projectRoot = createMetroProject('escalate');
  vi.mocked(runCmdDetached).mockReturnValue(987);
  vi.mocked(waitForProcessExit).mockResolvedValue(false);
  const kill = spyOnKill(() => true);

  try {
    await runMetroPrepareThroughTimeout(projectRoot);
    assert.deepEqual(kill.signals, [
      [987, 'SIGTERM'],
      [987, 'SIGKILL'],
    ]);
    assert.deepEqual(vi.mocked(waitForProcessExit).mock.calls, [
      [987, 1_000],
      [987, 1_000],
    ]);
  } finally {
    fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
  }
});

test('stopSpawnedMetroProcess gives up cleanup (best effort) when SIGKILL throws ESRCH or EPERM', async () => {
  for (const code of ['ESRCH', 'EPERM']) {
    vi.clearAllMocks();
    const projectRoot = createMetroProject(`kill-${code}`);
    vi.mocked(runCmdDetached).mockReturnValue(987);
    vi.mocked(waitForProcessExit).mockResolvedValue(false);
    const kill = spyOnKill((signal) => {
      if (signal === 'SIGKILL') throw killError(code);
      return true;
    });

    try {
      await runMetroPrepareThroughTimeout(projectRoot);
      assert.deepEqual(kill.signals, [
        [987, 'SIGTERM'],
        [987, 'SIGKILL'],
      ]);
      assert.deepEqual(
        vi.mocked(waitForProcessExit).mock.calls,
        [[987, 1_000]],
        `${code} on SIGKILL means the process is already gone; no second exit wait`,
      );
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  }
});

test('prepareMetroRuntime reports the readiness timeout when the escalated SIGKILL is refused with EACCES', async () => {
  const projectRoot = createMetroProject('kill-eacces');
  vi.mocked(runCmdDetached).mockReturnValue(987);
  vi.mocked(waitForProcessExit).mockResolvedValue(false);
  const kill = spyOnKill((signal) => {
    if (signal === 'SIGKILL') throw killError('EACCES');
    return true;
  });

  try {
    await runMetroPrepareThroughTimeout(projectRoot);
    assert.deepEqual(kill.signals, [
      [987, 'SIGTERM'],
      [987, 'SIGKILL'],
    ]);
    assert.deepEqual(vi.mocked(waitForProcessExit).mock.calls, [[987, 1_000]]);
  } finally {
    fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
  }
});

test('prepareMetroRuntime reports the readiness timeout when SIGTERM is refused with EACCES', async () => {
  const projectRoot = createMetroProject('term-eacces');
  vi.mocked(runCmdDetached).mockReturnValue(987);
  const kill = spyOnKill(() => {
    throw killError('EACCES');
  });

  try {
    await runMetroPrepareThroughTimeout(projectRoot);
    assert.deepEqual(kill.signals, [[987, 'SIGTERM']]);
    assert.equal(vi.mocked(waitForProcessExit).mock.calls.length, 0);
  } finally {
    fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
  }
});
