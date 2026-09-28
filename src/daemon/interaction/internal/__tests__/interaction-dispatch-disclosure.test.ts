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
import { handleInteractionCommands } from '../../index.ts';
import { assertAndroidPressStayedInApp } from '../interaction-android-escape.ts';
import { contextFromFlags, makeSession } from './interaction-touch-fixtures.ts';

// contracts/fixtures/dispatch-disclosure.json, daemon seam and post-action guard rows: the seam
// rows drive a real `press` through the daemon interaction handler with only the device touch
// mocked; the guard row drives the guard itself.

vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

beforeEach(() => {
  resetGetRuntimeFixture();
});

async function pressRef(ref: string): Promise<unknown> {
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
  const response = await handleInteractionCommands({
    req: { token: 't', session: session.name, command: 'press', positionals: [ref], flags: {} },
    sessionName: session.name,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
  assert.ok(response && !response.ok, 'expected the press to fail');
  throw new AppError(response.error.code, response.error.message, response.error.details);
}

async function pressAfterUnclassifiedTouchFailure(
  details?: Record<string, unknown>,
): Promise<unknown> {
  mockTapPoint.mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'touch failed', details));
  return await pressRef('@e1');
}

async function pressThatLeftTheApp(): Promise<unknown> {
  const session = makeAndroidSession('dispatch-disclosure-android', {
    appBundleId: 'com.example.app',
  });
  const observation = {
    readAppState: async () => ({ package: 'com.android.settings' }),
    isPermissionPackage: async () => false,
  } as unknown as AndroidObservationAdapter;
  return await assertAndroidPressStayedInApp(session, '@e1', observation);
}

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'daemon.refusal-before-seam': async () => {
    try {
      return await pressRef('@e9');
    } finally {
      assert.equal(mockTapPoint.mock.calls.length, 0, 'a refusal must not reach the device');
    }
  },
  'daemon.unclassified-after-seam': () => pressAfterUnclassifiedTouchFailure(),
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

test('the seam keeps a producer verdict instead of inferring its own', async () => {
  for (const dispatched of ['no', 'yes'] satisfies DispatchDisclosure[]) {
    await assert.rejects(pressAfterUnclassifiedTouchFailure({ dispatched }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, dispatched);
      return true;
    });
  }
});
