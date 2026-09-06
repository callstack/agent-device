import { expect, test, vi } from 'vitest';
import type { DaemonRequest } from '../../daemon-request.ts';
import { handlePortReverseCommand } from '../session-runtime-port-reverse.ts';

const baseRequest = {
  token: 'test-token',
  session: 'no-open-session',
  command: 'runtime',
  positionals: ['port-reverse'],
} satisfies Pick<DaemonRequest, 'token' | 'session' | 'command' | 'positionals'>;

test('port reverse rejects a missing resolved lease before runtime admission', async () => {
  const inspectFacts = vi.fn();
  const bindDevice = vi.fn();
  const response = await handlePortReverseCommand({
    req: {
      ...baseRequest,
      flags: { platform: 'android', leaseProvider: 'limrun', devicePort: 8097 },
    },
    session: undefined,
    inspectFacts,
    bindDevice,
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message: 'runtime port-reverse requires a resolved remote lease.',
    },
  });
  expect(inspectFacts).not.toHaveBeenCalled();
  expect(bindDevice).not.toHaveBeenCalled();
});

test('sessionless port reverse requires an explicit device selector', async () => {
  const inspectFacts = vi.fn();
  const bindDevice = vi.fn();
  const response = await handlePortReverseCommand({
    req: {
      ...baseRequest,
      flags: {
        leaseId: 'lease-1',
        leaseProvider: 'limrun',
        devicePort: 8097,
      },
    },
    session: undefined,
    inspectFacts,
    bindDevice,
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message: expect.stringContaining('active session or an explicit device selector'),
    },
  });
  expect(inspectFacts).not.toHaveBeenCalled();
  expect(bindDevice).not.toHaveBeenCalled();
});
