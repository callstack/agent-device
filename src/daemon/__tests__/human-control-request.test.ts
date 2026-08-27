import assert from 'node:assert/strict';
import { test } from 'vitest';
import { INTERNAL_COMMANDS } from '../../command-catalog.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { HumanControlRegistry } from '../human-control.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestExecutionScope } from '../request-execution-scope.ts';
import { createRequestHandler } from '../request-router.ts';
import type { DaemonRequest } from '../types.ts';
import { lifecycleDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';

test('request execution blocks mutations but permits read-only commands during human control', async () => {
  const sessionName = 'human-control-request';
  const sessionStore = makeSessionStore('agent-device-human-control-request-');
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const registry = new HumanControlRegistry();
  await registry.upsert('operator-1', { scope: { deviceKey: 'sim-1' } });

  let mutationRan = false;
  const mutationScope = await createRequestExecutionScope({
    req: makeRequest(sessionName, 'click'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    humanControlRegistry: registry,
  });
  await assert.rejects(
    mutationScope.runLocked(async () => {
      mutationRan = true;
    }),
    (error: unknown) => (error as { code?: string }).code === 'DEVICE_IN_USE',
  );
  assert.equal(mutationRan, false);

  const readScope = await createRequestExecutionScope({
    req: makeRequest(sessionName, 'snapshot'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    humanControlRegistry: registry,
  });
  assert.equal(await readScope.runLocked(async () => 'read-completed'), 'read-completed');
});

test('socket management command activates the production request gate and releases it', async () => {
  const sessionName = 'human-control-router';
  const sessionStore = makeSessionStore('agent-device-human-control-router-');
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const registry = new HumanControlRegistry();
  let releasedHoldId: string | undefined;
  const handleRequest = createRequestHandler({
    logPath: '/tmp/agent-device-human-control-router.log',
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    humanControlRegistry: registry,
    onHumanControlHoldReleased: (hold) => {
      releasedHoldId = hold.id;
    },
    trackDownloadableArtifact: () => 'artifact-1',
  });

  const activated = await handleRequest({
    ...makeRequest(sessionName, INTERNAL_COMMANDS.humanControl),
    positionals: [
      'put',
      'operator-1',
      JSON.stringify({ scope: { deviceKey: 'sim-1' }, reason: 'Manual inspection' }),
    ],
  });
  assert.equal(activated.ok, true);

  const blocked = await handleRequest(makeRequest(sessionName, 'click'));
  assert.equal(blocked.ok, false);
  if (blocked.ok) throw new Error('Expected click to be blocked');
  assert.equal(blocked.error.code, 'DEVICE_IN_USE');
  assert.equal(blocked.error.details?.reason, 'human_control_active');
  assert.equal(blocked.error.retriable, true);
  assert.match(blocked.error.message, /agent interactions are temporarily disabled/i);

  const released = await handleRequest({
    ...makeRequest(sessionName, INTERNAL_COMMANDS.humanControl),
    positionals: ['remove', 'operator-1'],
  });
  assert.equal(released.ok, true);
  assert.equal(releasedHoldId, 'operator-1');
  assert.deepEqual(registry.list(), []);
});

function makeRequest(session: string, command: string): DaemonRequest {
  return {
    token: 'test-token',
    session,
    command,
    positionals: [],
    flags: {},
  };
}
