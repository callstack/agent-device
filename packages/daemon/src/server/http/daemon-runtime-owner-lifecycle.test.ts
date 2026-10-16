import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import {
  daemonRuntimeDepsFixture,
  platformOwnerLifecycleFixture,
} from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import type { PlatformOwnerLifecycle } from '../../core/platform-owner-lifecycle.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

type LoggedEvent = { phase: string; data?: Record<string, unknown> };

function loggedEvents(logPath: string): LoggedEvent[] {
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LoggedEvent)
    .filter((event) => event.phase.startsWith('platform_owner_'));
}

function startDaemon(
  stateDir: string,
  configureForDaemonLock: PlatformOwnerLifecycle['configureForDaemonLock'],
) {
  return startDaemonRuntime({
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
    }),
    exit: () => {},
    registerProcessHandlers: false,
    stderr: { write: () => {} },
    stdout: { write: () => {} },
    composeDeps: daemonRuntimeDepsFixture({
      ownerLifecycle: platformOwnerLifecycleFixture({ configureForDaemonLock }),
    }),
  });
}

test('daemon startup configures its platform owners before it publishes readiness', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-owner-lifecycle-');
  const infoPath = path.join(stateDir, 'daemon.json');
  const infoPublishedAtConfigure: boolean[] = [];

  const runtime = await startDaemon(stateDir, async (input) => {
    infoPublishedAtConfigure.push(fs.existsSync(infoPath));
    input.onDiagnostic({
      phase: 'platform_owner_link_removed',
      resourcePath: '/owner/resource',
      data: { linkTarget: '/owner/scoped' },
    });
  });
  try {
    expect(runtime).not.toBeNull();
    expect(infoPublishedAtConfigure).toEqual([false]);
    expect(fs.existsSync(infoPath)).toBe(true);
    expect(loggedEvents(path.join(stateDir, 'daemon.log'))).toEqual([
      expect.objectContaining({
        phase: 'platform_owner_link_removed',
        data: expect.objectContaining({
          resourcePath: '/owner/resource',
          linkTarget: '/owner/scoped',
        }),
      }),
    ]);
  } finally {
    await runtime?.shutdown();
  }
});

test('a platform owner diagnostic about a refused restore is logged and the daemon still starts', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-owner-lifecycle-refused-');

  const runtime = await startDaemon(stateDir, async (input) => {
    input.onDiagnostic({
      phase: 'platform_owner_restore_failed',
      resourcePath: '/owner/resource',
      data: {},
    });
  });
  try {
    expect(runtime).not.toBeNull();
    expect(fs.existsSync(path.join(stateDir, 'daemon.json'))).toBe(true);
    expect(loggedEvents(path.join(stateDir, 'daemon.log'))).toEqual([
      expect.objectContaining({
        phase: 'platform_owner_restore_failed',
        data: expect.objectContaining({ resourcePath: '/owner/resource' }),
      }),
    ]);
  } finally {
    await runtime?.shutdown();
  }
});
