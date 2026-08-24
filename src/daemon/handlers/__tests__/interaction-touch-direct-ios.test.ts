import { AppError } from '@agent-device/kernel/errors';
import { beforeEach, expect, test, vi } from 'vitest';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../interaction.ts';
import {
  getRuntimeBindings,
  mockTapElementSelector,
  resetGetRuntimeFixture,
} from './interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  makeStaleRefSession,
  runInteraction,
} from './interaction-touch-fixtures.ts';

vi.mock('../../../platforms/android/input-actions.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/input-actions.ts')>();
  return { ...actual, getAndroidScreenSize: vi.fn(async () => ({ width: 1344, height: 2992 })) };
});

vi.mock('../../../platforms/android/app-lifecycle.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/app-lifecycle.ts')>();
  return {
    ...actual,
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogFocus: vi.fn(async () => null),
  };
});

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

beforeEach(() => resetGetRuntimeFixture());

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
  expect(sessionStore.get(sessionName)?.refFrameState).toBe('expired');
});
