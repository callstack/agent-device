import type { PlatformHost } from '@agent-device/plugins/contract';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';

export function createPlatformPluginHost(
  host: HostEnvironment,
  stateDir: string,
  resources?: Pick<PlatformHost, 'openWebSessionNames' | 'ownedProcessRecords'>,
): PlatformHost {
  return Object.freeze({
    ...host,
    stateDir,
    ...resources,
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
