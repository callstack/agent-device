import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DispatchDisclosure } from '@agent-device/kernel/errors';

export const DISPATCH_DISCLOSURE_PRODUCERS = [
  'daemon',
  'ios-runner',
  'android-adb',
  'android-helper',
  'webdriver',
  'post-action-guard',
] as const;

export type DispatchDisclosureProducer = (typeof DISPATCH_DISCLOSURE_PRODUCERS)[number];

export type DispatchDisclosureRow = {
  id: string;
  producer: DispatchDisclosureProducer;
  trigger: string;
  dispatched: DispatchDisclosure;
  /** Direct iOS selector tap rows: whether the failure delegates to the tree path, which taps again. */
  fallsBack?: boolean;
};

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const DISPATCH_DISCLOSURE_TABLE_PATH = path.join(
  REPO_ROOT,
  'contracts/fixtures/dispatch-disclosure.json',
);

/**
 * The test file that drives each row through its real producer, keyed by row-id prefix; the
 * longest matching prefix owns the row. Each driver file runs one test per owned row with the loop `for (const row of <ROWS>) {`
 * followed by `test(\`${row.id}`, which {@link DISPATCH_DISCLOSURE_ROW_LOOP} matches.
 */
export const DISPATCH_DISCLOSURE_DRIVER_OWNERS: Readonly<Record<string, string>> = {
  'daemon.': 'src/daemon/interaction/internal/__tests__/interaction-dispatch-disclosure.test.ts',
  'daemon.scroll-no-progress': 'src/daemon/__tests__/scroll-movement.test.ts',
  'daemon.route.': 'src/daemon/__tests__/request-dispatch-disclosure.test.ts',
  'post-action-guard.':
    'src/daemon/interaction/internal/__tests__/interaction-dispatch-disclosure.test.ts',
  'ios-runner.': 'packages/platform-apple/src/runner/__tests__/runner-dispatch-disclosure.test.ts',
  'ios-runner.pre-send.':
    'packages/platform-apple/src/runner/__tests__/runner-lifecycle-dispatch-disclosure.test.ts',
  'ios-runner.transport.':
    'packages/platform-apple/src/runner/__tests__/runner-lifecycle-dispatch-disclosure.test.ts',
  'android-adb.': 'packages/platform-android/src/__tests__/dispatch-disclosure.test.ts',
  'android-helper.': 'packages/platform-android/src/__tests__/dispatch-disclosure.test.ts',
  'android-helper.gesture-session.':
    'packages/platform-android/src/__tests__/touch-helper-session.test.ts',
  'webdriver.': 'packages/provider-webdriver/src/webdriver-transport.test.ts',
  'maestro-direct.':
    'src/daemon/interaction/internal/__tests__/interaction-touch-direct-ios.test.ts',
};

/** The per-row driving loop every driver file carries. */
export const DISPATCH_DISCLOSURE_ROW_LOOP =
  /for \(const row of [A-Z_]+\) \{\s*test\(`\$\{row\.id\}/;

export function dispatchDisclosureDriverOwner(rowId: string): string | undefined {
  const prefix = Object.keys(DISPATCH_DISCLOSURE_DRIVER_OWNERS)
    .filter((candidate) => rowId.startsWith(candidate))
    .sort((left, right) => right.length - left.length)[0];
  return prefix === undefined ? undefined : DISPATCH_DISCLOSURE_DRIVER_OWNERS[prefix];
}

/** The table's JSON text, read by the test that consumes it: contracts hold no host file access. */
export function parseDispatchDisclosureTable(tableText: string): DispatchDisclosureRow[] {
  return JSON.parse(tableText) as DispatchDisclosureRow[];
}

/** The rows the given driver file owns. */
export function dispatchDisclosureRowsOwnedBy(
  driverFileUrl: string,
  tableText: string,
): DispatchDisclosureRow[] {
  const driverFile = path
    .relative(REPO_ROOT, fileURLToPath(driverFileUrl))
    .split(path.sep)
    .join('/');
  return parseDispatchDisclosureTable(tableText).filter(
    (row) => dispatchDisclosureDriverOwner(row.id) === driverFile,
  );
}

/** A driver file drives exactly the rows it owns: none missing, none naming an absent row. */
export function assertDispatchDisclosureDriversMatchRows(
  owned: readonly DispatchDisclosureRow[],
  driverIds: Iterable<string>,
): void {
  assert.ok(owned.length > 0, 'a dispatch-disclosure driver file must own at least one row');
  assert.deepEqual([...driverIds].sort(), owned.map((row) => row.id).sort());
}
