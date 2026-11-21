import type { PlatformContribution, PlatformHost, PlatformSetup } from 'agent-device/plugins';
import type { WebToolbox } from './toolbox.ts';
import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';

const metadata = Object.freeze({
  family: 'web',
} satisfies PlatformModuleMetadata);

/**
 * The toolbox module, resolved exactly once per process. The façade must stay metadata-eager
 * (ADR-0019), so the module that binds a host's command port enters with the first operation that
 * needs it rather than above it. Only the module is memoized: each `setup` call binds its own host.
 */
let toolboxModule: Promise<typeof import('./toolbox.ts')> | undefined;

/**
 * A bound toolbox, made on first use and then reused: a `setup` that never runs a command imports
 * and builds nothing, and the operations of one setup share the one toolbox it binds its host to.
 */
function webToolbox(host: PlatformHost) {
  let toolbox: Promise<WebToolbox> | undefined;
  return async () =>
    (toolbox ??= (toolboxModule ??= import('./toolbox.ts')).then(({ createWebToolbox }) =>
      createWebToolbox(host),
    ));
}

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
        // Importing this package evaluates nothing but itself, and the host is bound to a toolbox
        // only when an operation first needs one. Every operation below asks the same lazy
        // resolution, so one setup builds exactly one toolbox for the whole family.
        setup(host: PlatformHost): PlatformSetup<'web'> {
          const { stateDir } = host;
          const toolbox = webToolbox(host);
          return {
            family: 'web',
            inventoryModule,
            runtimeModule,
            createInteractor: async () => {
              const [{ createWebInteractor }, bound] = await Promise.all([
                import('./interactor.ts'),
                toolbox(),
              ]);
              return await createWebInteractor(bound, undefined, stateDir);
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
                  toolbox: await toolbox(),
                });
              },
              doctor: async (options) => {
                const { doctorManagedAgentBrowser } = await import('./agent-browser-tool.ts');
                return await doctorManagedAgentBrowser({
                  stateDir: options.stateDir ?? stateDir,
                  toolbox: await toolbox(),
                });
              },
              browserLifecycleCheck: async (dir) => {
                const [{ webBrowserLifecycleCheck }, bound] = await Promise.all([
                  import('./doctor.ts'),
                  toolbox(),
                ]);
                return await webBrowserLifecycleCheck(dir, bound);
              },
              cleanupOrphans: async (openSessions) => {
                const [{ getManagedAgentBrowserStatus }, bound] = await Promise.all([
                  import('./agent-browser-tool.ts'),
                  toolbox(),
                ]);
                const status = getManagedAgentBrowserStatus({ stateDir, host: bound.host });
                if (!status.installed) return;
                const { cleanupManagedAgentBrowserOrphans } =
                  await import('./agent-browser-lifecycle.ts');
                await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
                  env: bound.host.env,
                  emitDiagnostic: bound.host.emitDiagnostic,
                  processes: bound.host.processes,
                  openWebSessionNames: openSessions,
                  ownedProcessRecords: bound.host.ownedProcessRecords,
                });
              },
              createProvider: async (session) => {
                const { createAgentBrowserWebProvider } =
                  await import('./agent-browser-provider.ts');
                const bound = await toolbox();
                return await createAgentBrowserWebProvider({
                  toolbox: bound,
                  stateDir,
                  session,
                  openWebSessionNames: bound.host.openWebSessionNames,
                  ownedProcessRecords: bound.host.ownedProcessRecords,
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
