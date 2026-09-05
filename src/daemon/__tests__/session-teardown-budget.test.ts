import path from 'node:path';
import { expect, test } from 'vitest';
import { AGENT_BROWSER_TIMEOUT_MS } from '@agent-device/platform-web';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { SessionStore } from '../session-store.ts';
import {
  resolveDaemonSessionTeardownTimeoutMs,
  SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS,
  WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS,
} from '../session-teardown-budget.ts';
import { makeRecordingSession, makeWebSession } from './session-teardown.fixtures.ts';

test('daemon session teardown budget extends for an active durable recording', () => {
  const root = mkdtempForTestSync('agent-device-shutdown-recording-budget-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
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
