import type {
  AppleToolHost,
  DeviceInventoryHostFor,
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
    run?: AppleToolHost['run'];
    which?: (executable: string) => Promise<string | undefined>;
    createTemporaryTextFile?: DeviceInventoryHostFor<'apple'>['files']['createTemporaryTextFile'];
    hostOs?: DeviceInventoryHostFor<'apple'>['hostOs'];
    observed?: string[];
  } = {},
): DeviceInventoryHostFor<'apple'> {
  return {
    appleTools: {
      isXcrunAvailable: async () =>
        Boolean(await (options.which ?? (async (executable) => `/usr/bin/${executable}`))('xcrun')),
      run:
        options.run ??
        (async (request) => {
          throw new Error(`Unexpected Apple tool: ${request.tool} ${request.args.join(' ')}`);
        }),
    },
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
    observations: {
      deviceBooted: async (device) => {
        options.observed?.push(device.id);
      },
    },
  };
}
