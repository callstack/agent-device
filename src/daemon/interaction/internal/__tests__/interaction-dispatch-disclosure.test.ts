import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, test, vi } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { AppError, type DispatchDisclosure } from '@agent-device/kernel/errors';
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
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { captureSnapshotWithInteractor } from '../../../snapshot-interactor-capture.ts';
import { discloseInteractionDispatch } from '../interaction-dispatch-disclosure.ts';
import { handleInteractionCommands } from '../../index.ts';
import { assertAndroidPressStayedInApp } from '../interaction-android-escape.ts';
import { contextFromFlags, makeSession } from './interaction-touch-fixtures.ts';

// contracts/fixtures/dispatch-disclosure.json, daemon and post-action guard rows: the daemon rows
// drive a real `press` through the daemon interaction handler with only the device touch mocked;
// the guard row drives the guard itself.

vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

beforeEach(() => {
  resetGetRuntimeFixture();
});

type PressScenario = {
  command?: 'press' | 'get';
  positionals: string[];
  /** Runs inside the device touch, before it fails. */
  duringTouch?: (store: ReturnType<typeof makeSessionStore>, sessionName: string) => void;
};

async function press({
  command = 'press',
  positionals,
  duringTouch,
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
  sessionStore.set(session.name, session);
  if (duringTouch) {
    mockTapPoint.mockImplementationOnce(async () => {
      duringTouch(sessionStore, session.name);
      throw new AppError('COMMAND_FAILED', 'touch failed');
    });
  }
  const response = await handleInteractionCommands({
    req: { token: 't', session: session.name, command, positionals, flags: {} },
    sessionName: session.name,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
  assert.ok(response && !response.ok, `expected the ${command} to fail`);
  throw new AppError(response.error.code, response.error.message, response.error.details);
}

async function refusedPress(positionals: string[]): Promise<unknown> {
  try {
    return await press({ positionals });
  } finally {
    assert.equal(mockTapPoint.mock.calls.length, 0, 'a refusal must not reach the device');
  }
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
  return await discloseInteractionDispatch(
    { token: 't', session: session.name, command: 'press', positionals: ['@e1'] },
    async () => {
      await assertAndroidPressStayedInApp(session, '@e1', observation);
      return null;
    },
  );
}

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'daemon.refusal.ref-not-found': () => refusedPress(['@e9']),
  'daemon.refusal.admission': () => refusedPress([]),
  'daemon.unclassified': () => pressAfterUnclassifiedTouchFailure(),
  'daemon.unclassified.session-replaced': () =>
    press({
      positionals: ['@e1'],
      duringTouch: (store, name) => {
        const current = store.get(name);
        assert.ok(current);
        store.set(name, { ...current });
      },
    }),
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
    discloseInteractionDispatch(
      { token: 't', session: 's', command: 'get', positionals: ['text', 'label="Missing"'] },
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
