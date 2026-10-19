import { test, expect, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import {
  resetTouchSurfaceFake,
  touchSurfaceConfigs,
} from '../../../__tests__/support/touch-command-surface-fake.ts';
import { runInteraction } from '../../../__tests__/support/touch-interaction-runner.ts';
import {
  elementReadFixtureState,
  mockQuerySelector,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';
import { makeSession } from './__tests__/interaction-touch-fixtures.ts';

// What the shared runtime dispatch hands the command surface: the tapped point and the recorded
// `@ref` the caller wrote, and the off-screen rescue hook that rides the request-bound binding.

beforeEach(() => {
  resetGetRuntimeFixture();
  resetTouchSurfaceFake();
});

test('press @ref taps the resolved point once and records the ref', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'press-ref';
  const session = makeSession(sessionName);
  const nodes = attachRefs([
    {
      index: 0,
      type: 'XCUIElementTypeButton',
      label: 'Continue',
      identifier: 'auth_continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      enabled: true,
      hittable: true,
    },
  ]);
  session.snapshot = { nodes, createdAt: Date.now(), backend: 'xctest' };
  sessionStore.publish(sessionName, session);

  const response = await runInteraction(sessionStore, sessionName, 'press', ['@e1']);

  expect(response?.ok).toBe(true);
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
  expect(mockTapPoint.mock.calls[0]?.[0]?.point).toEqual({ x: 60, y: 40 });
  const stored = sessionStore.get(sessionName);
  expect(stored?.actions[0]?.positionals).toEqual(['@e1']);
  expect(stored?.actions[0]?.flags).toEqual({});
});

// #1542 wiring, daemon route: the off-screen rescue's live read rides the SAME request-bound
// binding the touch command was admitted for. These two tests pin both declared sides of the
// CONDITIONAL `querySelector` fact: an owner that advertises it hands the command surface a
// rescue hook that answers with the live rect; an owner that does not hands it none, so the guard
// refuses on the bulk-tree verdict with ZERO queries. Deleting `conditional: ['querySelector']`
// from the captured touch uses, or making the rescue hook return undefined, breaks one of these
// two; the Apple binding's own spread is pinned in platform-apple's runtime.test.ts.

const RESCUE_ROUTE_SESSION = 'rescue-route';

function offscreenRefSessionStore() {
  const sessionStore = makeSessionStore();
  const session = makeSession(RESCUE_ROUTE_SESSION);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        depth: 0,
        type: 'Window',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeButton',
        label: 'Far item',
        identifier: 'far_item',
        rect: { x: 20, y: 1200, width: 120, height: 44 },
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.publish(RESCUE_ROUTE_SESSION, session);
  return sessionStore;
}

const FAR_ITEM = { identifier: 'far_item', label: 'Far item' };
const ROOT_VIEWPORT = { x: 0, y: 0, width: 390, height: 844 };

test('press @ref hands the command surface a rescue hook that reads the live rect when the owner advertises querySelector', async () => {
  const sessionStore = offscreenRefSessionStore();
  elementReadFixtureState.querySelectorAvailable = true;
  mockQuerySelector.mockResolvedValue({
    found: true,
    node: { rect: { x: 20, y: 400, width: 120, height: 44 }, hittable: true },
  });

  const response = await runInteraction(sessionStore, RESCUE_ROUTE_SESSION, 'press', ['@e2']);

  expect(response?.ok).toBe(true);
  const confirm = touchSurfaceConfigs.at(-1)?.backend.confirmOffscreenTargetVisible;
  expect(confirm).toBeDefined();
  // The rescue answers with the LIVE rect, not the stale bulk-tree row's off-screen geometry, and
  // the live read carried the derived selector.
  const rescued = await confirm!({}, FAR_ITEM, ROOT_VIEWPORT);
  expect(rescued).toEqual({ x: 20, y: 400, width: 120, height: 44 });
  expect(mockQuerySelector).toHaveBeenCalledTimes(1);
  expect(mockQuerySelector.mock.calls[0]?.[0].selector).toEqual({
    key: 'id',
    value: 'far_item',
  });
});

test('press @ref hands the command surface no rescue hook when the owner does not advertise querySelector', async () => {
  // The fixture default: the owner's facts declare the CONDITIONAL read unavailable, so the
  // route holds no hook and the guard's refusal is built from the bulk tree alone.
  const sessionStore = offscreenRefSessionStore();

  const response = await runInteraction(sessionStore, RESCUE_ROUTE_SESSION, 'press', ['@e2']);

  expect(response?.ok).toBe(true);
  expect(touchSurfaceConfigs.at(-1)?.backend.confirmOffscreenTargetVisible).toBeUndefined();
  expect(mockQuerySelector).not.toHaveBeenCalled();
});
