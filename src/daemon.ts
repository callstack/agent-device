import { asAppError } from '@agent-device/kernel/errors';
import { SessionStore } from './daemon/session-store.ts';
import { assertDaemonPolicyAllowsCapability } from './daemon/daemon-policy.ts';
import { startDaemonRuntime } from './daemon/server/daemon-runtime.ts';
import { loadDaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { openWebSessionNames } from './daemon/web-session-names.ts';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';

void (async () => {
  const env = process.env;
  const daemonPaths = resolveDaemonPaths(env.AGENT_DEVICE_STATE_DIR);
  // ADR 0029: a policy that cannot be read or validated stops startup; the daemon never runs
  // with a weaker policy than its operator named.
  const daemonPolicy = loadDaemonPolicy(env);
  const sessionStore = new SessionStore(daemonPaths.sessionsDir);
  const deps = await createDaemonRuntimeDeps({
    env,
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
  await startDaemonRuntime({ env, sessionStore, deps });
})().catch((error) => {
  const appErr = asAppError(error);
  process.stderr.write(`Daemon error: ${appErr.message}\n`);
  process.exit(1);
});
