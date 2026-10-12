import { handleInteractionCommands } from '../../../daemon/interaction/index.ts';
import { getRuntimeBindings } from '../../../daemon/__tests__/interaction-get-runtime-fixture.ts';
import { contextFromFlags } from '../../../daemon/interaction/internal/__tests__/interaction-touch-fixtures.ts';
import { testCreateCommandSurface } from '../command-surface-fixture.ts';
import type { SessionStore } from '../../../daemon/session-store.ts';

/**
 * The real command-surface legs the relocated interaction suites drive through the handler.
 * The daemon-policy suites keep their fake surface and the shared factories in
 * `interaction-touch-fixtures.ts`; running the real command surface is the composition these
 * suites moved here to pin, so the runners live beside them.
 */
export async function runInteraction(
  sessionStore: SessionStore,
  sessionName: string,
  command: string,
  positionals: string[],
  flags: Record<string, unknown> = {},
) {
  return await handleInteractionCommands({
    createCommandSurface: testCreateCommandSurface,
    req: { token: 't', session: sessionName, command, positionals, flags },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
}

export async function runFindInternalClick(
  sessionStore: SessionStore,
  sessionName: string,
  internal: Record<string, unknown>,
) {
  return await handleInteractionCommands({
    createCommandSurface: testCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'click',
      positionals: ['@e2'],
      flags: { noRecord: true },
      internal,
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
}
