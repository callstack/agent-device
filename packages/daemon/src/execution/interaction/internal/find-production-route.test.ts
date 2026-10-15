import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { FillCommandResult, PressCommandResult } from '@agent-device/contracts/interaction';
import { test, expect, vi, beforeEach } from 'vitest';
import { handleInteractionCommands } from '../index.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { makeIosSession as makeSession } from '../../../__tests__/support/session-factories.ts';
import { commandSurfaceWithMembers } from '../../../__tests__/support/command-surface-override-fake.ts';
import { installLegacyCaptureInteractorResolution } from '../../../__tests__/support/legacy-capture-interactor-resolution.ts';
import {
  findTouchRuntimeBindings,
  mockDispatch,
  resetFindTouchRuntimeFixture,
} from './__tests__/find-touch-runtime-fixture.ts';
import { invokeFindHandler } from './__tests__/find-handler-fixture.ts';

installLegacyCaptureInteractorResolution();

beforeEach(() => {
  resetFindTouchRuntimeFixture();
});

// --- #1654: the production route, find handler through the real interaction handler ---
//
// find.test.ts's tests stub `invoke`, so they prove what find SENDS. These drive the real
// `handleInteractionCommands` on the other end, so they prove the resolved node survives the hop:
// the command surface receives the node find selected as its `preresolvedTarget`. They fail if
// either producer (click or fill) stops attaching the channel, or the handler stops forwarding it,
// which a hand-built request cannot catch. That the command family then acts on the carried node
// rather than re-resolving the ref is pinned beside it in
// src/commands/interaction/runtime/interactions-find-carried-target.test.ts.

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

type ForwardedTarget = { ref?: string; label?: string };

/**
 * A command surface whose `press`/`fill` record the `preresolvedTarget` the handler forwarded and
 * answer with the carried node, the way the command family does for a carried target.
 */
function recordingTouchSurface(forwarded: ForwardedTarget[]) {
  const answer = (
    options: { preresolvedTarget?: { ref: string; node: { label?: string } } } | undefined,
  ) => {
    forwarded.push({
      ref: options?.preresolvedTarget?.ref,
      label: options?.preresolvedTarget?.node.label,
    });
    return {
      kind: 'ref' as const,
      target: { kind: 'ref' as const, ref: options?.preresolvedTarget?.ref ?? '' },
      point: { x: 310, y: 510 },
    };
  };
  return commandSurfaceWithMembers(() => ({
    interactions: {
      click: vi.fn(async (_target, options) => answer(options) as PressCommandResult),
      press: vi.fn(async (_target, options) => answer(options) as PressCommandResult),
      fill: vi.fn(
        async (_target, text, options) => ({ ...answer(options), text }) as FillCommandResult,
      ),
    },
  }));
}

async function runFindThroughHandler(positionals: string[], forwarded: ForwardedTarget[]) {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.publish(sessionName, makeSession(sessionName));
  mockDispatch.mockImplementation(async (_device, command) =>
    command === 'snapshot' ? { nodes: freshFindTree(), backend: 'xctest' } : {},
  );

  const createCommandSurface = recordingTouchSurface(forwarded);
  const invokeCalls: DaemonRequest[] = [];
  const response = await invokeFindHandler({
    createCommandSurface,
    sessionName,
    sessionStore,
    positionals,
    invoke: async (req) => {
      invokeCalls.push(req);
      return (
        (await handleInteractionCommands({
          createCommandSurface,
          req,
          sessionName,
          sessionStore,
          contextFromFlags: findRouteContextFromFlags,
          ...findTouchRuntimeBindings(),
        })) ??
        ({
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'no interaction handler' },
        } satisfies DaemonResponse)
      );
    },
  });
  return { response, invokeCalls };
}

test('#1654 production route: find click carries its resolved node into the interaction handler', async () => {
  const forwarded: ForwardedTarget[] = [];
  const { response, invokeCalls } = await runFindThroughHandler(
    ['text', 'Save', 'click'],
    forwarded,
  );

  expect(response?.ok).toBe(true);
  // The producer attaches the channel — fails if handleFindClick stops doing so.
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.node?.label).toBe('Save');
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.ref).toBe('@e2');
  expect(forwarded).toEqual([{ ref: '@e2', label: 'Save' }]);
});

test('#1654 production route: find fill carries its resolved node into the interaction handler', async () => {
  const forwarded: ForwardedTarget[] = [];
  const { response, invokeCalls } = await runFindThroughHandler(
    ['text', 'Save', 'fill', 'hello'],
    forwarded,
  );

  expect(response?.ok).toBe(true);
  // Fill has its own producer and its own forwarding hop; assert it separately.
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.node?.label).toBe('Save');
  expect(invokeCalls[0]?.internal?.findResolvedTarget?.ref).toBe('@e2');
  expect(forwarded).toEqual([{ ref: '@e2', label: 'Save' }]);
});
