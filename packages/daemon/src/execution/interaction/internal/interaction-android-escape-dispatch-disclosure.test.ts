import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/test-kit';
import { makeAndroidSession } from '../../../__tests__/support/session-factories.ts';
import { discloseRequestDispatch } from '../../request-dispatch-disclosure.ts';
import { createRequestDispatchLedger } from '../../../core/request-dispatch-ledger.ts';
import { assertAndroidPressStayedInApp } from './interaction-android-escape.ts';

// contracts/fixtures/dispatch-disclosure.json, post-action guard rows: the guard is driven itself,
// inside the router's dispatch seam.

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

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'post-action-guard.android-press-left-app': pressThatLeftTheApp,
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every post-action guard dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DRIVERS));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const drive = DRIVERS[row.id];
    assert.ok(drive, `no driver for ${row.id}`);
    await assert.rejects(drive(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.expectedPackage, 'com.example.app');
      assert.equal(error.details?.foregroundPackage, 'com.android.settings');
      assert.equal(error.details?.dispatched, row.dispatched);
      return true;
    });
  });
}
