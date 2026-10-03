import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';

// fallow-ignore-next-line code-duplication
type DeferredFunction = (...args: never[]) => unknown;
type Deferred<Fn extends DeferredFunction> = (
  ...args: Parameters<Fn>
) => Promise<Awaited<ReturnType<Fn>>>;

function deferred<Fn extends DeferredFunction>(load: () => Promise<Fn>): Deferred<Fn> {
  return (async (...args: Parameters<Fn>) =>
    await (
      await load()
    )(...args)) as unknown as Deferred<Fn>;
}

const metadata = Object.freeze({
  family: 'web',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createWebPlatformRuntime } = await import('./runtime.ts');
    return createWebPlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule: InventoryPlatformModule<'web'> = Object.freeze({
  ...metadata,
  loadInventory: async () => {
    const { createWebInventory } = await import('./inventory.ts');
    return createWebInventory();
  },
});

export const AGENT_BROWSER_TIMEOUT_MS = 30_000;

export type { WebProvider } from './provider.ts';
export type { AgentBrowserProcessSummary } from './agent-browser-process-record.ts';
export type { AgentBrowserToolStatus } from './agent-browser-tool.ts';

export const createAgentBrowserWebProvider = deferred<
  (typeof import('./agent-browser-provider.ts'))['createAgentBrowserWebProvider']
>(async () => (await import('./agent-browser-provider.ts')).createAgentBrowserWebProvider);
export const getManagedAgentBrowserStatus = deferred<
  (typeof import('./agent-browser-tool.ts'))['getManagedAgentBrowserStatus']
>(async () => (await import('./agent-browser-tool.ts')).getManagedAgentBrowserStatus);
export const setupManagedAgentBrowser = deferred<
  (typeof import('./agent-browser-tool.ts'))['setupManagedAgentBrowser']
>(async () => (await import('./agent-browser-tool.ts')).setupManagedAgentBrowser);
export const doctorManagedAgentBrowser = deferred<
  (typeof import('./agent-browser-tool.ts'))['doctorManagedAgentBrowser']
>(async () => (await import('./agent-browser-tool.ts')).doctorManagedAgentBrowser);
export const inspectManagedAgentBrowserProcesses = deferred<
  (typeof import('./agent-browser-process-record.ts'))['inspectManagedAgentBrowserProcesses']
>(
  async () =>
    (await import('./agent-browser-process-record.ts')).inspectManagedAgentBrowserProcesses,
);
export const summarizeAgentBrowserProcesses = deferred<
  (typeof import('./agent-browser-process-record.ts'))['summarizeAgentBrowserProcesses']
>(async () => (await import('./agent-browser-process-record.ts')).summarizeAgentBrowserProcesses);
export const cleanupManagedAgentBrowserOrphans = deferred<
  (typeof import('./agent-browser-lifecycle.ts'))['cleanupManagedAgentBrowserOrphans']
>(async () => (await import('./agent-browser-lifecycle.ts')).cleanupManagedAgentBrowserOrphans);
export const webBrowserLifecycleCheck = deferred<
  (typeof import('./doctor.ts'))['webBrowserLifecycleCheck']
>(async () => (await import('./doctor.ts')).webBrowserLifecycleCheck);

export const resolveWebProvider = deferred<(typeof import('./provider.ts'))['resolveWebProvider']>(
  async () => (await import('./provider.ts')).resolveWebProvider,
);
export const hasScopedWebProvider = deferred<
  (typeof import('./provider.ts'))['hasScopedWebProvider']
>(async () => (await import('./provider.ts')).hasScopedWebProvider);

export async function withWebProvider<T>(
  provider: import('./provider.ts').WebProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const { withWebProvider: implementation } = await import('./provider.ts');
  return await implementation(provider, fn);
}
