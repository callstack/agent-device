import { daemonPlatformServicesFixture } from '../../__tests__/platform-services-fixture.ts';
import { expect, test } from 'vitest';
import { handleSessionStateCommands } from '../session-state.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { DaemonRequest } from '../../daemon-request.ts';

function request(command: string): DaemonRequest {
  return { token: 't', session: 'default', command, positionals: [], flags: {} };
}

async function dispatch(command: string) {
  return await handleSessionStateCommands({
    platformServices: daemonPlatformServicesFixture(),
    req: request(command),
    sessionName: 'default',
    sessionStore: makeSessionStore('agent-device-session-state-'),
  });
}

test('the state group stays silent for commands it does not own', async () => {
  expect(await dispatch('open')).toBeNull();
});

test('the state group routes each command it owns to its handler', async () => {
  // No session and no selector: each owned command reaches its handler's guard rather than
  // the group's null, which is what distinguishes routing from silence.
  for (const command of ['boot', 'shutdown', 'appstate']) {
    const response = await dispatch(command);
    if (!response || response.ok) {
      throw new Error(
        `${command} should reach its handler's guard as an INVALID_ARGS refusal, got ${JSON.stringify(response)}`,
      );
    }
    expect(response.error.code, command).toBe('INVALID_ARGS');
  }
});
