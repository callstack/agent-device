import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});

import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { WEB_DESKTOP_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { AGENT_BROWSER_TIMEOUT_MS } from '../../platforms/web/agent-browser-provider.ts';
import { installFakeManagedAgentBrowser } from '../../platforms/web/__tests__/test-utils.ts';
import { runCmd } from '../../utils/exec.ts';
import { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';
import {
  resolveDaemonSessionTeardownTimeoutMs,
  teardownDaemonSessionForShutdown,
  WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS,
} from './daemon-runtime.ts';

const mockRunCmd = vi.mocked(runCmd);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function makeWebSession(name: string): SessionState {
  return { name, device: WEB_DESKTOP_DEVICE, createdAt: Date.now(), actions: [] };
}

test('daemon session teardown budget extends for an open web session', () => {
  const webSession = makeWebSession('budget-web-session');
  const androidSession: SessionState = {
    name: 'budget-android-session',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  };

  expect(
    resolveDaemonSessionTeardownTimeoutMs(webSession) -
      resolveDaemonSessionTeardownTimeoutMs(androidSession),
  ).toBe(WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS);
});

// Pins the "mirrors AGENT_BROWSER_TIMEOUT_MS" comment on WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS
// as a checked invariant rather than a claim nothing enforces: if agent-browser-provider.ts's own
// per-call timeout changes, this budget must move with it in the same PR.
test('the web-close teardown budget stays pinned to one agent-browser CLI call timeout', () => {
  expect(WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS).toBe(AGENT_BROWSER_TIMEOUT_MS);
});

// The agent-browser CLI call this step makes has its own 30s internal timeout
// (AGENT_BROWSER_TIMEOUT_MS in agent-browser-provider.ts), well past the 5s base teardown
// budget every other resource shares; without the extended budget above, a close that takes
// longer than 5s (closing ~15 Chrome processes under load is plausible) would be abandoned by
// the daemon's own race before agent-browser ever got to finish it.
test('daemon shutdown awaits a slow web close inside its extended budget', async () => {
  vi.useFakeTimers();
  const root = mkdtempForTestSync('agent-device-shutdown-web-close-slow-');
  installFakeManagedAgentBrowser(root);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeWebSession('shutdown-slow-web-session');
  sessionStore.set(session.name, session);
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
    session,
    sessionStore,
    stateDir: root,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
  });
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
  installFakeManagedAgentBrowser(root);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeWebSession('shutdown-web-session');
  // Teardown runs while the session it is tearing down is still in the store (session deletion
  // happens after), which is also what keeps agent-browser's provider-startup orphan sweep from
  // treating this session's own browser as an orphan and scanning real host processes for it.
  sessionStore.set(session.name, session);
  mockRunCmd.mockResolvedValue({
    stdout: JSON.stringify({ success: true, data: {} }),
    stderr: '',
    exitCode: 0,
  });
  const stderrChunks: string[] = [];

  await teardownDaemonSessionForShutdown({
    session,
    sessionStore,
    stateDir: root,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
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
  installFakeManagedAgentBrowser(root);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeWebSession('shutdown-web-close-failure-session');
  sessionStore.set(session.name, session);
  mockRunCmd.mockResolvedValue({
    stdout: JSON.stringify({ success: false, error: 'no active browser session' }),
    stderr: '',
    exitCode: 1,
  });
  const stderrChunks: string[] = [];

  await teardownDaemonSessionForShutdown({
    session,
    sessionStore,
    stateDir: root,
    stderr: { write: (chunk) => stderrChunks.push(chunk) },
  });

  // Best-effort: the failure is surfaced, but it never blocks the session from being torn down.
  expect(stderrChunks.join('')).toMatch(/web_browser/);
  expect(sessionStore.get(session.name)).toBeUndefined();
});
