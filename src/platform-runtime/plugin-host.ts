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
  } satisfies PlatformHost);
}
