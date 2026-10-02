import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';
import { beforeEach, expect, test, vi } from 'vitest';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../../index.ts';
import {
  getRuntimeBindings,
  mockTapElementSelector,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  makeStaleRefSession,
  makeTwoButtonNodes,
  runInteraction,
} from './interaction-touch-fixtures.ts';
import { refFrameState } from '../../../ref-frame.ts';
import { captureSnapshotWithInteractor } from '../../../snapshot-interactor-capture.ts';

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })),
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

beforeEach(() => {
  resetGetRuntimeFixture();
  vi.mocked(captureSnapshotWithInteractor).mockReset();
});

test.each([
  ['ELEMENT_NOT_FOUND', 'element not found'],
  ['AMBIGUOUS_MATCH', 'Selector matched multiple elements'],
] as const)(
  'maestro-flagged click keeps runner %s error without snapshot fallback',
  async (code, message) => {
    const sessionStore = makeSessionStore();
    const sessionName = `ios-maestro-direct-selector-${code}`;
    sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
    mockTapElementSelector.mockRejectedValue(new AppError(code, message));

    const response = await handleInteractionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'click',
        positionals: ['id="submit"'],
        flags: { maestro: { allowNonHittableCoordinateFallback: true } },
      },
      sessionName,
      sessionStore,
      contextFromFlags,
      ...getRuntimeBindings(),
    });

    expect(response?.ok).toBe(false);
    if (response?.ok === false) expect(response.error.code).toBe(code);
  },
);

test('Maestro selector click crosses the ADR 0014 fused seam and expires the ref frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'maestro-direct-ios-seam';
  sessionStore.set(sessionName, makeStaleRefSession(sessionName));

  const click = await runInteraction(sessionStore, sessionName, 'click', ['label=Continue'], {
    maestro: { allowNonHittableCoordinateFallback: true },
  });

  expect(click?.ok).toBe(true);
  expect(mockTapElementSelector).toHaveBeenCalledOnce();
  expect(refFrameState(sessionStore.get(sessionName)!)).toBe('expired');
});

// contracts/fixtures/dispatch-disclosure.json, maestro-direct rows: a Maestro selector click through
// the daemon handler with the runner's selector tap mocked to fail; the row decides whether the
// tree path may tap again.

const DIRECT_TAP_FAILURES: Record<string, () => AppError> = {
  'maestro-direct.fallback.pre-send-refusal': () =>
    new AppError('COMMAND_FAILED', 'Runner did not accept connection', {
      runnerConnectFailureReason: 'runner_connect_refused',
      dispatched: 'no',
    }),
  'maestro-direct.fallback.lost-reply': () =>
    new AppError('COMMAND_FAILED', 'fetch failed', {
      recovery: 'status_probe_failed',
      dispatched: 'unknown',
    }),
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every maestro-direct dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DIRECT_TAP_FAILURES));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const failure = DIRECT_TAP_FAILURES[row.id];
    assert.ok(failure, `no driver for ${row.id}`);
    assert.equal(typeof row.fallsBack, 'boolean', `${row.id} must state fallsBack`);
    const sessionStore = makeSessionStore();
    const sessionName = `maestro-direct-${row.id}`;
    sessionStore.set(sessionName, makeStaleRefSession(sessionName));
    mockTapElementSelector.mockRejectedValueOnce(failure());
    vi.mocked(captureSnapshotWithInteractor).mockResolvedValue({
      nodes: makeTwoButtonNodes(),
      backend: 'xctest',
      producer: 'apple-runner',
    });

    const response = await runInteraction(sessionStore, sessionName, 'click', ['label=Continue'], {
      maestro: { allowNonHittableCoordinateFallback: true },
    });

    expect(mockTapElementSelector).toHaveBeenCalledOnce();
    expect(mockTapPoint.mock.calls.length).toBe(row.fallsBack ? 1 : 0);
    if (row.fallsBack) {
      expect(response?.ok).toBe(true);
      return;
    }
    expect(response?.ok).toBe(false);
    if (response?.ok === false) expect(response.error.details?.dispatched).toBe(row.dispatched);
  });
}
