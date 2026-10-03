import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  AppError,
  discloseDispatch,
  discloseUnclassifiedDispatch,
} from '@agent-device/kernel/errors';
import {
  DISPATCH_DISCLOSURE_DRIVER_OWNERS,
  DISPATCH_DISCLOSURE_PRODUCERS,
  DISPATCH_DISCLOSURE_ROW_LOOP,
  dispatchDisclosureDriverOwner,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  parseDispatchDisclosureTable,
} from './dispatch-disclosure.fixtures.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DISPATCH_VALUES: readonly string[] = ['no', 'unknown'];

test('a producer verdict overwrites; the seam verdict fills only an unclassified failure', () => {
  const error = new AppError('COMMAND_FAILED', 'tap failed', { hint: 'retry' });
  assert.equal(discloseUnclassifiedDispatch(error, 'unknown'), error);
  assert.equal(error.details?.dispatched, 'unknown');
  assert.equal(discloseDispatch(error, 'no', { dispatchedSteps: 2 }), error);
  assert.deepEqual(error.details, { hint: 'retry', dispatchedSteps: 2, dispatched: 'no' });
  discloseUnclassifiedDispatch(error, 'unknown');
  assert.equal(error.details?.dispatched, 'no');
});

test('dispatch-disclosure rows are unique and use the declared vocabulary', () => {
  const rows = parseDispatchDisclosureTable(
    fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
  );
  assert.ok(rows.length > 0);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'row ids must be unique');
  for (const row of rows) {
    assert.ok((DISPATCH_DISCLOSURE_PRODUCERS as readonly string[]).includes(row.producer), row.id);
    assert.ok(DISPATCH_VALUES.includes(row.dispatched), row.id);
    assert.ok(row.trigger.trim().length > 0, row.id);
    assert.equal(row.fallsBack !== undefined, row.id.startsWith('maestro-direct.'), row.id);
  }
});

test('every row has a driver file, and every owner prefix owns a row', () => {
  const rows = parseDispatchDisclosureTable(
    fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
  );
  const unowned = rows
    .filter((row) => dispatchDisclosureDriverOwner(row.id) === undefined)
    .map((row) => row.id);
  assert.deepEqual(unowned, []);
  const idlePrefixes = Object.keys(DISPATCH_DISCLOSURE_DRIVER_OWNERS).filter(
    (prefix) => !rows.some((row) => row.id.startsWith(prefix)),
  );
  assert.deepEqual(idlePrefixes, []);
  for (const driver of new Set(Object.values(DISPATCH_DISCLOSURE_DRIVER_OWNERS))) {
    const driverPath = path.join(REPO_ROOT, driver);
    assert.ok(fs.existsSync(driverPath), `missing driver file ${driver}`);
    const source = fs.readFileSync(driverPath, 'utf8');
    assert.ok(
      /dispatchDisclosureRowsOwnedBy\(\s*import\.meta\.url,/.test(source) &&
        source.includes('assertDispatchDisclosureDriversMatchRows(') &&
        DISPATCH_DISCLOSURE_ROW_LOOP.test(source),
      `${driver} must drive the rows it owns, one test per row, and assert its drivers match them`,
    );
  }
});
