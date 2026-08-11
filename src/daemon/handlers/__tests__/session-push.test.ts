import { test, expect } from 'vitest';

import { handleSessionCommands } from './session-command-harness.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';

const invoke = async (_req: DaemonRequest): Promise<DaemonResponse> => {
  return {
    ok: false,
    error: { code: 'INVALID_ARGS', message: 'invoke should not be called in push tests' },
  };
};

test('push requires active session or explicit device selector', async () => {
  const sessionStore = makeSessionStore('agent-device-session-push-');
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'push',
      positionals: ['com.example.app', '{"aps":{"alert":"hi"}}'],
      flags: {},
    },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore,
    invoke,
  });
  expect(response).toBeTruthy();
  if (!response) return;
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/active session or an explicit device selector/i);
});
