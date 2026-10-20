export { daemonStartupExitCode, startDaemonRuntime } from './server/http/daemon-runtime.ts';
export { reportDaemonClose } from './server/http/server-shutdown.ts';
export type {
  ComposeDaemonRuntimeDeps,
  DaemonRuntimeController,
  DaemonRuntimeDeps,
} from './server/http/daemon-runtime.ts';
export type { ShutdownReport } from './server/http/server-shutdown.ts';
export type { DaemonInvokeFn, DaemonRequest } from './core/daemon-request.ts';
export type { DaemonPlatformServices } from './core/platform-services.ts';
export type { PlatformOwnerLifecycle } from './core/platform-owner-lifecycle.ts';
export type { PlatformResourceCleanup } from './core/platform-resource-cleanup.ts';
