import type { CommandFlags } from '../core/dispatch.ts';
import type { CloudArtifactProvider } from '../cloud-artifacts.ts';
import type { AndroidAdbExecutor } from '../platforms/android/adb-executor.ts';
import { AppError } from '../kernel/errors.ts';
import { getDaemonCommandRoute } from './daemon-command-registry.ts';
import * as genericRequestHandlerModule from './request-generic-dispatch.ts';
import type { DaemonCommandContext } from './context.ts';
import type { LeaseLifecycleProvider } from './handlers/lease.ts';
import type { LeaseRegistry } from './lease-registry.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from './types.ts';

type RequestHandlerChainParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  providerRuntimeIds?: readonly string[];
  providerRuntimeRequiredIds?: readonly string[];
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  cloudArtifactProvider?: CloudArtifactProvider;
  invoke: DaemonInvokeFn;
  invokeReplayAction?: DaemonInvokeFn;
  androidAdbExecutor?: AndroidAdbExecutor;
  contextFromFlags: (
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ) => DaemonCommandContext;
};

const DAEMON_ROUTE_HANDLERS = {
  lease: defineDaemonRoute({
    load: () => import('./handlers/lease.ts'),
    run: runLeaseHandler,
  }),
  session: defineDaemonRoute({
    load: () => import('./handlers/session.ts'),
    run: runSessionHandler,
  }),
  snapshot: defineDaemonRoute({
    load: () => import('./handlers/snapshot.ts'),
    run: runSnapshotHandler,
  }),
  reactNative: defineDaemonRoute({
    load: () => import('./handlers/react-native.ts'),
    run: runReactNativeHandler,
  }),
  recordTrace: defineDaemonRoute({
    load: () => import('./handlers/record-trace.ts'),
    run: runRecordTraceHandler,
  }),
  find: defineDaemonRoute({
    load: () => import('./handlers/find.ts'),
    run: runFindHandler,
  }),
  interaction: defineDaemonRoute({
    load: () => import('./handlers/interaction.ts'),
    run: runInteractionHandler,
  }),
  generic: defineDaemonRoute({
    load: async () => genericRequestHandlerModule,
    run: async () => null,
  }),
} as const;

export type DaemonCommandRoute = keyof typeof DAEMON_ROUTE_HANDLERS;

export async function runRequestHandlerChain(
  params: RequestHandlerChainParams,
): Promise<DaemonResponse | null> {
  const route = getDaemonCommandRoute(params.req.command);
  return await DAEMON_ROUTE_HANDLERS[route].run(params);
}

export async function loadGenericRequestHandlerModule(): Promise<
  typeof import('./request-generic-dispatch.ts')
> {
  return await DAEMON_ROUTE_HANDLERS.generic.loadModule();
}

async function runLeaseHandler(
  { handleLeaseCommands }: typeof import('./handlers/lease.ts'),
  params: RequestHandlerChainParams,
): Promise<DaemonResponse> {
  return expectHandlerResponse(
    params.req.command,
    'lease',
    await handleLeaseCommands({
      req: params.req,
      sessionName: params.sessionName,
      sessionStore: params.sessionStore,
      leaseRegistry: params.leaseRegistry,
      providerRuntimeIds: params.providerRuntimeIds,
      providerRuntimeRequiredIds: params.providerRuntimeRequiredIds,
      leaseLifecycleProvider: params.leaseLifecycleProvider,
      cloudArtifactProvider: params.cloudArtifactProvider,
    }),
  );
}

async function runSessionHandler(
  { handleSessionCommands }: typeof import('./handlers/session.ts'),
  params: RequestHandlerChainParams,
): Promise<DaemonResponse> {
  return expectHandlerResponse(
    params.req.command,
    'session',
    await handleSessionCommands({
      req: params.req,
      sessionName: params.sessionName,
      logPath: params.logPath,
      sessionStore: params.sessionStore,
      leaseRegistry: params.leaseRegistry,
      leaseLifecycleProvider: params.leaseLifecycleProvider,
      invoke: params.invoke,
      invokeReplayAction: params.invokeReplayAction,
      androidAdbExecutor: params.androidAdbExecutor,
    }),
  );
}

async function runSnapshotHandler(
  { handleSnapshotCommands }: typeof import('./handlers/snapshot.ts'),
  params: RequestHandlerChainParams,
): Promise<DaemonResponse> {
  return expectHandlerResponse(
    params.req.command,
    'snapshot',
    await handleSnapshotCommands({
      req: params.req,
      sessionName: params.sessionName,
      logPath: params.logPath,
      sessionStore: params.sessionStore,
    }),
  );
}

async function runReactNativeHandler(
  { handleReactNativeCommands }: typeof import('./handlers/react-native.ts'),
  params: RequestHandlerChainParams,
): Promise<DaemonResponse> {
  return expectHandlerResponse(
    params.req.command,
    'react-native',
    await handleReactNativeCommands({
      req: params.req,
      sessionName: params.sessionName,
      logPath: params.logPath,
      sessionStore: params.sessionStore,
      contextFromFlags: params.contextFromFlags,
    }),
  );
}

async function runRecordTraceHandler(
  { handleRecordTraceCommands }: typeof import('./handlers/record-trace.ts'),
  params: RequestHandlerChainParams,
): Promise<DaemonResponse> {
  return expectHandlerResponse(
    params.req.command,
    'record-trace',
    await handleRecordTraceCommands({
      req: params.req,
      sessionName: params.sessionName,
      sessionStore: params.sessionStore,
      logPath: params.logPath,
    }),
  );
}

async function runFindHandler(
  { handleFindCommands }: typeof import('./handlers/find.ts'),
  params: RequestHandlerChainParams,
): Promise<DaemonResponse> {
  return expectHandlerResponse(
    params.req.command,
    'find',
    await handleFindCommands({
      req: params.req,
      sessionName: params.sessionName,
      logPath: params.logPath,
      sessionStore: params.sessionStore,
      invoke: params.invoke,
    }),
  );
}

async function runInteractionHandler(
  { handleInteractionCommands }: typeof import('./handlers/interaction.ts'),
  params: RequestHandlerChainParams,
): Promise<DaemonResponse> {
  return expectHandlerResponse(
    params.req.command,
    'interaction',
    await handleInteractionCommands({
      req: params.req,
      sessionName: params.sessionName,
      logPath: params.logPath,
      sessionStore: params.sessionStore,
      contextFromFlags: params.contextFromFlags,
    }),
  );
}

function defineDaemonRoute<TModule>(definition: {
  load: () => Promise<TModule>;
  run: (module: TModule, params: RequestHandlerChainParams) => Promise<DaemonResponse | null>;
}) {
  const loadModule = lazyImport(definition.load);
  return {
    loadModule,
    run: async (params: RequestHandlerChainParams) =>
      await definition.run(await loadModule(), params),
  };
}

function lazyImport<T>(load: () => Promise<T>): () => Promise<T> {
  let modulePromise: Promise<T> | undefined;
  return () => {
    modulePromise ??= load();
    return modulePromise;
  };
}

function expectHandlerResponse(
  command: string,
  handlerFamily: string,
  response: DaemonResponse | null,
): DaemonResponse {
  if (response) return response;
  throw new AppError(
    'UNKNOWN',
    `Daemon handler routing mismatch: ${handlerFamily} handler matched command "${command}" but returned no response.`,
    { hint: 'This is a daemon-internal routing bug in agent-device — please report it.' },
  );
}
