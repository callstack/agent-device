import {
  makeSessionStore,
  mockPrewarmAppleRunnerCache,
  mockResolveTargetDevice,
  noopInvoke,
} from './session-test-harness.ts';
import { expect, test } from 'vitest';
import { handleSessionCommands } from './session-command-harness.ts';
import { testCreateCommandSurface } from '../../__tests__/command-surface-fixture.ts';

test('boot leaves Apple keep-hot policy inside the platform runtime', async () => {
  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    appleOs: 'ios',
    id: 'simulator',
    name: 'iPhone',
    kind: 'simulator',
    target: 'mobile',
    booted: false,
  });

  const response = await handleSessionCommands({
    createCommandSurface: testCreateCommandSurface,
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone' },
    },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: makeSessionStore(),
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockPrewarmAppleRunnerCache).not.toHaveBeenCalled();
});
