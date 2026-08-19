import { beforeEach, expect, test, vi } from 'vitest';
import type { SnapshotResult } from '@agent-device/contracts/platform';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  makeAndroidSession,
  makeIosAppSession,
  makeIosSession,
} from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { withTestDeviceInventory } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import type { DaemonRequest } from '../types.ts';
import { selectorCaptureFixture } from './selector-capture-fixture.ts';

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({ mockRunAppleRunnerCommand: vi.fn() }));

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

import { dispatchIsViaRuntime } from '../selector-runtime.ts';

beforeEach(() => {
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
});

// `is` answers every one of its seven predicates from the resolved capture — `isCommand` never
// reaches `backend.readText`. So its whole platform execution is the request-bound capture, and
// these cases bind at `inspectFacts` / `bindDevice`, never at `core/dispatch.ts`.

const unavailableCapture = { available: false, reason: 'unsupported-device-kind' } as const;
const activeAppRequired = { available: false, reason: 'owner-capability-missing' } as const;

/** One resolvable button, so a predicate has something real to answer about. */
function buttonSnapshot(): SnapshotResult {
  return {
    nodes: [
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        index: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Continue',
        identifier: 'auth_continue',
        rect: { x: 10, y: 20, width: 120, height: 44 },
        enabled: true,
        hittable: true,
      },
    ],
    backend: 'android',
  };
}

function isRequest(session: string, positionals: readonly string[]): DaemonRequest {
  return { token: 't', session, command: 'is', positionals: [...positionals], flags: {} };
}

test('an admitted is inspects once, binds once, and answers through the bound capture', async () => {
  const fixture = selectorCaptureFixture({ snapshot: () => buttonSnapshot() });
  const sessionStore = makeSessionStore();
  sessionStore.set('is-bound', makeAndroidSession('is-bound', { appBundleId: 'com.example.app' }));

  const response = await dispatchIsViaRuntime({
    req: isRequest('is-bound', ['visible', 'id=auth_continue']),
    sessionName: 'is-bound',
    sessionStore,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(response?.ok).toBe(true);
  expect(fixture.inspections).toEqual([ANDROID_EMULATOR]);
  expect(fixture.binds).toEqual([ANDROID_EMULATOR]);
  expect(fixture.captures.length).toBeGreaterThan(0);
});

test('an unavailable capture fact refuses before any bind', async () => {
  // The watchOS sentinel shape: capability-supported today, no snapshot backend at the owner.
  const fixture = selectorCaptureFixture({ capture: unavailableCapture });
  const sessionStore = makeSessionStore();
  sessionStore.set('is-refused', makeAndroidSession('is-refused', { appBundleId: 'com.a' }));

  const response = await dispatchIsViaRuntime({
    req: isRequest('is-refused', ['visible', 'id=auth_continue']),
    sessionName: 'is-refused',
    sessionStore,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(response?.ok).toBe(false);
  // The inspection is what makes this a typed admission refusal rather than a runtime failure:
  // exact owner facts were read once, side-effect-free, and nothing bound or captured after.
  expect(fixture.inspections).toEqual([ANDROID_EMULATOR]);
  expect(fixture.binds).toEqual([]);
  expect(fixture.captures).toEqual([]);
});

// The correctness fix this unit declares. On iOS `appBundleId` is the XCUITest attach target:
// with no tracked app the runner's own process comes to the foreground, DISPLACES the app under
// test, and the capture then answers confidently about the runner's own blank screen. Refusing
// beats displacing-and-lying. Android captures the real launcher in the same state, and the
// platform facts already encode that asymmetry — so `is` asks the facts rather than branching.
test('an iOS session with no tracked app is refused with the open hint, not answered from a displaced capture', async () => {
  const fixture = selectorCaptureFixture({
    withoutActiveApp: activeAppRequired,
    snapshot: () => buttonSnapshot(),
  });
  const sessionStore = makeSessionStore();
  sessionStore.set('is-no-app', makeIosSession('is-no-app'));

  const response = await withTestDeviceInventory(
    {},
    async () =>
      await dispatchIsViaRuntime({
        req: isRequest('is-no-app', ['visible', 'id=auth_continue']),
        sessionName: 'is-no-app',
        sessionStore,
        inspectFacts: fixture.inspectFacts,
        bindDevice: fixture.bindDevice,
      }),
  );

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error?.code).toBe('SESSION_NOT_FOUND');
    expect(response.error?.message).toMatch(/requires an active app session/);
  }
  expect(fixture.binds).toEqual([]);
  expect(fixture.captures).toEqual([]);
});

test('an iOS session WITH a tracked app still answers, so the refusal is the plan split and not an iOS ban', async () => {
  const fixture = selectorCaptureFixture({
    withoutActiveApp: activeAppRequired,
    snapshot: () => buttonSnapshot(),
  });
  const sessionStore = makeSessionStore();
  sessionStore.set('is-with-app', makeIosAppSession('is-with-app'));

  const response = await dispatchIsViaRuntime({
    req: isRequest('is-with-app', ['visible', 'label=Continue']),
    sessionName: 'is-with-app',
    sessionStore,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(response?.ok).toBe(true);
  expect(fixture.binds).toEqual([IOS_SIMULATOR]);
});

test('an Android session with no tracked app proceeds, because the owner advertises the without-active-app capture', async () => {
  const fixture = selectorCaptureFixture({ snapshot: () => buttonSnapshot() });
  const sessionStore = makeSessionStore();
  sessionStore.set('is-android-no-app', makeAndroidSession('is-android-no-app'));

  const response = await dispatchIsViaRuntime({
    req: isRequest('is-android-no-app', ['visible', 'id=auth_continue']),
    sessionName: 'is-android-no-app',
    sessionStore,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(response?.ok).toBe(true);
  expect(fixture.binds).toEqual([ANDROID_EMULATOR]);
});

// ADR 0019: once `is` declares `device-runtime`, NOTHING in its request path may reach the device
// before resolve -> admit -> bind. The direct-iOS selector query is a fast path *within* an
// admitted request, never a way around exact-owner facts or the one-binding invariant.
test('the direct-iOS selector fast path cannot operate when facts refuse admission', async () => {
  const fixture = selectorCaptureFixture({ capture: unavailableCapture });
  const sessionStore = makeSessionStore();
  sessionStore.set('is-direct-refused', makeIosAppSession('is-direct-refused'));
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    nodes: [
      {
        index: 0,
        type: 'Button',
        label: 'Pickup',
        identifier: 'shipping-pickup',
        selected: true,
        rect: { x: 126, y: 555, width: 75, height: 38 },
        enabled: true,
        hittable: true,
      },
    ],
  });

  const response = await dispatchIsViaRuntime({
    req: isRequest('is-direct-refused', ['selected', 'id="shipping-pickup"']),
    sessionName: 'is-direct-refused',
    sessionStore,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(response?.ok).toBe(false);
  expect(mockRunAppleRunnerCommand).not.toHaveBeenCalled();
  expect(fixture.binds).toEqual([]);
});

// The reorder must not cost the fast path its whole point: once admitted, a positive runner
// answer still returns without consuming a capture.
test('a direct-iOS predicate that holds still short-circuits without a capture', async () => {
  const fixture = selectorCaptureFixture({ snapshot: () => buttonSnapshot() });
  const sessionStore = makeSessionStore();
  sessionStore.set('is-direct-true', makeIosAppSession('is-direct-true'));
  mockRunAppleRunnerCommand.mockResolvedValue({
    found: true,
    text: 'Apple Account',
    nodes: [
      {
        index: 0,
        type: 'Button',
        label: 'Apple Account',
        identifier: 'account_row',
        rect: { x: 10, y: 20, width: 120, height: 44 },
        enabled: true,
        hittable: true,
      },
    ],
  });

  const response = await dispatchIsViaRuntime({
    req: isRequest('is-direct-true', ['text', 'id=account_row', 'Apple Account']),
    sessionName: 'is-direct-true',
    sessionStore,
    inspectFacts: fixture.inspectFacts,
    bindDevice: fixture.bindDevice,
  });

  expect(response?.ok).toBe(true);
  // The fast path is still a fast path: a positive answer consumes no capture.
  expect(fixture.captures).toEqual([]);
});
