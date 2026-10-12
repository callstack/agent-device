import { daemonPlatformServicesFixture } from '../../__tests__/platform-services-fixture.ts';
import { expect, test } from 'vitest';
import * as path from 'node:path';
import { handleSessionCommands } from './session-command-harness.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { testCreateCommandSurface } from '../../__tests__/command-surface-fixture.ts';
import type { DaemonRequest } from '../../daemon-request.ts';

function request(command: string): DaemonRequest {
  return { token: 't', session: 'default', command, positionals: [], flags: {} };
}

async function dispatch(command: string) {
  return await handleSessionCommands({
    createCommandSurface: testCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: request(command),
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore: makeSessionStore('agent-device-session-router-'),
    invoke: async () => ({ ok: true, data: {} }),
  });
}

test('the session router stays silent for commands its table does not carry', async () => {
  expect(await dispatch('not_a_command')).toBeNull();
});

test('the session router maps boot, shutdown and appstate straight to their handlers', async () => {
  // No session and no selector: each command reaches its own handler's guard rather than
  // the router's null, which is what distinguishes routing from silence.
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
