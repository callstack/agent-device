import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { SessionStore } from '../../../../core/session-store.ts';
import type { DaemonRequest } from '../../../../core/daemon-request.ts';
import { bindFindSessionForTest } from '../../../../__tests__/support/find-session-authority-fixture.ts';
import { handleFindCommands } from '../find.ts';
import { getRuntimeBindings } from '../../../__tests__/interaction-get-runtime-fixture.ts';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';

/**
 * One `handleFindCommands` invocation shape.
 *
 * Read-only `find` constructs a BOUND selector backend — it shares the element read with `get` —
 * so every caller needs the request-runtime seams. It lives in its own sibling fixture module,
 * rather than in any one `find*.test.ts` file, because several of those files share it.
 *
 * The mutating actions take their session effects from the dispatcher, so this builds the same
 * lifetime-bound authority the dispatcher's `bindSession` hands them rather than a stand-in.
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
  const req: DaemonRequest = {
    token: 't',
    session: sessionName,
    command: 'find',
    positionals,
    flags: flags ?? {},
  };
  return handleFindCommands({
    createCommandSurface: createCommandSurface ?? fakeCreateCommandSurface,
    req,
    sessionName,
    logPath: '/tmp/test.log',
    sessionStore,
    findSession: bindFindSessionForTest({ sessionStore, sessionName, req }),
    ...getRuntimeBindings(),
    invoke: params.invoke,
  });
}
