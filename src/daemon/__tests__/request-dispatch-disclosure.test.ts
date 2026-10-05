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
import { resolveCommandRecordingEffect } from '@agent-device/command-registry/registry';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import type { DeviceRuntimeGateway, RuntimeFacts } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import {
  makeAndroidSession,
  makeIosAppSession,
  makeSession,
} from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import { discloseRequestDispatch } from '../request-dispatch-disclosure.ts';
import { createRequestDispatchLedger } from '../request-dispatch-ledger.ts';
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

const RUNNER_BUSY = () =>
  new AppError('COMMAND_FAILED', 'runner busy', { reason: 'runner_busy', dispatched: 'no' });

const CONTINUE_BUTTON = {
  index: 0,
  type: 'XCUIElementTypeButton',
  label: 'Continue',
  rect: { x: 10, y: 20, width: 100, height: 40 },
  enabled: true,
  hittable: true,
};

const EMAIL_FIELD = {
  index: 1,
  type: 'XCUIElementTypeTextField',
  label: 'Email',
  rect: { x: 10, y: 80, width: 200, height: 40 },
  enabled: true,
  hittable: true,
};

/** The operations the lifecycle gateway lacks that these rows drive, one spy each. */
const routeOperationSpies = {
  tapPoint: vi.fn(async () => undefined),
  focusPoint: vi.fn(async () => undefined),
  typeText: vi.fn(async () => undefined),
  back: vi.fn(async () => undefined),
  finalizeApplicationClose: vi.fn(async () => undefined as void),
};

const available = Object.freeze({ available: true as const });

function withRouteOperationFacts(
  facts: RuntimeFacts<PlatformRuntimeOperations>,
): RuntimeFacts<PlatformRuntimeOperations> {
  const operations = { ...facts.operations };
  for (const name of Object.keys(routeOperationSpies) as (keyof typeof routeOperationSpies)[]) {
    operations[name] = available;
  }
  return { ...facts, operations };
}

const routeDeviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
  inspectFacts: async (device) =>
    withRouteOperationFacts(await lifecycleDeviceRuntimeGateway.inspectFacts(device)),
  bind: async (request) => {
    const binding = await lifecycleDeviceRuntimeGateway.bind(request);
    return {
      ...binding,
      facts: withRouteOperationFacts(binding.facts),
      operations: { ...binding.operations, ...routeOperationSpies },
    };
  },
  shutdown: async () => {},
};

beforeEach(() => {
  for (const spy of Object.values(routeOperationSpies)) spy.mockClear();
  routeOperationSpies.typeText.mockImplementation(async () => undefined);
  routeOperationSpies.finalizeApplicationClose.mockImplementation(async () => undefined);
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
  sessionStore.publish(SESSION, session);
  const handler = createRequestHandler({
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    deviceRuntimeGateway: routeDeviceRuntimeGateway,
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

/** A list whose `Email` row stays below the fold while each pass moves the content up. */
function belowTheFoldList(offset: number): unknown[] {
  return [
    {
      index: 0,
      type: 'XCUIElementTypeScrollView',
      label: 'Form',
      hiddenContentBelow: true,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeTextField',
      label: 'Email',
      rect: { x: 0, y: 4000 - offset, width: 400, height: 40 },
    },
  ];
}

/** Refuses the third gesture after two returned; the content moves only when a gesture returns. */
async function scrollRefusedOnThirdPass(flags: DaemonRequest['flags'], positionals: string[]) {
  gestureRuntimeSpies.captureSnapshot.mockImplementation(async () => {
    const moved = gestureRuntimeSpies.scrollDirection.mock.calls.length;
    return {
      backend: 'xctest',
      producer: 'apple-runner',
      nodes: belowTheFoldList(moved * 100),
    } as never;
  });
  gestureRuntimeSpies.scrollDirection
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(RUNNER_BUSY());
  const failure = await route(makeSession(SESSION), {
    command: 'scroll',
    positionals,
    flags,
  }).catch((error: unknown) => error);
  assert.equal(gestureRuntimeSpies.scrollDirection.mock.calls.length, 3);
  assert.ok(failure instanceof AppError);
  assert.equal(failure.message, 'runner busy');
  assert.equal(failure.details?.dispatchedSteps, 2);
  throw failure;
}

async function androidScrollThenDialogReadRefused(): Promise<unknown> {
  const observation: AndroidObservationAdapter = {
    ...clearAndroidObservationFixture,
    readBlockingDialog: async () => {
      if (gestureRuntimeSpies.scrollDirection.mock.calls.length > 0) {
        throw new AppError('COMMAND_FAILED', 'adb device offline', { dispatched: 'no' });
      }
      return { status: 'clear' };
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

/**
 * The named session is absent from the store, which is what "no active session" means for a
 * request: the CLI asks the daemon to find a device and none resolves. The row's command carries
 * no declared recording effect, so the `no` under test is the producer's own, not the seam's.
 */
async function sessionOrSelectorRefusedBeforeRouting(): Promise<unknown> {
  const failure = await route(makeSession(SESSION), {
    command: 'capabilities',
    positionals: [],
    session: 'session-never-opened',
  });
  assert.fail(`expected the routing refusal, got ${String(failure)}`);
}

function captureNodes(nodes: readonly unknown[]): void {
  gestureRuntimeSpies.captureSnapshot.mockResolvedValue({
    backend: 'xctest',
    producer: 'apple-runner',
    nodes,
  } as never);
}

async function findTypeRefusedAfterFocus(): Promise<unknown> {
  captureNodes([CONTINUE_BUTTON, EMAIL_FIELD]);
  routeOperationSpies.typeText.mockRejectedValueOnce(RUNNER_BUSY());
  const failure = await route(makeIosAppSession(SESSION), {
    command: 'find',
    positionals: ['Email', 'type', 'hello'],
  }).catch((error: unknown) => error);
  assert.equal(routeOperationSpies.focusPoint.mock.calls.length, 1);
  assert.equal(routeOperationSpies.typeText.mock.calls.length, 1);
  assert.ok(failure instanceof AppError);
  assert.equal(failure.details?.dispatchedSteps, 1);
  throw failure;
}

async function closeThenFinalizeRefused(): Promise<unknown> {
  routeOperationSpies.finalizeApplicationClose.mockRejectedValueOnce(RUNNER_BUSY());
  const failure = await route(makeIosAppSession(SESSION), {
    command: 'close',
    positionals: ['com.example.app'],
  }).catch((error: unknown) => error);
  assert.equal(routeOperationSpies.finalizeApplicationClose.mock.calls.length, 1);
  assert.ok(failure instanceof AppError);
  assert.equal(failure.details?.dispatchedSteps, 1);
  throw failure;
}

async function maestroDeferredSettleCaptureRefused(): Promise<unknown> {
  captureNodes([CONTINUE_BUTTON]);
  gestureRuntimeSpies.captureSnapshot.mockImplementation(async () => {
    if (routeOperationSpies.back.mock.calls.length > 0) throw RUNNER_BUSY();
    return { backend: 'xctest', producer: 'apple-runner', nodes: [CONTINUE_BUTTON] } as never;
  });
  const flowPath = path.join(mkdtempForTestSync('dispatch-route-maestro'), 'flow.yaml');
  fs.writeFileSync(flowPath, 'appId: com.example.app\n---\n- back\n- assertVisible: "Continue"\n');
  const failure = await route(makeIosAppSession(SESSION), {
    command: 'replay',
    positionals: [flowPath],
    flags: { replayBackend: 'maestro', platform: 'ios' },
  }).catch((error: unknown) => error);
  assert.equal(routeOperationSpies.back.mock.calls.length, 1);
  assert.ok(failure instanceof AppError);
  assert.equal(failure.details?.dispatchedSteps, 1);
  throw failure;
}

async function batchOf(
  steps: readonly { command: string; positionals: string[] }[],
): Promise<AppError> {
  captureNodes([CONTINUE_BUTTON]);
  const failure = await route(makeIosAppSession(SESSION), {
    command: 'batch',
    positionals: [],
    flags: { batchSteps: steps.map((step) => ({ ...step, flags: {} })) },
  }).catch((error: unknown) => error);
  assert.ok(failure instanceof AppError);
  assert.equal(failure.details?.executed, 1);
  return failure;
}

async function batchMutationThenRefusedStep(): Promise<unknown> {
  const failure = await batchOf([
    { command: 'press', positionals: ['50', '40'] },
    { command: 'press', positionals: ['label="Missing"'] },
  ]);
  assert.equal(routeOperationSpies.tapPoint.mock.calls.length, 1);
  assert.equal(failure.details?.dispatchedSteps, 1);
  throw failure;
}

async function batchReadThenRefusedStep(): Promise<unknown> {
  const failure = await batchOf([
    { command: 'get', positionals: ['text', 'label="Continue"'] },
    { command: 'press', positionals: ['label="Missing"'] },
  ]);
  assert.equal(routeOperationSpies.tapPoint.mock.calls.length, 0);
  assert.equal(failure.details?.dispatchedSteps, undefined);
  throw failure;
}

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'daemon.route.find-type-refused-after-focus': findTypeRefusedAfterFocus,
  'daemon.route.session-close-then-finalize-refused': closeThenFinalizeRefused,
  'daemon.route.maestro-deferred-settle-capture-refused': maestroDeferredSettleCaptureRefused,
  'daemon.route.batch-mutation-then-refused-step': batchMutationThenRefusedStep,
  'daemon.route.batch-read-then-refused-step': batchReadThenRefusedStep,
  'daemon.route.scroll-transport-failure': scrollWhoseGestureSendFailed,
  'daemon.route.scroll-until-before-first-gesture': scrollUntilRefusedBeforeFirstGesture,
  'daemon.route.scroll-until-third-pass-refused': () =>
    scrollRefusedOnThirdPass({ until: 'label=Email' }, ['down']),
  'daemon.route.scroll-edge-third-pass-refused': () => scrollRefusedOnThirdPass({}, ['bottom']),
  'daemon.route.scroll-then-dialog-read-refused': androidScrollThenDialogReadRefused,
  'daemon.route.read-only-get': readOnlyGet,
  'daemon.route.session-or-selector-refusal': sessionOrSelectorRefusedBeforeRouting,
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

test('a command without a declared recording effect rethrows its failure unnormalized', async () => {
  const req: DaemonRequest = { token: 't', session: SESSION, command: 'devices', positionals: [] };
  assert.equal(resolveCommandRecordingEffect(req), undefined);
  const thrown = { reason: 'not an Error' };
  await assert.rejects(
    discloseRequestDispatch(req, createRequestDispatchLedger(), async () => {
      throw thrown;
    }),
    (error: unknown) => error === thrown,
  );
});
