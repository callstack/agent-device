import { createAgentDeviceClient } from './agent-device-client.ts';
import { AppError } from '@agent-device/kernel/errors';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { AgentDeviceClientConfig } from '@agent-device/contracts/client';
import type { PluginCandidate } from '@agent-device/plugins/registry';
import type { AgentDeviceHost, StartAgentDeviceOptions } from './sdk/host-types.ts';

/** Starts an embedded runtime and returns its pinned client and close handle. */
export async function startAgentDevice(options: StartAgentDeviceOptions): Promise<AgentDeviceHost> {
  const sourceHost = options.host ?? captureHostEnvironment(process);
  const host = { env: { ...sourceHost.env }, cwd: sourceHost.cwd };
  if (typeof options.stateDir !== 'string' || options.stateDir.trim().length === 0) {
    throw new AppError('INVALID_ARGS', 'startAgentDevice requires a stateDir.', {
      hint: 'Pass an explicit stateDir to startAgentDevice({ stateDir }).',
    });
  }
  const candidates: PluginCandidate[] = (options.plugins ?? []).map((plugin) => ({
    source: 'embedder',
    load: () => plugin,
  }));
  const runtimeHost: HostEnvironment = {
    env: {
      ...host.env,
      AGENT_DEVICE_STATE_DIR: options.stateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'socket',
    },
    cwd: host.cwd,
  };
  const stateDir = resolveDaemonPaths(options.stateDir, {
    env: runtimeHost.env,
    cwd: runtimeHost.cwd,
  }).baseDir;
  const [{ startDaemonRuntime }, { composeDaemonRuntimeDeps }, { resolveLocalDaemonCodeIdentity }] =
    await Promise.all([
      import('@agent-device/daemon'),
      import('./daemon-composition.ts'),
      import('./daemon-client/daemon-launch-spec.ts'),
    ]);
  const codeIdentity = await resolveLocalDaemonCodeIdentity();
  const output = { write: () => {} };
  const runtime = await startDaemonRuntime({
    host: runtimeHost,
    stdout: output,
    stderr: output,
    ownership: 'embedded',
    codeIdentity,
    composeDeps: async (input) => await composeDaemonRuntimeDeps(input, candidates),
  });
  try {
    const identity = runtime.identity;
    if (identity.startTime === null) {
      throw new AppError('COMMAND_FAILED', 'This host cannot pin its runtime identity.', {
        reason: 'host_instance_unreadable',
        pid: identity.pid,
        hint: 'Use a detached daemon on this platform.',
      });
    }
    const clientConfig: AgentDeviceClientConfig = Object.freeze({
      stateDir,
      daemonLifecycle: 'attach',
      daemonTransport: 'socket',
      cwd: host.cwd,
      daemonBaseUrl: '',
      daemonBinding: Object.freeze({
        token: runtime.token,
        pid: identity.pid,
        processStartTime: identity.startTime,
      }),
    });
    return Object.freeze({
      client: createAgentDeviceClient(clientConfig, { host }),
      clientConfig,
      close: () => runtime.close(),
    });
  } catch (error) {
    // A failed client construction must not leave its runtime holding the state directory.
    await runtime.close({ cause: error }).catch(() => {});
    throw error;
  }
}
