import { expect, test } from 'vitest';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import {
  daemonClaimRecoveryGatewayFixture,
  daemonPlatformServicesFixture,
} from '../../__tests__/support/platform-services-fixture.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createRequestExecutionScope } from '../request-execution-scope.ts';

test('createRequestExecutionScope exposes the host of the daemon serving the request', async () => {
  const host = createTestHostEnvironment({
    env: { AGENT_DEVICE_TEST: '1' },
    cwd: '/host/workspace',
  });
  const scope = await createRequestExecutionScope({
    host,
    req: { token: 'test-token', session: 'default', command: 'snapshot', positionals: [] },
    sessionStore: makeSessionStore('agent-device-request-scope-host-'),
    leaseRegistry: new LeaseRegistry(),
    platformServices: daemonPlatformServicesFixture(),
    claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
  });

  expect(scope.host).toBe(host);
});
