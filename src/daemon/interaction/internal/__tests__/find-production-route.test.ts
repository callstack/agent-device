import { test, expect, vi, beforeEach } from 'vitest';
import { handleInteractionCommands } from '../../index.ts';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { DaemonRequest, DaemonResponse } from '../../../daemon-request.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { makeIosSession as makeSession } from '../../../../__tests__/test-utils/session-factories.ts';

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveTargetDevice: actual.resolveTargetDevice,
  };
});
vi.mock('../../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

import {
  findTouchRuntimeBindings,
  mockDispatch,
  resetFindTouchRuntimeFixture,
} from './find-touch-runtime-fixture.ts';
import { invokeFindHandler } from './find-handler-fixture.ts';

beforeEach(() => {
  resetFindTouchRuntimeFixture();
});

// --- #1654: the production route, find handler through the real interaction leaf ---
//
// find.test.ts's tests stub `invoke`, so they prove what find SENDS. These drive the real
// `handleInteractionCommands` on the other end, so they prove what the action actually acts on —
// and they fail if either producer (click or fill) stops attaching the channel, which a
// hand-built request cannot catch.

const findRouteContextFromFlags = (flags: CommandFlags | undefined) => ({
  count: flags?.count,
  intervalMs: flags?.intervalMs,
  delayMs: flags?.delayMs,
  holdMs: flags?.holdMs,
  jitterPx: flags?.jitterPx,
  doubleTap: flags?.doubleTap,
  clickButton: flags?.clickButton,
});

/** The tree find's capture returns: "Save" sits at a distinctive point. */
function freshFindTree() {
  return [
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Save',
      rect: { x: 300, y: 500, width: 20, height: 20 },
      enabled: true,
      hittable: true,
    },
  ];
}

/**
 * A defensive tree in which the same ref body names a different element. No
 * reachable production path is currently known to advance `session.snapshot`
 * in this interval; forcing it here pins the one-resolution contract itself.
 */
function divergedSessionTree() {
  return {
    nodes: [
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 }, ref: 'e1' },
      {
        index: 1,
        parentIndex: 0,
        type: 'XCUIElementTypeButton',
        label: 'Delete',
        rect: { x: 10, y: 700, width: 100, height: 40 },
        enabled: true,
        hittable: true,
        ref: 'e2',
      },
    ],
    createdAt: Date.now(),
    backend: 'xctest' as const,
  };
}

async function runFindThroughLeaf(options: {
  positionals: string[];
  divergeBeforeDispatch: boolean;
}): Promise<{ response: DaemonResponse | null; invokeCalls: DaemonRequest[] }> {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeSession(sessionName);
  sessionStore.set(sessionName, session);

  mockDispatch.mockImplementation(async (_device, command) =>
    command === 'snapshot' ? { nodes: freshFindTree(), backend: 'xctest' } : {},
  );

  const invokeCalls: DaemonRequest[] = [];
  const response = await invokeFindHandler({
    sessionName,
    sessionStore,
    positionals: options.positionals,
    invoke: async (req) => {
      invokeCalls.push(req);
      if (options.divergeBeforeDispatch) {
        const current = sessionStore.get(sessionName);
        if (current) {
          current.snapshot = divergedSessionTree();
          sessionStore.set(sessionName, current);
        }
      }
      // The real leaf, not a stub.
      return (
        (await handleInteractionCommands({
          req,
          sessionName,
          sessionStore,
          contextFromFlags: findRouteContextFromFlags,
          ...findTouchRuntimeBindings(),
        })) ?? { ok: false, error: { code: 'COMMAND_FAILED', message: 'no interaction handler' } }
      );
    },
  });
  return { response, invokeCalls };
}

function dispatchedPoint(command: 'press' | 'fill'): string[] | undefined {
  const call = mockDispatch.mock.calls.find((entry) => entry[1] === command);
  return call?.[2] as string[] | undefined;
}

test('#1654 production route: find click carries its resolved node into the real interaction leaf', async () => {
  const { response, invokeCalls } = await runFindThroughLeaf({
    positionals: ['text', 'Save', 'click'],
    divergeBeforeDispatch: false,
  });

  expect(response?.ok).toBe(true);
  // The producer attaches the channel — fails if handleFindClick stops doing so.
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.node?.label).toBe('Save');
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.ref).toBe('@e2');
  expect(dispatchedPoint('press')).toEqual(['310', '510']);
});

test('#1654 production route: find fill carries its resolved node into the real interaction leaf', async () => {
  const { response, invokeCalls } = await runFindThroughLeaf({
    positionals: ['text', 'Save', 'fill', 'hello'],
    divergeBeforeDispatch: false,
  });

  expect(response?.ok).toBe(true);
  // Fill has its own producer and its own forwarding hop; assert it separately.
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.node?.label).toBe('Save');
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.ref).toBe('@e2');
  expect(dispatchedPoint('fill')).toEqual(['310', '510', 'hello']);
});

test('#1654 defensive invariant: a tree that advances mid-dispatch cannot retarget find click', async () => {
  // This deliberately forces an otherwise-unreached state: a second lookup of
  // `@e2` would find "Delete" at (60, 720), while the resolved handoff must keep
  // find's selected "Save" node at (310, 510).
  const { response } = await runFindThroughLeaf({
    positionals: ['text', 'Save', 'click'],
    divergeBeforeDispatch: true,
  });

  expect(response?.ok).toBe(true);
  expect(dispatchedPoint('press')).toEqual(['310', '510']);
});

test('#1654 defensive invariant: a tree that advances mid-dispatch cannot retarget find fill', async () => {
  const { response } = await runFindThroughLeaf({
    positionals: ['text', 'Save', 'fill', 'hello'],
    divergeBeforeDispatch: true,
  });

  expect(response?.ok).toBe(true);
  expect(dispatchedPoint('fill')).toEqual(['310', '510', 'hello']);
});
