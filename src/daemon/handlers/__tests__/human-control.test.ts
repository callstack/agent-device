import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createRequestExecutionScope } from '../../request-execution-scope.ts';
import {
  HUMAN_CONTROL_LEASE_REQUEST,
  HUMAN_CONTROL_SCOPE,
  humanControlRequest,
  isHumanControlError,
  createControlLatch,
} from '../../__tests__/human-control-fixtures.ts';
import { createHumanControlHarness } from '../../__tests__/human-control-router-fixture.ts';

test('lease-owner takeover uses the production admission gate, preserves the session, and resumes after release', async () => {
  const { registry, lease, handleRequest, sessionStore, sessionName } = createHumanControlHarness();
  const activate = await handleRequest(
    humanControlRequest(lease, 'human_control', ['put', 'console', '{}']),
  );
  assert.equal(activate.ok, true);
  const blocked = await handleRequest(humanControlRequest(lease, 'click', ['10', '10']));
  assert.equal(blocked.ok, false);
  if (blocked.ok) throw new Error('Expected blocked mutation');
  assert.equal(blocked.error.code, 'DEVICE_IN_USE');
  assert.equal(blocked.error.details?.reason, 'human_control_active');
  assert.equal(blocked.error.retriable, true);
  assert.equal((await handleRequest(humanControlRequest(lease, 'snapshot', []))).ok, true);
  assert.equal((await handleRequest(humanControlRequest(lease, 'lease_heartbeat', []))).ok, true);
  assert.ok(sessionStore.get(sessionName));
  const release = await handleRequest(
    humanControlRequest(lease, 'human_control', ['remove', 'console']),
  );
  assert.equal(release.ok, true);
  assert.deepEqual(registry.listHumanControlHolds({ kind: 'host' }), []);
  const scope = await createRequestExecutionScope({
    req: humanControlRequest(lease, 'click', []),
    sessionStore,
    leaseRegistry: registry,
  });
  assert.equal(await scope.runLocked(async () => 'resumed'), 'resumed');
});

test('takeover refuses missing, expired, and foreign lease ownership before changing state', async () => {
  const { registry, lease, handleRequest } = createHumanControlHarness();
  const valid = humanControlRequest(lease, 'human_control', ['put', 'console', '{}']);
  for (const patch of [
    { tenantId: 'tenant-b' },
    { runId: 'run-b' },
    { clientId: 'client-b' },
    { deviceKey: 'other-device' },
    { leaseId: 'aaaaaaaaaaaaaaaa' },
    { leaseProvider: 'other-provider' },
  ]) {
    const response = await handleRequest({ ...valid, meta: { ...valid.meta, ...patch } });
    assert.equal(response.ok, false, JSON.stringify(patch));
    assert.deepEqual(registry.listHumanControlHolds({ kind: 'host' }), []);
  }
  const local = await handleRequest({ ...valid, meta: undefined, session: 'local-no-lease' });
  assert.equal(local.ok, false);
  if (!local.ok) assert.equal(local.error.code, 'UNSUPPORTED_OPERATION');
  registry.releaseLease({ ...HUMAN_CONTROL_LEASE_REQUEST, leaseId: lease.leaseId });
  assert.equal((await handleRequest(valid)).ok, false);
});

test('admitted tenants cannot retarget takeover or release provider-host holds', async () => {
  const { registry, lease, handleRequest } = createHumanControlHarness();
  await registry.putHumanControlHold({ kind: 'host' }, 'host', { scope: HUMAN_CONTROL_SCOPE });
  const injected = await handleRequest(
    humanControlRequest(lease, 'human_control', [
      'put',
      'tenant',
      JSON.stringify({ scope: { ...HUMAN_CONTROL_SCOPE, deviceKey: 'other' } }),
    ]),
  );
  assert.equal(injected.ok, false);
  const denied = await handleRequest(
    humanControlRequest(lease, 'human_control', ['remove', 'host']),
  );
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'UNAUTHORIZED');
  assert.equal(registry.listHumanControlHolds({ kind: 'host' }).length, 1);
});

test('a fresh-session mutation without an advisory device lock still drains before host activation', async () => {
  const { registry, lease, sessionStore } = createHumanControlHarness();
  const req = { ...humanControlRequest(lease, 'click', []), session: 'fresh-session' };
  const scope = await createRequestExecutionScope({ req, sessionStore, leaseRegistry: registry });
  const started = createControlLatch();
  const finish = createControlLatch();
  const mutation = scope.runLocked(async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;
  let active = false;
  const activation = registry
    .putHumanControlHold({ kind: 'host' }, 'host', { scope: HUMAN_CONTROL_SCOPE })
    .then(() => {
      active = true;
    });
  await Promise.resolve();
  assert.equal(active, false);
  const later = await createRequestExecutionScope({
    req: { ...req, session: 'another-fresh-session' },
    sessionStore,
    leaseRegistry: registry,
  });
  await assert.rejects(
    later.runLocked(async () => 'must not run'),
    isHumanControlError,
  );
  finish.resolve();
  await mutation;
  await activation;
  assert.equal(active, true);
});

test('a nested mutation is stopped when takeover begins during its parent request', async () => {
  const { registry, lease, sessionStore } = createHumanControlHarness();
  const req = humanControlRequest(lease, 'replay', []);
  const scope = await createRequestExecutionScope({ req, sessionStore, leaseRegistry: registry });
  let activation: Promise<unknown> | undefined;
  await scope.runLocked(async () => {
    activation = registry.putHumanControlHold({ kind: 'host' }, 'host', {
      scope: HUMAN_CONTROL_SCOPE,
    });
    const nested = await createRequestExecutionScope({
      req: humanControlRequest(lease, 'click', []),
      sessionStore,
      leaseRegistry: registry,
    });
    await assert.rejects(
      nested.runAdmitted(async () => 'must not run'),
      isHumanControlError,
    );
  });
  await activation;
  assert.equal(registry.listHumanControlHolds({ kind: 'host' })[0]?.state, 'active');
});
