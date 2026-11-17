import { test, expect, beforeEach } from 'vitest';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { activateCompleteRefFrame, expireRefFrame } from '../../../core/ref-frame.ts';
import { STALE_SNAPSHOT_REFS_WARNING } from '../../session-snapshot.ts';
import {
  installInteractorSnapshotResolution,
  mockInteractorSnapshot,
} from '../../../__tests__/support/interactor-resolution-fixture.ts';
import { touchCreateCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
import { runInteraction } from '../../../__tests__/support/touch-interaction-runner.ts';
import {
  getRuntimeBindings,
  mockFillPoint,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';
import {
  contextFromFlags,
  makeSession,
  makeStaleRefSession,
} from './__tests__/interaction-touch-fixtures.ts';
import { handleInteractionCommands } from '../index.ts';

// How fill is admitted and projected: its @ref admission and pins, and the bound fill the resolved
// point reaches.

beforeEach(() => {
  resetGetRuntimeFixture();
  installInteractorSnapshotResolution();
  mockInteractorSnapshot.mockReset();
});

test('fill @ref dispatches the resolved point with the typing delay and records the ref', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'fill-ref-record';
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        identifier: 'auth_email',
        rect: { x: 44, y: 120, width: 200, height: 32 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.publish(sessionName, session);

  const response = await runInteraction(
    sessionStore,
    sessionName,
    'fill',
    ['@e1', 'hello@example.com'],
    { delayMs: 25 },
  );

  expect(response?.ok).toBe(true);
  expect(mockFillPoint).toHaveBeenCalledWith(
    expect.objectContaining({
      point: { x: 144, y: 136 },
      text: 'hello@example.com',
      delayMs: 25,
    }),
  );
  const result = (sessionStore.get(sessionName)?.actions[0]?.result ?? {}) as Record<
    string,
    unknown
  >;
  expect(result.ref).toBe('e1');
});

test('fill @ref rejects after a device action expired the frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'stale-ref-fill';
  const session = makeStaleRefSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 10, y: 20, width: 200, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  // ADR 0014: an unobserved device action expired the frame.
  expireRefFrame(session);
  sessionStore.publish(sessionName, session);
  mockFillPoint.mockRejectedValue(
    new Error('dispatch should not be called for an expired-frame ref'),
  );

  const response = await runInteraction(sessionStore, sessionName, 'fill', [
    '@e1',
    'hello@example.com',
  ]);
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/expired ref frame/);
    expect(response.error.details?.reason).toBe('ref_frame_expired');
    expect(response.error.details?.hint).toBe(STALE_SNAPSHOT_REFS_WARNING);
  }
  expect(mockFillPoint).not.toHaveBeenCalled();
});

test('fill with a pinned stale ref rejects; pinned current is clean', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'pinned-fill';
  const session = makeStaleRefSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 10, y: 20, width: 200, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.snapshotGeneration = 3;
  // Re-issue the frame over the overridden snapshot so its source tree matches.
  activateCompleteRefFrame(session);
  sessionStore.publish(sessionName, session);

  const stale = await runInteraction(sessionStore, sessionName, 'fill', ['@e1~s2', 'hello']);
  expect(stale?.ok).toBe(false);
  if (stale && !stale.ok) {
    expect(stale.error.code).toBe('COMMAND_FAILED');
    expect(stale.error.details?.reason).toBe('ref_generation_mismatch');
    expect(stale.error.details?.dispatched).toBe('no');
    expect(stale.error.details?.hint).toBe(
      "Ref @e1 was minted from snapshot s2 but the session's ref frame is now s3 — re-run snapshot -i.",
    );
  }
  expect(mockFillPoint).not.toHaveBeenCalled();

  const current = await runInteraction(sessionStore, sessionName, 'fill', ['@e1~s3', 'hello']);
  expect(current?.ok).toBe(true);
  if (current?.ok) {
    expect(current.data?.warning).toBeUndefined();
  }
});

test("ADR 0014 blocker-2: a mutating find's internal fill from an expired frame carries no stale-ref warning", async () => {
  // Removing the coarse marker (step 8) means an expired frame now derives read
  // staleness. A mutating `find fill` re-resolves the locator itself and re-enters
  // the fill leaf with a LOCATOR-minted ref (`internal.findResolvedTarget`) — the
  // caller never consumed a `@ref`, so the public find response must not claim
  // stale refs even though the frame is expired.
  const sessionStore = makeSessionStore();
  const sessionName = 'find-internal-fill-expired';
  const session = makeStaleRefSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        label: 'Email',
        rect: { x: 10, y: 20, width: 200, height: 40 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  // Re-issue the frame over the overridden snapshot, then expire it as if a prior
  // device side effect changed the screen.
  activateCompleteRefFrame(session);
  expireRefFrame(session);
  sessionStore.publish(sessionName, session);
  mockFillPoint.mockResolvedValue({ filled: true });

  // Contrast: a user-supplied `@ref` against the expired frame rejects before
  // dispatch (it consumed a stale ref).
  const userRef = await runInteraction(sessionStore, sessionName, 'fill', ['@e1', 'hello']);
  expect(userRef?.ok).toBe(false);
  if (userRef && !userRef.ok) {
    expect(userRef.error.details?.reason).toBe('ref_frame_expired');
    expect(userRef.error.details?.dispatched).toBe('no');
  }
  expect(mockFillPoint).not.toHaveBeenCalled();

  // The mutating find's internal dispatch (the exact request find.ts hands the
  // leaf) bypasses admission AND attaches no stale-ref warning.
  const findNodes = session.snapshot.nodes;
  const findNode = findNodes[0]!;
  const internal = await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e1', 'hello'],
      flags: {},
      internal: {
        findResolvedTarget: { ref: '@e1', node: findNode, tree: { nodes: findNodes } },
      },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
  expect(internal?.ok).toBe(true);
  if (internal?.ok) {
    expect(internal.data?.warning).toBeUndefined();
  }
});
