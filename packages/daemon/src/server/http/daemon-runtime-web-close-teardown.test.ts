import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync, WEB_DESKTOP_DEVICE } from '@agent-device/test-kit';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { makeWebSession } from '../../__tests__/support/session-teardown.fixtures.ts';
import { SessionStore } from '../../core/session-store.ts';
import { teardownDaemonSessionForShutdown } from './daemon-runtime.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function openStore(prefix: string): SessionStore {
  return new SessionStore(path.join(mkdtempForTestSync(prefix), 'sessions'));
}

// The agent-browser CLI call a web close makes has its own 30s internal timeout, well past the 5s
// base teardown budget every other resource shares; without the extended budget, a close that
// takes longer than 5s (closing ~15 Chrome processes under load is plausible) would be abandoned
// by the daemon's own race before the platform ever got to finish it.
test('daemon shutdown awaits a slow web close inside its extended budget', async () => {
  vi.useFakeTimers();
  const sessionStore = openStore('agent-device-shutdown-web-close-slow-');
  const session = makeWebSession('shutdown-slow-web-session');
  sessionStore.publish(session.name, session);
  const platformCleanup = platformResourceCleanupFixture({
    closeManagedBrowser: async () => await new Promise((resolve) => setTimeout(resolve, 20_000)),
  });
  const stderrChunks: string[] = [];

  const teardown = teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup(session.name)!,
    sessionStore,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    platformCleanup,
  });
  await vi.advanceTimersByTimeAsync(20_000);
  await teardown;

  expect(stderrChunks.join('')).not.toMatch(/timed out/);
  expect(sessionStore.get(session.name)).toBeUndefined();
});

// #1868: SIGTERM (or any other daemon-shutdown teardown) must tell the platform to close its
// browser fleet right away instead of leaving it for the browser's own multi-minute idle timer.
test('daemon shutdown asks the platform to close an open web session', async () => {
  const sessionStore = openStore('agent-device-shutdown-web-close-');
  const session = makeWebSession('shutdown-web-session');
  sessionStore.publish(session.name, session);
  const platformCleanup = platformResourceCleanupFixture();
  const stderrChunks: string[] = [];

  await teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup(session.name)!,
    sessionStore,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    platformCleanup,
  });

  expect(stderrChunks.join('')).toBe('');
  expect(sessionStore.get(session.name)).toBeUndefined();
  expect(platformCleanup.closeManagedBrowser).toHaveBeenCalledOnce();
  expect(platformCleanup.closeManagedBrowser).toHaveBeenCalledWith({
    device: session.device,
    sessionName: session.name,
    stateDir: sessionStore.resolveDaemonStateDir(),
    openSessionNames: expect.any(Function),
  });
});

test('daemon shutdown reports a web close failure on stderr instead of losing it silently', async () => {
  const sessionStore = openStore('agent-device-shutdown-web-close-failure-');
  const session = makeWebSession('shutdown-web-close-failure-session');
  sessionStore.publish(session.name, session);
  const platformCleanup = platformResourceCleanupFixture({
    closeManagedBrowser: async () => {
      throw new Error('no active browser session');
    },
  });
  const stderrChunks: string[] = [];

  await teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup(session.name)!,
    sessionStore,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    platformCleanup,
  });

  // Best-effort: the failure is surfaced, but it never blocks the session from being torn down.
  expect(stderrChunks.join('')).toMatch(/web_browser.*no active browser session/);
  expect(sessionStore.get(session.name)).toBeUndefined();
});

// The platform filter lives in the composed adapter, not in the neutral teardown: the daemon asks
// the port for every session and the adapter decides which devices have a browser.
test('daemon session teardown asks the platform port about a non-web session too', async () => {
  const sessionStore = openStore('agent-device-non-web-teardown-');
  const device = { ...WEB_DESKTOP_DEVICE, platform: 'android' as const, id: 'emulator-5554' };
  sessionStore.publish('android-non-web-teardown-session', {
    name: 'android-non-web-teardown-session',
    device,
    createdAt: Date.now(),
    actions: [],
  });
  const platformCleanup = platformResourceCleanupFixture();
  const stderrChunks: string[] = [];

  await teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup('android-non-web-teardown-session')!,
    sessionStore,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    platformCleanup,
  });

  expect(platformCleanup.closeManagedBrowser).toHaveBeenCalledWith(
    expect.objectContaining({ device }),
  );
  expect(stderrChunks.join('')).toBe('');
});
