import { expect } from 'vitest';
import { legacyDispatchCapture } from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { IOS_SIMULATOR } from '../../../../__tests__/test-utils/device-fixtures.ts';
import {
  getRuntimeBindings,
  mockFillPoint,
  mockFocusPoint,
  mockTapPoint,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { makeIosSession as makeSession } from '../../../../__tests__/test-utils/session-factories.ts';
import type { DaemonRequest, DaemonResponse } from '../../../daemon-request.ts';
import type { SessionState } from '../../../session-state.ts';
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
 * It lives here rather than in any one `find*.test.ts` file because several split test files
 * over the module-size tripwire share this scenario runner (docs/agents/testing.md).
 */
export async function runFindClickScenario(options: {
  positionals: string[];
  nodes?: Array<Record<string, unknown>>;
  flags?: DaemonRequest['flags'];
  session?: SessionState;
  invoke?: (req: DaemonRequest) => Promise<Record<string, unknown>>;
}): Promise<{
  response: NonNullable<Awaited<ReturnType<typeof handleFindCommands>>>;
  invokeCalls: DaemonRequest[];
  session: SessionState;
}> {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = options.session ?? makeSession(sessionName);
  sessionStore.set(sessionName, session);

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
