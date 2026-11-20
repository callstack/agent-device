import type { PlatformContribution, PlatformSetup } from 'agent-device/plugins';
import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';

const metadata = Object.freeze({
  family: 'web',
} satisfies PlatformModuleMetadata);

const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createWebPlatformRuntime } = await import('./runtime.ts');
    return createWebPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

const inventoryModule: InventoryPlatformModule<'web'> = Object.freeze({
  ...metadata,
  loadInventory: async () => {
    const { createWebInventory } = await import('./inventory.ts');
    return createWebInventory();
  },
});

function webPlatformPlugin() {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'platform',
        family: 'web',
        setup(host): PlatformSetup<'web'> {
          const { stateDir, openWebSessionNames, ownedProcessRecords } = host;
          return {
            family: 'web',
            inventoryModule,
            runtimeModule,
            createInteractor: async () => {
              const { createWebInteractor } = await import('./interactor.ts');
              return await createWebInteractor(host, undefined, stateDir);
            },
            withRequestProvider: async (provider, task) => {
              const { withWebProvider } = await import('./provider.ts');
              return await withWebProvider(provider, task);
            },
            operations: {
              setup: async (options) => {
                const { setupManagedAgentBrowser } = await import('./agent-browser-tool.ts');
                return await setupManagedAgentBrowser({
                  stateDir: options.stateDir ?? stateDir,
                  host,
                });
              },
              doctor: async (options) => {
                const { doctorManagedAgentBrowser } = await import('./agent-browser-tool.ts');
                return await doctorManagedAgentBrowser({
                  stateDir: options.stateDir ?? stateDir,
                  host,
                });
              },
              browserLifecycleCheck: async (dir) => {
                const { webBrowserLifecycleCheck } = await import('./doctor.ts');
                return await webBrowserLifecycleCheck(dir, host);
              },
              cleanupOrphans: async (openSessions) => {
                const { getManagedAgentBrowserStatus } = await import('./agent-browser-tool.ts');
                const status = getManagedAgentBrowserStatus({ stateDir, host });
                if (!status.installed) return;
                const { cleanupManagedAgentBrowserOrphans } =
                  await import('./agent-browser-lifecycle.ts');
                await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
                  env: host.env,
                  openWebSessionNames: openSessions,
                  ownedProcessRecords,
                  emitDiagnostic: host.emitDiagnostic,
                });
              },
              createProvider: async (session) => {
                const { createAgentBrowserWebProvider } =
                  await import('./agent-browser-provider.ts');
                return await createAgentBrowserWebProvider({
                  host,
                  stateDir,
                  session,
                  openWebSessionNames,
                  ownedProcessRecords,
                });
              },
              resolveRequestProvider: async () => {
                const { resolveRequestScopedWebProvider } = await import('./resolve-provider.ts');
                return await resolveRequestScopedWebProvider();
              },
            },
          };
        },
      },
    ],
  } satisfies { apiVersion: 3; contributes: [Extract<PlatformContribution, { family: 'web' }>] };
}

export { webPlatformPlugin as default };
