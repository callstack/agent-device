import type { CommandFlags } from '@agent-device/contracts/command';
import { getRuntimeBindings } from '../../execution/__tests__/interaction-get-runtime-fixture.ts';
import { handleInteractionCommands } from '../../execution/interaction/index.ts';
import type { SessionStore } from '../../core/session-store.ts';
import { touchCreateCommandSurface } from './touch-command-surface-fake.ts';

/** The request-flag projection the interaction handler's runtime context is built from. */
const contextFromFlags = (flags: CommandFlags | undefined) => ({
  count: flags?.count,
  intervalMs: flags?.intervalMs,
  delayMs: flags?.delayMs,
  holdMs: flags?.holdMs,
  jitterPx: flags?.jitterPx,
  doubleTap: flags?.doubleTap,
  clickButton: flags?.clickButton,
});

/**
 * One interaction request through `handleInteractionCommands` on the touch command surface fake
 * and the shared runtime-binding fixture, so suites state only the request they are pinning.
 */
export async function runInteraction(
  sessionStore: SessionStore,
  sessionName: string,
  command: string,
  positionals: string[],
  flags: Record<string, unknown> = {},
) {
  return await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: { token: 't', session: sessionName, command, positionals, flags },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
}

/** The re-entry a mutating `find` makes: a click carrying the node `find` already resolved. */
export async function runFindInternalClick(
  sessionStore: SessionStore,
  sessionName: string,
  internal: Record<string, unknown>,
) {
  return await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
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
