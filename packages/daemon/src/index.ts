export { startDaemonRuntime } from './server/http/daemon-runtime.ts';
export type {
  ComposeDaemonRuntimeDeps,
  DaemonRuntimeController,
  DaemonRuntimeDeps,
  DaemonRuntimeDepsInput,
} from './server/http/daemon-runtime.ts';
export type { DaemonInvokeFn, DaemonRequest } from './core/daemon-request.ts';
export type { DaemonPlatformServices } from './core/platform-services.ts';
export type { PlatformOwnerLifecycle } from './core/platform-owner-lifecycle.ts';
export type { PlatformResourceCleanup } from './core/platform-resource-cleanup.ts';
