import { daemonPlatformServicesFixture } from '../../__tests__/platform-services-fixture.ts';
import { test, expect } from 'vitest';
import { makeSessionStore } from './session-test-harness.ts';
import { handleAppStateCommand } from '../session-appstate.ts';
import type { DaemonRequest } from '../../daemon-request.ts';

function appStateRequest(session: string, flags: DaemonRequest['flags']): DaemonRequest {
  return { token: 't', session, command: 'appstate', positionals: [], flags };
}

test('appstate returns missing-session error for explicit session flag', async () => {
  const response = await handleAppStateCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: appStateRequest('named', { platform: 'ios', session: 'named' }),
    sessionName: 'named',
    sessionStore: makeSessionStore(),
  });

  expect(response).toBeTruthy();
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/Run open with --session named first/i);
  }
});

test('appstate refuses --platform ios without a session at the message level', async () => {
  const response = await handleAppStateCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: appStateRequest('default', { platform: 'ios', device: 'iPhone 17' }),
    sessionName: 'default',
    sessionStore: makeSessionStore(),
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toBe(
      'iOS appstate requires an active session on the target device. Run open first (for example: open --session sim --platform ios --device "<name>" <app>).',
    );
  }
});

test('appstate refuses --platform macos without a session at the message level', async () => {
  const response = await handleAppStateCommand({
    platformServices: daemonPlatformServicesFixture(),
    req: appStateRequest('default', { platform: 'macos', device: 'Mac' }),
    sessionName: 'default',
    sessionStore: makeSessionStore(),
  });

  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toBe(
      'macOS appstate requires an active session on the target device. Run open first (for example: open --session macos --platform macos "System Settings").',
    );
  }
});
