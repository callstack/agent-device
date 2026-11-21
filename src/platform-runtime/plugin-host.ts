import type { PlatformHost } from '@agent-device/plugins/contract';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { hostTemporaryDirectory } from '@agent-device/host-kit/host-file';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import {
  expandProcessTree,
  hostNodeExecutablePath,
  hostNodeVersion,
  hostPlatform,
  hostProcessId,
  isProcessAlive,
  processStartTimesDiffer,
} from '@agent-device/host-kit/process';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

/**
 * The host a platform plugin's `setup` receives. Alongside the one-shot command port and the
 * executable probe, it answers a request to keep one of the plugin's commands running — a streamed
 * device log — through the same managed app-log process service the core's own runtime host uses, so
 * a plugin never spawns a process of its own and its stream gets the same ownership marker, stop, and
 * cleanup. The command's own `env` is what the plugin prepared, so a family that resolves its tool
 * chain from roots the core does not name streams with the same `PATH` it runs one-shot commands with.
 *
 * Every machine and process fact the host answers comes from the core's own copy of the host kit, so
 * a plugin that derives an install layout, a launch argv or a fleet verdict from them describes the
 * process that runs its commands rather than its own bundle.
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
    ...createPlatformPluginMachineFacts(),
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
 * The machine the host runs on, read once. A plugin derives its install layout, its launch argv and
 * its runtime home from these, so they answer for the process that runs the plugin's commands rather
 * than for the plugin's own bundle: the environment, toolchain and temporary directory that process
 * sees are the ones its commands have to work under.
 */
function createPlatformPluginMachineFacts(): Pick<
  PlatformHost,
  'hostOs' | 'nodeExecutablePath' | 'nodeVersion' | 'temporaryDirectory' | 'processId'
> {
  const platform = hostPlatform();
  return {
    hostOs:
      platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'other',
    nodeExecutablePath: hostNodeExecutablePath(),
    nodeVersion: hostNodeVersion(),
    temporaryDirectory: hostTemporaryDirectory(),
    processId: hostProcessId(),
  };
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
    readExecutablePaths: async (pids) => {
      const { readProcessExecutablePaths } = await import('@agent-device/host-kit/process');
      return await readProcessExecutablePaths(pids, host);
    },
    // The two answers a plugin cannot derive from rows it was given: the parentage relation and the
    // start-time formats are the host's, and judging them from the bundle would read them with a
    // process tool of a machine the plugin does not run its commands on.
    expandTree: (rootPids, processes) =>
      expandProcessTree([...rootPids], [...processes]).map((processInfo) => ({ ...processInfo })),
    judgeRecordedLiveness: async (records) => {
      const rows = [...records];
      if (rows.length === 0) return [];
      const { readHostProcessIdentityObservationsAsync } =
        await import('@agent-device/host-kit/process');
      const observations = await readHostProcessIdentityObservationsAsync(
        rows.map((record) => record.pid),
      );
      return rows.map((record) => {
        const observation = observations.get(record.pid);
        // A pid the process table does not name is gone only when the signal probe agrees; a table
        // that answered nothing (a failed `ps`) leaves it unobserved.
        if (observation === undefined)
          return isProcessAlive(record.pid) ? 'unobserved' : 'not-alive';
        if (
          observation.state.startsWith('Z') ||
          processStartTimesDiffer(observation.startTime, record.startTime)
        )
          return 'not-alive';
        return observation.startTime === record.startTime ? 'alive' : 'unobserved';
      });
    },
    reapOwnedRecords: async (store, options) => {
      const { reapOwnedProcessRecordsAtStartup } = await import('@agent-device/host-kit/process');
      return await reapOwnedProcessRecordsAtStartup(store, options);
    },
    // The claim is this process's own, so the lock names this process's identity itself: a plugin
    // that brought its own copy would read that identity with its own process tool and trace the
    // wait into its own store, which is where a held install lock goes missing from `--debug`.
    // The async form is the one the request sees: it runs `ps` through the command host, which is
    // what traces the identity read, where the synchronous probe's `spawnSync` never appears.
    withLock: async (params) => {
      const { acquireProcessLock, withProcessLock } = await import('@agent-device/host-kit/file');
      const { readCurrentOwnerIdentityAsync } = await import('@agent-device/host-kit/process');
      return await withProcessLock({
        acquire: async () =>
          await acquireProcessLock({
            lockDirPath: params.lockDirPath,
            owner: { ...(await readCurrentOwnerIdentityAsync()), acquiredAtMs: Date.now() },
            timeoutMs: params.timeoutMs,
            ...(params.description === undefined ? {} : { description: params.description }),
          }),
        task: params.task,
      });
    },
  });
}

async function loadManagedAppLogProcesses(sessionsDir: string, env: HostEnvironment['env']) {
  const { createManagedAppLogProcesses } = await import('../platform-runtime-app-log-process.ts');
  return createManagedAppLogProcesses(sessionsDir, env);
}
