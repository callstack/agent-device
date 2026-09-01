import type { SessionStore } from '../../../session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../../types.ts';
import { handleFindCommands } from '../find.ts';
import { getRuntimeBindings } from '../../../__tests__/interaction-get-runtime-fixture.ts';

/**
 * One `handleFindCommands` invocation shape.
 *
 * Read-only `find` constructs a BOUND selector backend — it shares the element read with `get` —
 * so every caller needs the request-runtime seams. It lives here rather than in `find.test.ts`
 * because that file is over the module-size tripwire and may only shrink.
 */
export function invokeFindHandler(params: {
  sessionName: string;
  sessionStore: SessionStore;
  positionals: string[];
  flags?: DaemonRequest['flags'];
  invoke: (req: DaemonRequest) => Promise<DaemonResponse>;
}) {
  const { sessionName, sessionStore, positionals, flags } = params;
  return handleFindCommands({
    req: { token: 't', session: sessionName, command: 'find', positionals, flags: flags ?? {} },
    sessionName,
    logPath: '/tmp/test.log',
    sessionStore,
    ...getRuntimeBindings(),
    invoke: params.invoke,
  });
}
