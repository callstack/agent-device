import type { CommandFlags } from '../core/dispatch.ts';
import type { AndroidAdbExecutor } from '../platforms/android/adb-executor.ts';
import { AppError } from '../utils/errors.ts';
import { getDaemonCommandRoute } from './daemon-command-registry.ts';
import type { DaemonCommandContext } from './context.ts';
import type { LeaseLifecycleProvider } from './handlers/lease.ts';
import type { LeaseRegistry } from './lease-registry.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from './types.ts';

const loadLeaseHandlerModule = lazyImport(() => import('./handlers/lease.ts'));
const loadSessionHandlerModule = lazyImport(() => import('./handlers/session.ts'));
const loadSnapshotHandlerModule = lazyImport(() => import('./handlers/snapshot.ts'));
const loadReactNativeHandlerModule = lazyImport(() => import('./handlers/react-native.ts'));
const loadRecordTraceHandlerModule = lazyImport(() => import('./handlers/record-trace.ts'));
const loadFindHandlerModule = lazyImport(() => import('./handlers/find.ts'));
const loadInteractionHandlerModule = lazyImport(() => import('./handlers/interaction.ts'));

type RequestHandlerChainParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  invoke: DaemonInvokeFn;
  invokeReplayAction?: DaemonInvokeFn;
  androidAdbExecutor?: AndroidAdbExecutor;
  contextFromFlags: (
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ) => DaemonCommandContext;
};

export async function runRequestHandlerChain(
  params: RequestHandlerChainParams,
): Promise<DaemonResponse | null> {
  switch (getDaemonCommandRoute(params.req.command)) {
    case 'lease':
      return await runLeaseHandler(params);
    case 'session':
      return await runSessionHandler(params);
    case 'snapshot':
      return await runSnapshotHandler(params);
    case 'reactNative':
      return await runReactNativeHandler(params);
    case 'recordTrace':
      return await runRecordTraceHandler(params);
    case 'find':
      return await runFindHandler(params);
    case 'interaction':
      return await runInteractionHandler(params);
    case 'generic':
      return null;
  }
}

async function runLeaseHandler(params: RequestHandlerChainParams): Promise<DaemonResponse> {
  const { handleLeaseCommands } = await loadLeaseHandlerModule();
  return expectHandlerResponse(
    params.req.command,
    'lease',
    await handleLeaseCommands({
      req: params.req,
      leaseRegistry: params.leaseRegistry,
      leaseLifecycleProvider: params.leaseLifecycleProvider,
    }),
  );
}

async function runSessionHandler(params: RequestHandlerChainParams): Promise<DaemonResponse> {
  const { handleSessionCommands } = await loadSessionHandlerModule();
  return expectHandlerResponse(
    params.req.command,
    'session',
    await handleSessionCommands({
      req: params.req,
      sessionName: params.sessionName,
      logPath: params.logPath,
      sessionStore: params.sessionStore,
      leaseRegistry: params.leaseRegistry,
      invoke: params.invoke,
      invokeReplayAction: params.invokeReplayAction,
      androidAdbExecutor: params.androidAdbExecutor,
    }),
  );
}

async function runSnapshotHandler(params: RequestHandlerChainParams): Promise<DaemonResponse> {
  const { handleSnapshotCommands } = await loadSnapshotHandlerModule();
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

async function runReactNativeHandler(params: RequestHandlerChainParams): Promise<DaemonResponse> {
  const { handleReactNativeCommands } = await loadReactNativeHandlerModule();
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

async function runRecordTraceHandler(params: RequestHandlerChainParams): Promise<DaemonResponse> {
  const { handleRecordTraceCommands } = await loadRecordTraceHandlerModule();
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

async function runFindHandler(params: RequestHandlerChainParams): Promise<DaemonResponse> {
  const { handleFindCommands } = await loadFindHandlerModule();
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

async function runInteractionHandler(params: RequestHandlerChainParams): Promise<DaemonResponse> {
  const { handleInteractionCommands } = await loadInteractionHandlerModule();
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
    'INTERNAL_ERROR',
    `Daemon handler routing mismatch: ${handlerFamily} handler matched command "${command}" but returned no response.`,
  );
}
