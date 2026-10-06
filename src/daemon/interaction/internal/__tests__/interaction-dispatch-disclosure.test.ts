import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, test, vi } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { AppError, type DispatchDisclosure, normalizeError } from '@agent-device/kernel/errors';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { makeAndroidSession } from '../../../../__tests__/test-utils/session-factories.ts';
import {
  getRuntimeBindings,
  mockFillPoint,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { captureSnapshotWithInteractor } from '../../../snapshot-interactor-capture.ts';
import { discloseRequestDispatch } from '../../../request-dispatch-disclosure.ts';
import {
  createRequestDispatchLedger,
  recordBoundMutations,
} from '../../../request-dispatch-ledger.ts';
import type { BindDeviceRuntime } from '../../../request-runtime-binding.ts';
import { clearAndroidObservationFixture } from '../../../__tests__/android-observation-fixture.ts';
import { activateCompleteRefFrame, expireRefFrame } from '../../../ref-frame.ts';
import { handleInteractionCommands } from '../../index.ts';
import type { InteractionRouteInput } from '../types.ts';
import { assertAndroidPressStayedInApp } from '../interaction-android-escape.ts';
import { gestureRuntimeBindingsFixture } from './gesture-runtime-bindings.fixtures.ts';
import {
  contextFromFlags,
  makeSession,
  makeStaleRefSession,
} from './interaction-touch-fixtures.ts';

// contracts/fixtures/dispatch-disclosure.json, daemon and post-action guard rows: the daemon rows
// drive a real `press` through the daemon interaction handler, inside the router's dispatch seam,
// with only the device touch mocked; the guard row drives the guard itself.

vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

beforeEach(() => {
  resetGetRuntimeFixture();
});

/**
 * The interaction route as the request router runs it: inside the request's dispatch seam, with
 * the bound operations recording their mutations in the request's ledger.
 */
async function routeInteraction(params: InteractionRouteInput) {
  const dispatchLedger = createRequestDispatchLedger();
  const unrecorded = params.bindDevice;
  const bindDevice: BindDeviceRuntime | undefined = unrecorded
    ? async (device, use) => recordBoundMutations(await unrecorded(device, use), dispatchLedger)
    : undefined;
  return await discloseRequestDispatch(
    params.req,
    dispatchLedger,
    async () => await handleInteractionCommands({ ...params, bindDevice }),
  );
}

type PressScenario = {
  command?: 'press' | 'get' | 'fill';
  positionals: string[];
  flags?: Record<string, unknown>;
};

async function press({
  command = 'press',
  positionals,
  flags = {},
}: PressScenario): Promise<unknown> {
  const sessionStore = makeSessionStore();
  const session = makeSession('dispatch-disclosure');
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.publish(session.name, session);
  const response = await routeInteraction({
    req: { token: 't', session: session.name, command, positionals, flags },
    sessionName: session.name,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
  assert.ok(response && !response.ok, `expected the ${command} to fail`);
  throw new AppError(response.error.code, response.error.message, response.error.details);
}

async function refusedPress(
  positionals: string[],
  flags?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await press({ positionals, flags });
  } finally {
    assert.equal(mockTapPoint.mock.calls.length, 0, 'a refusal must not reach the device');
  }
}

async function refusedFill(positionals: string[]): Promise<unknown> {
  try {
    return await press({ command: 'fill', positionals });
  } finally {
    assert.equal(mockFillPoint.mock.calls.length, 0, 'a refusal must not reach the device');
  }
}

/** A press whose readiness wait polls a tree that never lists the selector's target. */
async function pressWhoseTargetNeverAppears(): Promise<unknown> {
  const capture = vi.mocked(captureSnapshotWithInteractor);
  capture.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'Application',
        label: 'Example',
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
    ],
    backend: 'xctest',
    producer: 'apple-runner',
  });
  try {
    await refusedPress(['label="Missing"'], { readinessTimeoutMs: 300 });
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, 'selector_not_found');
    const readiness = error.details?.readiness as { polls: number } | undefined;
    assert.ok(readiness && readiness.polls >= 2, `expected >=2 polls, got ${readiness?.polls}`);
    throw error;
  } finally {
    capture.mockReset();
  }
  assert.fail('expected the press to be refused');
}

async function pressAfterUnclassifiedTouchFailure(
  details?: Record<string, unknown>,
): Promise<unknown> {
  mockTapPoint.mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'touch failed', details));
  return await press({ positionals: ['@e1'] });
}

async function pressThatLeftTheApp(): Promise<unknown> {
  const session = makeAndroidSession('dispatch-disclosure-android', {
    appBundleId: 'com.example.app',
  });
  const observation = {
    readAppState: async () => ({ package: 'com.android.settings' }),
    isPermissionPackage: async () => false,
  } as unknown as AndroidObservationAdapter;
  return await discloseRequestDispatch(
    { token: 't', session: session.name, command: 'press', positionals: ['@e1'] },
    createRequestDispatchLedger(),
    async () => {
      await assertAndroidPressStayedInApp(session, '@e1', observation);
      return null;
    },
  );
}

/** `swipe --count 2` whose first repetition runs and whose second is refused before dispatch. */
async function swipeRefusedOnSecondRepetition(): Promise<unknown> {
  const gestures = gestureRuntimeBindingsFixture();
  for (const plan of [gestures.performGesturePlan, gestures.performDirectionalFlingPlan]) {
    plan
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new AppError('COMMAND_FAILED', 'runner busy', { reason: 'runner_busy', dispatched: 'no' }),
      );
  }
  const sessionStore = makeSessionStore();
  const session = makeSession('dispatch-disclosure-swipe');
  sessionStore.publish(session.name, session);
  const response = await routeInteraction({
    req: {
      token: 't',
      session: session.name,
      command: 'swipe',
      positionals: [],
      flags: {},
      input: { from: { x: 100, y: 600 }, to: { x: 100, y: 200 }, count: 2 },
    },
    sessionName: session.name,
    sessionStore,
    contextFromFlags,
    inspectFacts: gestures.inspectFacts,
    bindDevice: gestures.bindDevice,
  });
  assert.ok(response && !response.ok, 'expected the swipe series to fail');
  assert.equal(
    gestures.performGesturePlan.mock.calls.length +
      gestures.performDirectionalFlingPlan.mock.calls.length,
    2,
  );
  assert.equal(response.error.details?.dispatchedSteps, 1);
  throw new AppError(response.error.code, response.error.message, response.error.details);
}

/** A stale drag ref is rejected before binding any gesture operation. */
async function gestureDragRefusedBeforeDispatch(): Promise<unknown> {
  const gestures = gestureRuntimeBindingsFixture();
  const sessionStore = makeSessionStore();
  const session = makeStaleRefSession('dispatch-disclosure-stale-drag');
  expireRefFrame(session);
  sessionStore.publish(session.name, session);
  const response = await routeInteraction({
    req: {
      token: 't',
      session: session.name,
      command: 'gesture',
      positionals: [],
      flags: {},
      input: {
        kind: 'drag',
        source: '@e1',
        destination: '@e2',
        sourceHoldMs: 100,
        moveMs: 100,
        destinationHoldMs: 100,
      },
    },
    sessionName: session.name,
    sessionStore,
    contextFromFlags,
    inspectFacts: gestures.inspectFacts,
    bindDevice: gestures.bindDevice,
  });
  assert.ok(response && !response.ok, 'expected stale drag admission to fail');
  assert.equal(response.error.details?.reason, 'ref_frame_expired');
  assert.equal(gestures.bindDevice.mock.calls.length, 0, 'admission must precede runtime binding');
  throw new AppError(response.error.code, response.error.message, response.error.details);
}

async function refRefusedAfterAndroidRecovery(command: 'press' | 'gesture'): Promise<unknown> {
  const gestures = gestureRuntimeBindingsFixture();
  const sessionStore = makeSessionStore();
  const session = makeAndroidSession('dispatch-disclosure-recovered-drag', {
    appBundleId: 'com.example.app',
  });
  session.snapshot = makeStaleRefSession('recovery-frame').snapshot;
  activateCompleteRefFrame(session);
  sessionStore.publish(session.name, session);
  const tap = vi.fn(clearAndroidObservationFixture.tap);
  const openApp = vi.fn(clearAndroidObservationFixture.openApp);
  const androidObservation: AndroidObservationAdapter = {
    ...clearAndroidObservationFixture,
    readBlockingDialog: async () => ({
      status: 'dialog',
      focus: { package: 'com.example.app', focusedWindow: 'Application Not Responding', raw: '' },
    }),
    readSnapshotNodes: async () => [
      {
        index: 0,
        ref: 'e0',
        type: 'Button',
        label: 'Close app',
        rect: { x: 10, y: 20, width: 100, height: 40 },
      },
    ],
    tap,
    openApp,
  };
  const response = await routeInteraction({
    req: {
      token: 't',
      session: session.name,
      command,
      positionals: command === 'press' ? ['@e1'] : [],
      flags: {},
      input: {
        kind: 'drag',
        source: '@e1',
        destination: '@e2',
        sourceHoldMs: 100,
        moveMs: 100,
        destinationHoldMs: 100,
      },
    },
    sessionName: session.name,
    sessionStore,
    contextFromFlags,
    ...(command === 'gesture'
      ? { inspectFacts: gestures.inspectFacts, bindDevice: gestures.bindDevice }
      : getRuntimeBindings()),
    androidObservation,
  });
  assert.ok(response && !response.ok, 'expected stale drag admission to fail after recovery');
  assert.equal(response.error.details?.reason, 'ref_frame_expired');
  assert.equal(tap.mock.calls.length, 1);
  assert.equal(openApp.mock.calls.length, 1);
  assert.equal(mockTapPoint.mock.calls.length, 0);
  if (command === 'gesture') {
    assert.equal(gestures.bindDevice.mock.calls.length, 0);
    assert.equal(
      response.error.details?.warning,
      'Recovered Android app ANR before gesture: closed and relaunched com.example.app.',
    );
    assert.match(response.error.hint ?? '', /Capture a fresh interactive snapshot/);
  }
  throw new AppError(response.error.code, response.error.message, response.error.details);
}

/** An Android press whose tap returns and whose post-press foreground read is refused with `no`. */
async function pressThenForegroundReadRefused(): Promise<unknown> {
  const session = makeAndroidSession('dispatch-disclosure-post-dispatch', {
    appBundleId: 'com.example.app',
  });
  const sessionStore = makeSessionStore();
  sessionStore.publish(session.name, session);
  const readRefusal = new AppError('COMMAND_FAILED', 'adb device offline', { dispatched: 'no' });
  const androidObservation: AndroidObservationAdapter = {
    ...clearAndroidObservationFixture,
    readAppState: async () => {
      if (mockTapPoint.mock.calls.length > 0) throw readRefusal;
      return { package: 'com.example.app' };
    },
  };
  const response = await routeInteraction({
    req: { token: 't', session: session.name, command: 'press', positionals: ['50', '40'] },
    sessionName: session.name,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
    androidObservation,
  });
  assert.equal(mockTapPoint.mock.calls.length, 1);
  assert.ok(response && !response.ok, 'expected the press to fail after its tap');
  assert.equal(response.error.message, 'adb device offline');
  assert.equal(response.error.details?.dispatchedSteps, 1);
  throw new AppError(response.error.code, response.error.message, response.error.details);
}

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'daemon.refusal.ref-not-found': () => refusedPress(['@e9']),
  'daemon.refusal.admission': () => refusedPress([]),
  'daemon.refusal.fill-admission': () => refusedFill(['@e1']),
  'daemon.refusal.selector-readiness-exhausted': pressWhoseTargetNeverAppears,
  'daemon.unclassified': () => pressAfterUnclassifiedTouchFailure(),
  'daemon.series.swipe-later-repetition-refused': swipeRefusedOnSecondRepetition,
  'daemon.refusal.gesture-drag-admission': gestureDragRefusedBeforeDispatch,
  'daemon.post-dispatch.gesture-drag-after-recovery': () =>
    refRefusedAfterAndroidRecovery('gesture'),
  'daemon.post-dispatch.ref-after-android-recovery': () => refRefusedAfterAndroidRecovery('press'),
  'daemon.post-dispatch.press-then-foreground-read-refused': pressThenForegroundReadRefused,
  'daemon.read-only-command': () =>
    press({ command: 'get', positionals: ['text', 'label="Missing"'] }),
  'post-action-guard.android-press-left-app': pressThatLeftTheApp,
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every daemon and post-action guard dispatch-disclosure row has exactly one driver', () => {
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

test('the daemon keeps a producer verdict instead of inferring its own', async () => {
  for (const dispatched of ['no', 'unknown'] satisfies DispatchDisclosure[]) {
    await assert.rejects(pressAfterUnclassifiedTouchFailure({ dispatched }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, dispatched);
      return true;
    });
  }
});

test('a read-only command discloses no over a producer verdict', async () => {
  const capture = vi.mocked(captureSnapshotWithInteractor);
  capture.mockClear();
  capture.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'runner capture lost', { dispatched: 'unknown' }),
  );
  await assert.rejects(
    press({ command: 'get', positionals: ['text', 'label="Missing"'] }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'runner capture lost');
      assert.equal(error.details?.dispatched, 'no');
      return true;
    },
  );
  assert.equal(capture.mock.calls.length, 1);
});

test('a read-only command discloses no over a producer verdict it throws', async () => {
  const producerFailure = new AppError('COMMAND_FAILED', 'runner capture lost', {
    dispatched: 'unknown',
  });
  await assert.rejects(
    discloseRequestDispatch(
      { token: 't', session: 's', command: 'get', positionals: ['text', 'label="Missing"'] },
      createRequestDispatchLedger(),
      async () => {
        throw producerFailure;
      },
    ),
    (error: unknown) => {
      assert.equal(error, producerFailure);
      assert.equal(producerFailure.details?.dispatched, 'no');
      return true;
    },
  );
});

test('a plain Error a backend throws reaches the wire with dispatched unknown', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('dispatch-disclosure-plain-error');
  sessionStore.publish(session.name, session);
  const bindings = getRuntimeBindings();
  const bindDevice = vi.fn(async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof bindings.bindDevice;
  await assert.rejects(
    routeInteraction({
      req: { token: 't', session: session.name, command: 'press', positionals: ['@e1'], flags: {} },
      sessionName: session.name,
      sessionStore,
      contextFromFlags,
      ...bindings,
      bindDevice,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'socket hang up');
      assert.equal(normalizeError(error).details?.dispatched, 'unknown');
      return true;
    },
  );
  assert.equal(vi.mocked(bindDevice).mock.calls.length, 1);
});
