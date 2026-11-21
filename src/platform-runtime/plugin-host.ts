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
    launchDetached: async (executable, args, options) => {
      // The host owns the detached spawn: a plugin that starts a process outliving its request must
      // not carry its own copy of the exec substrate, which would spawn outside the request's
      // captured environment and exec trace.
      const { runCmdDetachedMonitored } = await import('@agent-device/host-kit/command');
      return runCmdDetachedMonitored(executable, args, { env: options.env });
    },
  } satisfies PlatformHost);
}
