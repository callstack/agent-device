import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});

vi.mock('../device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import { AppError } from '@agent-device/kernel/errors';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { makeAndroidSession, makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import type { SessionState } from '../session-state.ts';
import { clearAndroidObservationFixture } from './android-observation-fixture.ts';
import {
  createRequestHandler,
  gestureRuntimeSpies,
  lifecycleDeviceRuntimeGateway,
} from './test-device-runtime-gateway.ts';

// contracts/fixtures/dispatch-disclosure.json, daemon.route rows: each drives one request through
// the real request router, with only the bound device operations faked.

const SESSION = 'dispatch-route';

beforeEach(() => {
  gestureRuntimeSpies.scrollDirection.mockReset();
  gestureRuntimeSpies.scrollDirection.mockResolvedValue({});
  gestureRuntimeSpies.captureSnapshot.mockReset();
  gestureRuntimeSpies.captureSnapshot.mockResolvedValue({
    backend: 'xctest',
    producer: 'apple-runner',
    nodes: [],
  });
});

async function route(
  session: SessionState,
  req: Pick<DaemonRequest, 'command' | 'positionals'> & Partial<DaemonRequest>,
  androidObservation: AndroidObservationAdapter = clearAndroidObservationFixture,
) {
  const sessionStore = makeSessionStore('agent-device-dispatch-route-');
  sessionStore.set(SESSION, session);
  const handler = createRequestHandler({
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    deviceRuntimeGateway: lifecycleDeviceRuntimeGateway,
    androidObservation,
  });
  const response = await handler({ token: 'test-token', session: SESSION, flags: {}, ...req });
  assert.ok(!response.ok, `expected ${req.command} to fail`);
  throw new AppError(response.error.code, response.error.message, response.error.details);
}

async function scrollWhoseGestureSendFailed(): Promise<unknown> {
  gestureRuntimeSpies.scrollDirection.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'socket hang up'),
  );
  try {
    return await route(makeSession(SESSION), { command: 'scroll', positionals: ['down'] });
  } finally {
    assert.equal(gestureRuntimeSpies.scrollDirection.mock.calls.length, 1);
  }
}

async function scrollUntilRefusedBeforeFirstGesture(): Promise<unknown> {
  try {
    return await route(makeSession(SESSION), {
      command: 'scroll',
      positionals: ['down'],
      flags: { until: 'label="Missing"' },
    });
  } finally {
    assert.equal(gestureRuntimeSpies.captureSnapshot.mock.calls.length, 1);
    assert.equal(gestureRuntimeSpies.scrollDirection.mock.calls.length, 0);
  }
}

async function androidScrollThenDialogReadRefused(): Promise<unknown> {
  const observation: AndroidObservationAdapter = {
    ...clearAndroidObservationFixture,
    readBlockingDialog: async (device) => {
      if (gestureRuntimeSpies.scrollDirection.mock.calls.length > 0) {
        throw new AppError('COMMAND_FAILED', 'adb device offline', { dispatched: 'no' });
      }
      return await clearAndroidObservationFixture.readBlockingDialog(device);
    },
  };
  const failure = await route(
    makeAndroidSession(SESSION, { appBundleId: 'com.example.app' }),
    { command: 'scroll', positionals: ['down'] },
    observation,
  ).catch((error: unknown) => error);
  assert.ok(failure instanceof AppError);
  assert.equal(failure.message, 'adb device offline');
  assert.equal(failure.details?.dispatchedSteps, 1);
  throw failure;
}

async function readOnlyGet(): Promise<unknown> {
  return await route(makeSession(SESSION), {
    command: 'get',
    positionals: ['text', 'label="Missing"'],
  });
}

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'daemon.route.scroll-transport-failure': scrollWhoseGestureSendFailed,
  'daemon.route.scroll-until-before-first-gesture': scrollUntilRefusedBeforeFirstGesture,
  'daemon.route.scroll-then-dialog-read-refused': androidScrollThenDialogReadRefused,
  'daemon.route.read-only-get': readOnlyGet,
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every daemon.route dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DRIVERS));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const drive = DRIVERS[row.id];
    assert.ok(drive, `no driver for ${row.id}`);
    await assert.rejects(drive(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, row.dispatched);
      return true;
    });
  });
}
