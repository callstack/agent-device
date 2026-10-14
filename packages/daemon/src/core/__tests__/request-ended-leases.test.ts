import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { replayScriptSourceBundleFor } from '@agent-device/replay-port/replay-script-source-fixtures';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import {
  type EndedLeaseLedger,
  onDelegatingLedger,
  recordEndedLease,
  reportEndedLeases,
} from '../request-ended-leases.ts';

const SESSION = 'default';

function leasedDaemon() {
  const root = mkdtempForTestSync('agent-device-ended-leases-');
  const sessionStore = makeSessionStore('agent-device-ended-leases-store-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    deviceKey: 'ios:sim-1',
  });
  sessionStore.publish(
    SESSION,
    makeIosSession(SESSION, {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseProvider: lease.leaseProvider,
        clientId: lease.clientId,
        deviceKey: lease.deviceKey,
      },
    }),
  );
  const handler = createRequestHandler({
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(root, 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return {
    root,
    handler,
    leaseRegistry,
    endedLeases: [{ leaseId: lease.leaseId, outcome: 'released' }],
  };
}

function request(command: string, positionals: string[] = [], flags = {}): DaemonRequest {
  return { token: 'test-token', session: SESSION, command, positionals, flags };
}

test('a close reports the lease it ended once, at response level', async () => {
  const { handler, leaseRegistry, endedLeases } = leasedDaemon();

  const response = await handler(request('close'));

  expect(response).toMatchObject({ ok: true, data: { endedLeases } });
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});

test('a batch reports the lease its close step ended on the batch reply only', async () => {
  const { handler, endedLeases } = leasedDaemon();

  const response = await handler(
    request('batch', [], { batchSteps: [{ command: 'close', positionals: [], flags: {} }] }),
  );

  expect(response).toMatchObject({
    ok: true,
    data: { endedLeases, results: [{ command: 'close', ok: true }] },
  });
  expect(response).not.toMatchObject({ data: { results: [{ data: { endedLeases } }] } });
});

test('a batch that fails after its close step reports the ended lease in the error details', async () => {
  const { handler, endedLeases } = leasedDaemon();

  const response = await handler(
    request('batch', [], {
      batchSteps: [
        { command: 'close', positionals: [], flags: {} },
        { command: 'snapshot', positionals: [], flags: {} },
      ],
    }),
  );

  expect(response).toMatchObject({ ok: false, error: { details: { endedLeases } } });
});

test('a request that ended no lease replies without endedLeases', async () => {
  const response = await reportEndedLeases(request('snapshot'), async () => ({
    ok: true,
    data: {},
  }));

  expect(response).toEqual({ ok: true, data: {} });
});

test('a nested request records on its delegating ledger and reports nothing itself', async () => {
  const ledger: EndedLeaseLedger = [];
  const nested = onDelegatingLedger(request('close'), {
    ...request('batch'),
    internal: { endedLeases: ledger },
  });

  const response = await reportEndedLeases(nested, async (req) => {
    recordEndedLease(req, 'lease-1');
    return { ok: true, data: {} };
  });

  expect(response).toEqual({ ok: true, data: {} });
  expect(ledger).toEqual([{ leaseId: 'lease-1', outcome: 'released' }]);
});

test('a replay reports the lease its script close ended', async () => {
  const { root, handler, endedLeases } = leasedDaemon();
  const scriptPath = path.join(root, 'close.ad');
  fs.writeFileSync(scriptPath, 'close\n');

  const response = await handler(
    request('replay', [scriptPath], {
      replayScriptSource: replayScriptSourceBundleFor(scriptPath),
    }),
  );

  expect(response).toMatchObject({ ok: true, data: { endedLeases } });
});
