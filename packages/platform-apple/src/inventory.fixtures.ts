import type {
  DeviceInventoryHost,
  HostCommandRequest,
  HostCommandResult,
  PlatformRequestScope,
} from '@agent-device/contracts/platform';

export const inventoryScope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

export function commandResult(
  stdout = '',
  stderr = '',
  exitCode: number | null = 0,
): HostCommandResult {
  return { stdout, stderr, exitCode };
}

export function createInventoryHost(
  options: {
    run?: (request: HostCommandRequest, signal?: AbortSignal) => Promise<HostCommandResult>;
    which?: (executable: string) => Promise<string | undefined>;
    createTemporaryTextFile?: DeviceInventoryHost['files']['createTemporaryTextFile'];
    hostOs?: DeviceInventoryHost['hostOs'];
    observed?: string[];
  } = {},
): DeviceInventoryHost {
  return {
    commands: {
      which: options.which ?? (async (executable) => `/usr/bin/${executable}`),
      run:
        options.run ??
        (async (request) => {
          throw new Error(`Unexpected command: ${request.executable} ${request.args.join(' ')}`);
        }),
    },
    toolchains: { prepare: async () => undefined },
    files: {
      isExecutable: async () => false,
      createTemporaryTextFile:
        options.createTemporaryTextFile ??
        (async () => {
          throw new Error('Unexpected temporary file request');
        }),
    },
    hostOs: options.hostOs ?? 'darwin',
    hostName: 'Test Mac',
    homeDirectory: '/Users/test',
    observations: {
      deviceBooted: async (device) => {
        options.observed?.push(device.id);
      },
    },
  };
}
