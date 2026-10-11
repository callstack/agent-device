import { asAppError } from '@agent-device/kernel/errors';
import { loadDaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { SessionStore } from '../session-store.ts';
import { assertDaemonPolicyAllowsCapability } from '../daemon-policy.ts';
import { openWebSessionNames } from '../web-session-names.ts';
import { createDaemonRuntimeDeps } from '../../daemon-composition.ts';
import { startDaemonRuntime, type DaemonRuntimeController } from '../server/daemon-runtime.ts';
import type { DaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';

type WritableOutput = { write: (chunk: string) => unknown };

/**
 * The runtime a test boots, exactly as the process root assembles it: the real dependency
 * composition from `src/daemon-composition.ts`, the real policy load, and one session store.
 * A test replaces a composed capability the same way it always has — a `vi.mock` of the root
 * module the composition imports — and every other test boots the real composition.
 */
export async function startDaemonRuntimeFixture(options: {
  env: NodeJS.ProcessEnv;
  exit: (code: number) => void;
  stderr: WritableOutput;
  stdout?: WritableOutput;
  registerProcessHandlers?: boolean;
}): Promise<DaemonRuntimeController | null> {
  const daemonPaths = resolveDaemonPaths(options.env.AGENT_DEVICE_STATE_DIR);
  let daemonPolicy: DaemonPolicy | undefined;
  try {
    daemonPolicy = loadDaemonPolicy(options.env);
  } catch (error) {
    options.stderr.write(`Daemon error: ${asAppError(error).message}\n`);
    options.exit(1);
    return null;
  }
  const sessionStore = new SessionStore(daemonPaths.sessionsDir);
  const deps = await createDaemonRuntimeDeps({
    env: options.env,
    baseDir: daemonPaths.baseDir,
    sessionsDir: daemonPaths.sessionsDir,
    daemonPolicy,
    assertShutdownAllowed: daemonPolicy
      ? () => assertDaemonPolicyAllowsCapability(daemonPolicy, 'device-shutdown')
      : undefined,
    resolveSessionDir: (sessionId) => sessionStore.resolveSessionDir(sessionId),
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: sessionStore.resolveAppLogPath(sessionId),
      pidPath: sessionStore.resolveAppLogPidPath(sessionId),
    }),
    openWebSessionNames: () => openWebSessionNames(sessionStore),
  });
  return await startDaemonRuntime({
    env: options.env,
    exit: options.exit,
    stderr: options.stderr,
    stdout: options.stdout,
    registerProcessHandlers: options.registerProcessHandlers,
    sessionStore,
    deps,
  });
}
