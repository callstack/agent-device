import type { ManagedWebBackend } from '@agent-device/contracts/managed-web-backend';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { PlatformSetup } from '@agent-device/plugins/contract';

export function createManagedWebBackend(host: HostEnvironment): ManagedWebBackend {
  return Object.freeze({
    setup: (options) =>
      withWebPlatform(host, options.stateDir, (web) => web.operations.setup(options)),
    doctor: (options) =>
      withWebPlatform(host, options.stateDir, (web) => web.operations.doctor(options)),
  });
}

async function withWebPlatform<T>(
  host: HostEnvironment,
  stateDir: string | undefined,
  run: (web: PlatformSetup<'web'>) => Promise<T>,
): Promise<T> {
  const { startInstalledPlatforms } = await import('./platform-runtime/installed-platforms.ts');
  const installed = await startInstalledPlatforms(host, stateDir, 'web');
  try {
    return await run(installed.platforms.web.get());
  } finally {
    await installed.close();
  }
}
