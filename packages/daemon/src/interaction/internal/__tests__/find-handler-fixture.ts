import type { SessionStore } from '../../../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../../daemon-request.ts';
import { handleFindCommands } from '../find.ts';
import { getRuntimeBindings } from '../../../__tests__/interaction-get-runtime-fixture.ts';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';

/**
 * One `handleFindCommands` invocation shape.
 *
 * Read-only `find` constructs a BOUND selector backend — it shares the element read with `get` —
 * so every caller needs the request-runtime seams. It lives in its own sibling fixture module,
 * rather than in any one `find*.test.ts` file, because several of those files share it.
 */
export function invokeFindHandler(params: {
  createCommandSurface?: CreateDaemonCommandSurface;
  sessionName: string;
  sessionStore: SessionStore;
  positionals: string[];
  flags?: DaemonRequest['flags'];
  invoke: (req: DaemonRequest) => Promise<DaemonResponse>;
}) {
  const { sessionName, sessionStore, positionals, flags, createCommandSurface } = params;
  return handleFindCommands({
    createCommandSurface: createCommandSurface ?? fakeCreateCommandSurface,
    req: { token: 't', session: sessionName, command: 'find', positionals, flags: flags ?? {} },
    sessionName,
    logPath: '/tmp/test.log',
    sessionStore,
    ...getRuntimeBindings(),
    invoke: params.invoke,
  });
}
