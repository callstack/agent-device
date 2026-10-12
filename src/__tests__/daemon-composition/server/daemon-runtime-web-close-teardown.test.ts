import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});

import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { installFakeManagedAgentBrowser } from '@agent-device/test-kit/web-managed-agent-browser';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import { runCmd } from '@agent-device/host-kit/command';
import { SessionStore } from '../../../daemon/session-store.ts';
import { makeWebSession } from '../../../daemon/__tests__/session-teardown.fixtures.ts';
import { teardownDaemonSessionForShutdown } from '../../../daemon/server/daemon-runtime.ts';

const mockRunCmd = vi.mocked(runCmd);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// The agent-browser CLI call this step makes has its own 30s internal timeout
// (AGENT_BROWSER_TIMEOUT_MS in agent-browser-provider.ts), well past the 5s base teardown
// budget every other resource shares; without the extended budget above, a close that takes
// longer than 5s (closing ~15 Chrome processes under load is plausible) would be abandoned by
// the daemon's own race before agent-browser ever got to finish it.
test('daemon shutdown awaits a slow web close inside its extended budget', async () => {
  vi.useFakeTimers();
  const root = mkdtempForTestSync('agent-device-shutdown-web-close-slow-');
  await installFakeManagedAgentBrowser(root);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeWebSession('shutdown-slow-web-session');
  sessionStore.publish(session.name, session);
  mockRunCmd.mockImplementation(
    async () =>
      await new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              stdout: JSON.stringify({ success: true, data: {} }),
              stderr: '',
              exitCode: 0,
            }),
          20_000,
        );
      }),
  );
  const stderrChunks: string[] = [];

  const teardown = teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup(session.name)!,
    sessionStore,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    platformCleanup: platformResourceCleanup,
  });
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(20_000);
  await teardown;

  expect(stderrChunks.join('')).not.toMatch(/timed out/);
  expect(sessionStore.get(session.name)).toBeUndefined();
});

// #1868: SIGTERM (or any other daemon-shutdown teardown) must tell agent-browser to close its
// fleet right away instead of leaving the ~15 Chrome processes for agent-browser's own multi-
// minute idle timer. This is the daemon-shutdown-entry-point counterpart to
// daemon-runtime-recording-teardown.test.ts's coverage of the #1325 recording step.
test('daemon shutdown closes an open web session immediately, without waiting for close', async () => {
  const root = mkdtempForTestSync('agent-device-shutdown-web-close-');
  await installFakeManagedAgentBrowser(root);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeWebSession('shutdown-web-session');
  // Teardown runs while the session it is tearing down is still in the store (session deletion
  // happens after), which is also what keeps agent-browser's provider-startup orphan sweep from
  // treating this session's own browser as an orphan and scanning real host processes for it.
  sessionStore.publish(session.name, session);
  mockRunCmd.mockResolvedValue({
    stdout: JSON.stringify({ success: true, data: {} }),
    stderr: '',
    exitCode: 0,
  });
  const stderrChunks: string[] = [];

  await teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup(session.name)!,
    sessionStore,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    platformCleanup: platformResourceCleanup,
  });

  expect(stderrChunks.join('')).toBe('');
  expect(sessionStore.get(session.name)).toBeUndefined();
  const closeCall = mockRunCmd.mock.calls.find(([, args]) => (args as string[]).includes('close'));
  // `node <entry> close ...`: the managed backend never runs through its `.bin` shim (#2022).
  expect(closeCall?.[0]).toBe(process.execPath);
  expect((closeCall?.[1] as string[] | undefined)?.slice(1)).toEqual([
    'close',
    '--json',
    '--session',
    session.name,
  ]);
});

test('daemon shutdown reports a web close failure on stderr instead of losing it silently', async () => {
  const root = mkdtempForTestSync('agent-device-shutdown-web-close-failure-');
  await installFakeManagedAgentBrowser(root);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeWebSession('shutdown-web-close-failure-session');
  sessionStore.publish(session.name, session);
  mockRunCmd.mockResolvedValue({
    stdout: JSON.stringify({ success: false, error: 'no active browser session' }),
    stderr: '',
    exitCode: 1,
  });
  const stderrChunks: string[] = [];

  await teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup(session.name)!,
    sessionStore,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    platformCleanup: platformResourceCleanup,
  });

  // Best-effort: the failure is surfaced, but it never blocks the session from being torn down.
  expect(stderrChunks.join('')).toMatch(/web_browser/);
  expect(sessionStore.get(session.name)).toBeUndefined();
});

// The platform filter lives in the composed adapter, not in the neutral teardown: the daemon
// asks the port for every session, and only a web device reaches the agent-browser process.
test('daemon session teardown never dispatches a web close for a non-web session', async () => {
  const root = mkdtempForTestSync('agent-device-non-web-teardown-');
  // With the fake installed, a close the adapter should never ask for reaches the
  // agent-browser process seam (mockRunCmd) and fails below instead of passing silently.
  await installFakeManagedAgentBrowser(root);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.publish('android-non-web-teardown-session', {
    name: 'android-non-web-teardown-session',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  });
  const stderrChunks: string[] = [];

  await teardownDaemonSessionForShutdown({
    ref: sessionStore.lookup('android-non-web-teardown-session')!,
    sessionStore,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
    platformCleanup: platformResourceCleanup,
  });

  // The snapshot-helper leg is a real-mechanics no-op for a device with no registered helper
  // session; a mistaken web close would surface on the process seam and on stderr below.
  expect(mockRunCmd).not.toHaveBeenCalled();
  expect(stderrChunks.join('')).toBe('');
});
