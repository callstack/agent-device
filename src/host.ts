import { AppError } from '@agent-device/kernel/errors';
import { captureHostEnvironment, readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { AgentDeviceClientConfig } from '@agent-device/contracts/client';
import type { AgentDeviceClient } from './client/client-types.ts';
import type { AgentDevicePlugin } from '@agent-device/plugins/contract';
import type { PluginCandidate } from '@agent-device/plugins/registry';
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import type { DaemonRuntimeController, ShutdownReport } from '@agent-device/daemon';

/** One line of runtime output, with the stream it came from. */
export type LogEntry = Readonly<{
  stream: 'stdout' | 'stderr';
  text: string;
}>;

export type StartAgentDeviceOptions = Readonly<{
  /**
   * The state directory this host owns; resolved against `host`'s working directory when relative. It
   * is required: a daemon's identity on disk is its state directory, and a host that inherited an
   * ambient `AGENT_DEVICE_STATE_DIR` would attach to — or replace — a runtime nobody chose.
   */
  stateDir: string;
  /** The environment and working directory to run with. Defaults to one captured copy of this process's. */
  host?: HostEnvironment;
  /**
   * Plugin objects to register after the built-ins, in the order given. The plugin store is not read,
   * so the set is fixed for the runtime's lifetime. Defaults to none.
   */
  plugins?: readonly AgentDevicePlugin[];
  /** Receives this runtime's stdout and stderr lines. Silent when omitted. */
  log?: (entry: LogEntry) => void;
}>;

/**
 * The config that reproduces {@link AgentDeviceHost.client} in another process: local socket attach,
 * pinned to this instance, carrying its token.
 *
 * It is plain JSON, and the token in it is a bearer credential for this instance: keep the object
 * inside the host that owns the daemon. Attach-only is the point — a client built from it dispatches to
 * this instance and can neither start, replace, nor retire a daemon.
 */
export type HostClientConfig = AgentDeviceClientConfig;

export type AgentDeviceHost = Readonly<{
  /** A client pinned to this instance. */
  client: AgentDeviceClient;
  /** See {@link HostClientConfig}. */
  clientConfig: HostClientConfig;
  /** What this runtime registered, active and failed, as `daemon status` shows it. */
  plugins: readonly PluginInventoryEntry[];
  /**
   * Closes the runtime and reports what it could not finish. Repeated and concurrent calls share one
   * close, so closing after a `daemon stop`, or from two overlapping scopes, is not an error. This
   * never exits the process.
   */
  close: () => Promise<ShutdownReport>;
  /** Awaits {@link AgentDeviceHost.close} and returns nothing, as `await using` expects. */
  [Symbol.asyncDispose]: () => Promise<void>;
}>;

/**
 * Starts a daemon inside this process and returns the client pinned to it.
 *
 * It is the daemon executable's own runtime: same registration claim, same authenticated socket
 * protocol on an ephemeral loopback listener, same close. Two things differ. The record it publishes
 * says `embedded`, so no other process signals or replaces it. And the shutdown request that record
 * advertises is answered by the runtime's own `close()` — the same call {@link AgentDeviceHost.close}
 * makes — so an operator's `agent-device daemon stop` and an embedder's `host.close()` tear the
 * instance down identically.
 *
 * A state directory somebody else holds is refused, never taken: `details.reason` is
 * `state-dir-in-use` for a live occupant, and `state-dir-ownership-unproven` when a record is there
 * whose owner cannot be proven dead.
 */
export async function startAgentDevice(options: StartAgentDeviceOptions): Promise<AgentDeviceHost> {
  const sourceHost = options.host ?? captureHostEnvironment(process);
  const host = { env: { ...sourceHost.env }, cwd: sourceHost.cwd };
  if (typeof options.stateDir !== 'string' || options.stateDir.trim().length === 0) {
    throw new AppError('INVALID_ARGS', 'startAgentDevice requires a stateDir.', {
      reason: 'state_dir_required',
      hint: 'Pass the state directory this host owns; it is what every attaching process addresses.',
    });
  }
  // This process's lifetime is knowable before the runtime starts, and the runtime publishes the same
  // pair when it claims the state directory. Reading it first is what lets a host that could never
  // hand out a pin refuse up front instead of after acquiring one.
  const identity = readCurrentOwnerIdentity();
  if (identity.startTime === null) {
    throw new AppError(
      'COMMAND_FAILED',
      'This host cannot pin a daemon instance: its own process start time cannot be read.',
      {
        reason: 'host_instance_unreadable',
        pid: identity.pid,
        hint: 'Use a detached daemon (`agent-device daemon start`, or let a client start one) on this platform.',
      },
    );
  }
  const candidates = embedderPluginCandidates(options.plugins);
  // The runtime reads its state directory and its server mode from the environment like every other
  // consumer of the composition. `runtimeHost` is a copy, so these apply to the runtime alone; the
  // process's own environment is never touched. The mode is pinned because `host.client` is handed the
  // socket address this call publishes: an ambient `http` would start a runtime with no socket
  // listener at all, and the client of the host that started it could not reach it.
  const runtimeHost: HostEnvironment = {
    env: {
      ...host.env,
      AGENT_DEVICE_STATE_DIR: options.stateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'socket',
    },
    cwd: host.cwd,
  };
  // The resolved absolute directory, so a refusal and the config an attacher gets name the same place
  // this process actually claimed, whichever working directory each of them has.
  const stateDir = resolveDaemonPaths(options.stateDir, {
    env: runtimeHost.env,
    cwd: runtimeHost.cwd,
  }).baseDir;
  const [{ startDaemonRuntime }, { composeDaemonRuntimeDeps }] = await Promise.all([
    import('@agent-device/daemon'),
    import('./daemon-composition.ts'),
  ]);
  const streams = createHostLogStreams(options.log);
  let runtime: DaemonRuntimeController;
  try {
    runtime = await startDaemonRuntime({
      host: runtimeHost,
      stdout: streams.stdout,
      stderr: streams.stderr,
      ownership: 'embedded',
      composeDeps: async (input) => await composeDaemonRuntimeDeps(input, candidates),
    });
  } catch (error) {
    throw hostStartupError(error, stateDir);
  }
  try {
    const { createAgentDeviceClient } = await import('./sdk/index.ts');
    const clientConfig: HostClientConfig = Object.freeze({
      // The resolved absolute directory, so an attacher with a different working directory addresses
      // the same daemon rather than resolving a relative path against its own cwd.
      stateDir,
      daemonLifecycle: 'attach',
      daemonTransport: 'socket',
      daemonServerMode: 'socket',
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
      plugins: runtime.plugins,
      close: () => runtime.close(),
      [Symbol.asyncDispose]: async () => {
        await runtime.close();
      },
    });
  } catch (error) {
    // A host nobody can attach to is not a host: close what was started before handing the refusal
    // back, or the state directory stays claimed by a runtime its owner cannot reach.
    await runtime.close({ cause: error }).catch(() => {});
    throw error;
  }
}

/**
 * The embedder's plugin objects as registry candidates. Something that is not a plugin is refused here,
 * at the boundary where the embedder can still fix it, rather than becoming a runtime that silently
 * registers nothing.
 */
function embedderPluginCandidates(plugins: readonly unknown[] | undefined): PluginCandidate[] {
  return (plugins ?? []).map((plugin, index) => {
    if (!isPluginLike(plugin)) {
      throw new AppError('INVALID_ARGS', `plugins[${index}] is not an agent-device plugin.`, {
        reason: 'invalid_embedder_plugin',
        hint: 'Pass what a plugin package default factory returns, e.g. `testmu({ credentials })`.',
      });
    }
    return { source: 'embedder', load: () => plugin };
  });
}

function isPluginLike(plugin: unknown): plugin is Record<string, unknown> {
  return (
    typeof plugin === 'object' &&
    plugin !== null &&
    typeof (plugin as { provider?: unknown }).provider === 'string' &&
    typeof (plugin as { setup?: unknown }).setup === 'function'
  );
}

/**
 * Names, in the vocabulary an embedder acts on, the two refusals that mean "this state directory is not
 * yours". The executable reads an exit code; a library caller has none, so those two statuses are
 * re-stated here with a hint that says what to do instead. Every other refusal keeps what the runtime
 * said, because the runtime already owns the reason.
 *
 * `stateDir` is the directory this call resolved. The runtime's refusal names its status and not the
 * directory — the executable already knows which one it passed — so the host adds the one fact its own
 * caller needs to act on.
 */
function hostStartupError(error: unknown, stateDir: string): unknown {
  if (!(error instanceof AppError) || error.details?.reason !== 'daemon_registration_refused') {
    return error;
  }
  const status = error.details.status;
  if (status !== 'busy' && status !== 'unproven') return error;
  return new AppError(
    'COMMAND_FAILED',
    status === 'unproven'
      ? `Cannot start a host on ${stateDir}: the record there belongs to an owner that cannot be proven dead.`
      : `Cannot start a host on ${stateDir}: another daemon holds the state directory.`,
    {
      reason: status === 'unproven' ? 'state-dir-ownership-unproven' : 'state-dir-in-use',
      stateDir,
      hint: 'Stop the daemon that owns it, or give this host its own state directory. A host never replaces an occupant.',
    },
  );
}

/**
 * The runtime's two output streams, kept as two writers and handed to the embedder one line at a time.
 * A writer that throws is not this runtime's problem to fix, so a sink that fails is dropped rather
 * than reaching the daemon's own write path.
 */
function createHostLogStreams(log: ((entry: LogEntry) => void) | undefined): {
  stdout: { write: (chunk: string) => void };
  stderr: { write: (chunk: string) => void };
} {
  const partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const writer = (stream: 'stdout' | 'stderr') => ({
    write: (chunk: string): void => {
      if (!log) return;
      const combined = `${partial[stream]}${chunk}`;
      const lines = combined.split('\n');
      partial[stream] = lines.pop() ?? '';
      for (const line of lines) {
        try {
          log({ stream, text: `${line}\n` });
        } catch {
          // An embedder's sink owns its own failures; the runtime keeps serving either way.
        }
      }
    },
  });
  return { stdout: writer('stdout'), stderr: writer('stderr') };
}

export type { HostEnvironment, ShutdownReport };
