import path from 'node:path';
import { expect, test } from 'vitest';
import { DAEMON_TEARDOWN_GRACE_MS } from '@agent-device/daemon-contracts/daemon-process';
import { AGENT_BROWSER_TIMEOUT_MS } from '@agent-device/platform-web';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { makeAndroidSession } from '../../__tests__/support/session-factories.ts';
import { SessionStore } from '../../core/session-store.ts';
import {
  DAEMON_SESSION_TEARDOWN_TIMEOUT_MS,
  resolveDaemonSessionTeardownTimeoutMs,
  SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS,
  WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS,
} from '../session-teardown-budget.ts';
import {
  makeRecordingSession,
  makeWebSession,
} from '../../__tests__/support/session-teardown.fixtures.ts';

test('daemon session teardown budget extends for an active durable recording', () => {
  const root = mkdtempForTestSync('agent-device-shutdown-recording-budget-');
  const sessionStore = new SessionStore(
    path.join(root, 'sessions'),
    createLiveTestHostEnvironment(),
  );
  const session = makeRecordingSession({
    name: 'budget-session',
    sessionStore,
    finish: async () => ({ status: 'cleanup-pending', reason: 'transport-failed' }),
  });
  const withRecording = resolveDaemonSessionTeardownTimeoutMs(session);
  session.screenRecording = undefined;
  const withoutRecording = resolveDaemonSessionTeardownTimeoutMs(session);

  expect(withRecording - withoutRecording).toBe(SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS);
});

test('daemon session teardown budget extends for an open web session', () => {
  const webSession = makeWebSession('budget-web-session');
  const androidSession = makeAndroidSession('budget-android-session');

  expect(
    resolveDaemonSessionTeardownTimeoutMs(webSession) -
      resolveDaemonSessionTeardownTimeoutMs(androidSession),
  ).toBe(WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS);
});

test('the web-close teardown budget stays pinned to one agent-browser CLI call timeout', () => {
  expect(WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS).toBe(AGENT_BROWSER_TIMEOUT_MS);
});

test('the grace a client gives a closing daemon covers the largest teardown the daemon bounds', () => {
  // The bounded steps around session teardown in `daemon-runtime.ts`: request drain 5 s, lease
  // release 1 s, provider release 2 s, platform owners 5 s, plugins 5 s, PNG worker 1 s.
  const fixedStepsMs = 19_000;
  const largestSessionMs =
    DAEMON_SESSION_TEARDOWN_TIMEOUT_MS +
    SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS +
    WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS;

  // If a teardown budget grows past the grace, a client kills a daemon that is closing cleanly.
  expect(fixedStepsMs + largestSessionMs).toBeLessThanOrEqual(DAEMON_TEARDOWN_GRACE_MS);
});
