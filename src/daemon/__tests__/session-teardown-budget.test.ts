import path from 'node:path';
import { expect, test } from 'vitest';
import { AGENT_BROWSER_TIMEOUT_MS } from '@agent-device/platform-web';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';
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

test('command admission reserves recording teardown before a session exists', () => {
  expect(
    resolveDaemonSessionTeardownTimeoutMs(undefined, true) -
      resolveDaemonSessionTeardownTimeoutMs(),
  ).toBe(SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS);
});
