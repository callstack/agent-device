import type { PlatformHost } from '@agent-device/plugins/contract';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

/**
 * The host a platform plugin's `setup` receives. Alongside the one-shot command port and the
 * executable probe, it answers a request to keep one of the plugin's commands running — a streamed
 * device log — through the same managed app-log process service the core's own runtime host uses, so
 * a plugin never spawns a process of its own and its stream gets the same ownership marker, stop, and
 * cleanup. The command's own `env` is what the plugin prepared, so a family that resolves its tool
 * chain from roots the core does not name streams with the same `PATH` it runs one-shot commands with.
 *
 * That process service belongs to the operation-host zone, which the daemon itself reaches only
 * through a lazy seam. A plugin host is built when a process starts, so it loads the service with the
 * first streamed command rather than statically, exactly as this file's command port does.
 */
export function createPlatformPluginHost(
  host: HostEnvironment,
  stateDir: string,
  resources: Readonly<{
    openWebSessionNames?: () => readonly string[];
    ownedProcessRecords?: PlatformHost['ownedProcessRecords'];
    /** The session root a managed process marker must stay inside; the state dir's by default. */
    sessionsDir?: string;
  }> = {},
): PlatformHost {
  const {
    sessionsDir = resolveDaemonPaths(stateDir, { env: host.env, cwd: host.cwd }).sessionsDir,
    ...pluginResources
  } = resources;
  let processes: Awaited<ReturnType<typeof loadManagedAppLogProcesses>> | undefined;
  return Object.freeze({
    ...host,
    stateDir,
    ...pluginResources,
    emitDiagnostic,
    withDiagnosticTimer,
    runCommand: async (executable, args, options) => {
      const { runCmd } = await import('@agent-device/host-kit/command');
      return await runCmd(executable, args, options);
    },
    isFileExecutable: async (path) => {
      const { isExecutablePath } = await import('@agent-device/host-kit/command');
      return await isExecutablePath(path);
    },
    isExecutableOnPath: async (executable) => {
      const { whichCmd } = await import('@agent-device/host-kit/command');
      return await whichCmd(executable, host.env);
    },
    processes: createPlatformPluginProcessPort(host),
    startBackgroundCommand: async (request, signal) => {
      processes ??= await loadManagedAppLogProcesses(sessionsDir, host.env);
      return await processes.start(
        {
          command: { kind: 'host', request: request.command },
          output: request.output,
          ...(request.markerPath === undefined ? {} : { markerPath: request.markerPath }),
        },
        signal,
      );
    },
    launchDetached: async (executable, args, options) => {
      // The host owns the detached spawn: a plugin that starts a process outliving its request must
      // not carry its own copy of the exec substrate, which would spawn outside the request's
      // captured environment and exec trace.
      const { runCmdDetachedMonitored } = await import('@agent-device/host-kit/command');
      return runCmdDetachedMonitored(executable, args, { env: options.env });
    },
  } satisfies PlatformHost);
}

/**
 * The host's process answers, served by the core's own copy of the host kit.
 *
 * A managed plugin is bundled with its own copy of that kit, and the request's command-host and
 * diagnostic scopes never enter the bundled copy, so a process tool spawned from there runs with the
 * daemon process environment and traces into the plugin's own store. Answering here puts every
 * process read in the scope the request was opened with, which is where `--debug` shows it.
 */
function createPlatformPluginProcessPort(host: HostEnvironment): PlatformHost['processes'] {
  return Object.freeze({
    // The only read that does not leave the command-executor scope on its own: what a host says
    // about its processes is a host read, never a toolchain command one request carries an override
    // for (an adb executor, say). The reads below drop that scope themselves.
    list: async (options) => {
      const [{ listHostProcesses }, { withoutCommandExecutorOverride }] = await Promise.all([
        import('@agent-device/host-kit/process'),
        import('@agent-device/host-kit/command'),
      ]);
      return await withoutCommandExecutorOverride(async () => await listHostProcesses(options));
    },
    readIdentities: async (pids, options) => {
      const { readProcessIdentities } = await import('@agent-device/host-kit/process');
      return await readProcessIdentities(pids, options?.timeoutMs);
    },
    readIdentityObservations: async (pids) => {
      const { readHostProcessIdentityObservationsAsync } =
        await import('@agent-device/host-kit/process');
      return await readHostProcessIdentityObservationsAsync(pids);
    },
    readExecutablePaths: async (pids) => {
      const { readProcessExecutablePaths } = await import('@agent-device/host-kit/process');
      return await readProcessExecutablePaths(pids, host);
    },
    reapOwnedRecords: async (store, options) => {
      const { reapOwnedProcessRecordsAtStartup } = await import('@agent-device/host-kit/process');
      return await reapOwnedProcessRecordsAtStartup(store, options);
    },
  });
}

async function loadManagedAppLogProcesses(sessionsDir: string, env: HostEnvironment['env']) {
  const { createManagedAppLogProcesses } = await import('../platform-runtime-app-log-process.ts');
  return createManagedAppLogProcesses(sessionsDir, env);
}
