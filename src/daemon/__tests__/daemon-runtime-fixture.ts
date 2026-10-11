import { createDaemonRuntimeDeps } from '../../daemon-composition.ts';
import {
  startDaemonRuntime,
  type ComposeDaemonRuntimeDeps,
  type DaemonRuntimeController,
} from '../server/daemon-runtime.ts';

type WritableOutput = { write: (chunk: string) => unknown };

/**
 * The runtime a test boots through the one assembly the process root uses: `startDaemonRuntime`
 * with the real composition factory from `src/daemon-composition.ts`, so the paths, the policy
 * load, the session store, and the `assertShutdownAllowed` derivation under test are exactly the
 * production ones. A test replaces a composed capability the same way it always has — a
 * `vi.mock` of the root module the composition imports — or passes its own `composeDeps` factory
 * when it needs to fake the composed half outright.
 */
export async function startDaemonRuntimeFixture(options: {
  env: NodeJS.ProcessEnv;
  exit: (code: number) => void;
  stderr: WritableOutput;
  stdout?: WritableOutput;
  registerProcessHandlers?: boolean;
  composeDeps?: ComposeDaemonRuntimeDeps;
}): Promise<DaemonRuntimeController | null> {
  return await startDaemonRuntime({
    env: options.env,
    exit: options.exit,
    stderr: options.stderr,
    stdout: options.stdout,
    registerProcessHandlers: options.registerProcessHandlers,
    composeDeps: options.composeDeps ?? createDaemonRuntimeDeps,
  });
}
