import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { expect } from 'vitest';
import { legacyDispatchCapture } from '../../../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import {
  getRuntimeBindings,
  mockFillPoint,
  mockFocusPoint,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { makeSessionStore } from '../../../../__tests__/support/store-factory.ts';
import { makeIosSession as makeSession } from '../../../../__tests__/support/session-factories.ts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import type { SessionState } from '../../../../core/session-state.ts';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import type { handleFindCommands } from '../find.ts';
import { invokeFindHandler } from './find-handler-fixture.ts';

export { mockFocusPoint };
export const findTouchRuntimeBindings = getRuntimeBindings;
/**
 * Find's delegated touch legs record their calls on the shared capture double, so the suite can
 * assert which command each leg re-invoked without a dispatcher to observe (R58).
 */
export const mockDispatch = legacyDispatchCapture;

export function resetFindTouchRuntimeFixture(): void {
  resetGetRuntimeFixture();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockImplementation(async (_device: unknown, command: string) => {
    return command === 'snapshot' ? { nodes: [] } : {};
  });
  mockTapPoint.mockImplementation(async (input) => {
    return await legacyDispatchCapture(
      IOS_SIMULATOR,
      'press',
      [String(input.point.x), String(input.point.y)],
      undefined,
      input.execution,
    );
  });
  mockFillPoint.mockImplementation(async (input) => {
    return await legacyDispatchCapture(
      IOS_SIMULATOR,
      'fill',
      [String(input.point.x), String(input.point.y), input.text],
      undefined,
      input.execution,
    );
  });
}

/**
 * One `handleFindCommands` click/focus/type scenario: seeds a session (default or given),
 * stubs the snapshot capture with `nodes` when supplied, and records every `invoke` call.
 *
 * Shared scenario runner for the find interaction tests.
 */
export async function runFindClickScenario(options: {
  positionals: string[];
  nodes?: Array<Record<string, unknown>>;
  flags?: DaemonRequest['flags'];
  session?: SessionState;
  createCommandSurface?: CreateDaemonCommandSurface;
  invoke?: (req: DaemonRequest) => Promise<Record<string, unknown>>;
}): Promise<{
  response: NonNullable<Awaited<ReturnType<typeof handleFindCommands>>>;
  invokeCalls: DaemonRequest[];
  session: SessionState;
}> {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = options.session ?? makeSession(sessionName);
  sessionStore.publish(sessionName, session);

  if (options.nodes !== undefined) {
    mockDispatch.mockImplementation(async (_device, command) => {
      if (command === 'snapshot') {
        return { nodes: options.nodes };
      }
      return {};
    });
  }

  const invokeCalls: DaemonRequest[] = [];
  const response = await invokeFindHandler({
    createCommandSurface: options.createCommandSurface,
    sessionName,
    sessionStore,
    positionals: options.positionals,
    flags: options.flags,
    invoke: async (req) => {
      invokeCalls.push(req);
      const data = options.invoke ? await options.invoke(req) : {};
      return { ok: true, data } as DaemonResponse;
    },
  });

  expect(response).toBeTruthy();
  return { response: response!, invokeCalls, session };
}
