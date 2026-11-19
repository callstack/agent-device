import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  revylLease,
  startRevylFixtureBackend,
  type RevylFixtureBackend,
} from './revyl-backend.fixtures.ts';

const CONNECTION = 'GET /api/v1/execution/streaming/worker-connection/run-1';
const openBackends: RevylFixtureBackend[] = [];

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((fixture) => fixture.close()));
});

test('a lease start keeps polling when Revyl answers the worker-connection read with a 500', async () => {
  let connectionPolls = 0;
  const fixture = await startRevylFixtureBackend({
    respond: {
      [CONNECTION]: () => {
        connectionPolls += 1;
        return connectionPolls === 1
          ? { status: 500, body: { detail: 'Internal server error' } }
          : {
              body: {
                status: 'ready',
                workflow_run_id: 'run-1',
                worker_ws_url: 'wss://worker.test/ws',
              },
            };
      },
    },
  });
  openBackends.push(fixture);
  const runtime = fixture.createRuntime({ deviceModel: 'Pixel 7' });

  const allocation = await runtime.leaseLifecycle?.allocate?.(revylLease('android'), {
    initialApp: 'https://apps.test/app.apk',
    flags: { device: 'Pixel 7' },
  });

  assert.ok(allocation);
  assert.deepEqual(
    fixture.paths().filter((path) => path === CONNECTION),
    [CONNECTION, CONNECTION],
  );
});

test('a lease start still fails on a worker-connection answer that is not a server error', async () => {
  const fixture = await startRevylFixtureBackend({
    respond: { [CONNECTION]: { status: 403, body: { detail: 'Forbidden' } } },
  });
  openBackends.push(fixture);
  const runtime = fixture.createRuntime({ deviceModel: 'Pixel 7' });

  await assert.rejects(
    async () =>
      await runtime.leaseLifecycle?.allocate?.(revylLease('android'), {
        initialApp: 'https://apps.test/app.apk',
        flags: { device: 'Pixel 7' },
      }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNAUTHORIZED' &&
      error.details?.providerStatus === 403,
  );
  assert.deepEqual(
    fixture.paths().filter((path) => path === CONNECTION),
    [CONNECTION],
  );
});
