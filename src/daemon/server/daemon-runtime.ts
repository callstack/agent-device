import crypto from 'node:crypto';
import { asAppError, AppError } from '../../kernel/errors.ts';
import { SessionStore } from '../session-store.ts';
import { cleanupStaleAppLogProcesses } from '../app-log-process.ts';
import { resolveDaemonPaths, resolveDaemonServerMode } from '../config.ts';
import { createDaemonHttpServer } from './http-server.ts';
import { trackDownloadableArtifact } from '../artifact-tracking.ts';
import { createDefaultCloudArtifactProvider } from '../../default-cloud-artifact-provider.ts';
import { createDefaultCloudWebDriverProviderRuntimes } from '../../cloud-webdriver/provider-runtimes.ts';
import {
  composeCloudArtifactProviders,
  createProviderDeviceRuntimeRequestProviders,
} from '../../provider-device-runtime.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestHandler } from '../request-router.ts';
import { teardownSessionResources } from '../session-teardown.ts';
import { closeDaemonServers } from './server-shutdown.ts';
import type { SessionState } from '../types.ts';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '../../utils/diagnostics.ts';
import { isEnvTruthy } from '../../utils/retry.ts';
import {
  acquireDaemonLock,
  parseIntegerEnv,
  readProcessStartTime,
  readVersion,
  releaseDaemonLock,
  removeInfo,
  resolveDaemonCodeSignature,
  writeInfo,
} from './server-lifecycle.ts';
import {
  createSocketServer,
  listenHttpServer,
  listenNetServer,
  type DaemonServer,
} from './transport.ts';
import { prewarmPngWorker, terminatePngWorker } from '../../utils/png-worker-client.ts';
import { sleep } from '../../utils/timeouts.ts';
import { setRunnerLeaseOwnerStateDir } from '../../platforms/apple/core/runner/runner-lease.ts';
import { cleanupManagedAgentBrowserOrphans } from '../../platforms/web/agent-browser-lifecycle.ts';
import { getManagedAgentBrowserStatus } from '../../platforms/web/agent-browser-tool.ts';
import { openWebSessionNames } from '../web-session-names.ts';

const DAEMON_SESSION_TEARDOWN_TIMEOUT_MS = 5_000;
const DAEMON_PNG_WORKER_TERMINATE_TIMEOUT_MS = 1_000;

type WritableOutput = {
  write: (chunk: string) => unknown;
};

export type DaemonRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  stdout?: WritableOutput;
  stderr?: WritableOutput;
  exit?: (code: number) => void;
  registerProcessHandlers?: boolean;
};

export type DaemonRuntimeController = {
  httpPort?: number;
  socketPort?: number;
  shutdown: (options?: { exitCode?: number; cause?: unknown }) => Promise<void>;
  token: string;
};

export async function startDaemonRuntime(
  options: DaemonRuntimeOptions = {},
): Promise<DaemonRuntimeController | null> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const daemonPaths = resolveDaemonPaths(env.AGENT_DEVICE_STATE_DIR);
  const { baseDir, infoPath, lockPath, logPath, sessionsDir } = daemonPaths;
  const daemonServerMode = resolveDaemonServerMode(env.AGENT_DEVICE_DAEMON_SERVER_MODE);
  const retainArtifacts = isEnvTruthy(env.AGENT_DEVICE_RETAIN_ARTIFACTS);
  setRunnerLeaseOwnerStateDir(baseDir);

  cleanupStaleAppLogProcesses(sessionsDir);

  const sessionStore = new SessionStore(sessionsDir);
  const leaseRegistry = new LeaseRegistry({
    maxActiveSimulatorLeases: parseIntegerEnv(env.AGENT_DEVICE_MAX_SIMULATOR_LEASES),
    defaultLeaseTtlMs: parseIntegerEnv(env.AGENT_DEVICE_LEASE_TTL_MS),
    minLeaseTtlMs: parseIntegerEnv(env.AGENT_DEVICE_LEASE_MIN_TTL_MS),
    maxLeaseTtlMs: parseIntegerEnv(env.AGENT_DEVICE_LEASE_MAX_TTL_MS),
  });
  const version = readVersion();
  const token = crypto.randomBytes(24).toString('hex');
  const daemonProcessStartTime = readProcessStartTime(process.pid) ?? undefined;
  const daemonCodeSignature = resolveDaemonCodeSignature();
  const providerDeviceRuntimes = createDefaultCloudWebDriverProviderRuntimes(env);
  const providerRuntimeProviders =
    createProviderDeviceRuntimeRequestProviders(providerDeviceRuntimes);
  const cloudArtifactProvider = composeCloudArtifactProviders(
    providerRuntimeProviders.cloudArtifactProvider,
    createDefaultCloudArtifactProvider(env),
  );

  const handleRequest = createRequestHandler({
    logPath,
    stateDir: baseDir,
    token,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider: providerRuntimeProviders.leaseLifecycleProvider,
    cloudArtifactProvider,
    deviceInventoryProvider: providerRuntimeProviders.deviceInventoryProvider,
    providerDeviceRuntimeScope: providerRuntimeProviders.providerDeviceRuntimeScope,
    trackDownloadableArtifact,
  });

  const emitFatalDiagnostic = async (error: unknown): Promise<void> => {
    await withDiagnosticsScope(
      { command: 'daemon', session: 'daemon', logPath, debug: true },
      async () => {
        emitDiagnostic({
          level: 'error',
          phase: 'daemon_fatal',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        flushDiagnosticsToSessionFile({ force: true });
      },
    );
  };

  const teardownDaemonSession = async (session: SessionState): Promise<void> => {
    const teardown = teardownSessionResources(session, session.name).catch((error) => {
      stderr.write(
        `Daemon session teardown error (${session.name}): ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    });
    await Promise.race([
      teardown,
      sleep(DAEMON_SESSION_TEARDOWN_TIMEOUT_MS).then(() => {
        stderr.write(`Daemon session teardown timed out (${session.name}).\n`);
      }),
    ]);
    sessionStore.writeSessionLog(session);
    sessionStore.delete(session.name);
  };

  const teardownDaemonSessions = async (): Promise<void> => {
    const sessionsToStop = sessionStore.toArray();
    await Promise.all(sessionsToStop.map(teardownDaemonSession));
  };

  const openDaemonServers = async (): Promise<{
    servers: DaemonServer[];
    socketPort?: number;
    httpPort?: number;
  }> => {
    const servers: DaemonServer[] = [];
    let socketPort: number | undefined;
    let httpPort: number | undefined;
    const startSocketServer = daemonServerMode !== 'http';
    const startHttpServer = daemonServerMode !== 'socket';
    if (startSocketServer) {
      const socketServer = createSocketServer(handleRequest);
      servers.push(socketServer);
      socketPort = await listenNetServer(socketServer);
    }

    if (startHttpServer) {
      const httpServer = await createDaemonHttpServer({
        handleRequest,
        token,
        retainArtifacts,
      });
      servers.push(httpServer);
      httpPort = await listenHttpServer(httpServer);
    }
    return { servers, socketPort, httpPort };
  };

  const publishDaemonInfo = (socketPort: number | undefined, httpPort: number | undefined) => {
    writeInfo(baseDir, infoPath, logPath, {
      socketPort,
      httpPort,
      token,
      version,
      codeSignature: daemonCodeSignature,
      processStartTime: daemonProcessStartTime,
    });
    if (socketPort) stdout.write(`AGENT_DEVICE_DAEMON_PORT=${socketPort}\n`);
    if (httpPort) stdout.write(`AGENT_DEVICE_DAEMON_HTTP_PORT=${httpPort}\n`);
  };

  const closeServersBestEffort = (servers: DaemonServer[]): void => {
    for (const server of servers) {
      try {
        server.close(() => {});
      } catch {}
    }
  };

  const lockData = {
    pid: process.pid,
    version,
    startedAt: Date.now(),
    processStartTime: daemonProcessStartTime,
  };
  if (!acquireDaemonLock(baseDir, lockPath, lockData)) {
    stderr.write('Daemon lock is held by another process; exiting.\n');
    setRunnerLeaseOwnerStateDir(undefined);
    exit(0);
    return null;
  }

  let servers: DaemonServer[] = [];
  let socketPort: number | undefined;
  let httpPort: number | undefined;
  try {
    await cleanupWebBrowserOrphansForDaemonStartup({ stateDir: baseDir, sessionStore });
    const opened = await openDaemonServers();
    servers = opened.servers;
    socketPort = opened.socketPort;
    httpPort = opened.httpPort;
    publishDaemonInfo(socketPort, httpPort);
  } catch (error) {
    const appErr = asAppError(error);
    stderr.write(`Daemon error: ${appErr.message}\n`);
    closeServersBestEffort(servers);
    removeInfo(infoPath);
    releaseDaemonLock(lockPath);
    setRunnerLeaseOwnerStateDir(undefined);
    exit(1);
    return null;
  }

  // Spawn the PNG worker ahead of the first screenshot request so its
  // cold-start cost is not paid on a user-visible call. Best effort: when it
  // cannot start, PNG processing falls back to the in-process sync path.
  prewarmPngWorker();

  let shuttingDown = false;
  const shutdown = async (shutdownOptions: { exitCode?: number; cause?: unknown } = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (shutdownOptions.cause) {
      await emitFatalDiagnostic(shutdownOptions.cause);
    }
    await closeDaemonServers(servers);
    // Hand healthy simulator runners off to the next daemon before session
    // teardown gets a chance to kill them; everything left after this
    // (real devices, unhealthy runners) goes through the normal stop path.
    const { detachIosSimulatorRunnerSessionsForShutdown, stopAllIosRunnerSessions } =
      await import('../../platforms/apple/core/runner/runner-client.ts');
    try {
      await detachIosSimulatorRunnerSessionsForShutdown();
    } catch {}
    await teardownDaemonSessions();
    await Promise.allSettled(
      providerDeviceRuntimes.map(async (runtime) => await runtime.shutdown()),
    );
    await stopAllIosRunnerSessions();
    // Best effort: stop the PNG worker so an in-flight job cannot delay exit.
    await Promise.race([
      terminatePngWorker().catch(() => {}),
      sleep(DAEMON_PNG_WORKER_TERMINATE_TIMEOUT_MS),
    ]);
    removeInfo(infoPath);
    releaseDaemonLock(lockPath);
    setRunnerLeaseOwnerStateDir(undefined);
    exit(shutdownOptions.exitCode ?? 0);
  };

  if (options.registerProcessHandlers !== false) {
    process.on('SIGINT', () => {
      void shutdown();
    });
    process.on('SIGTERM', () => {
      void shutdown();
    });
    process.on('SIGHUP', () => {
      void shutdown();
    });
    process.on('uncaughtException', (err) => {
      const appErr = err instanceof AppError ? err : asAppError(err);
      stderr.write(`Daemon error: ${appErr.message}\n`);
      void shutdown({ exitCode: 1, cause: err });
    });
    process.on('unhandledRejection', (reason) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      const appErr = err instanceof AppError ? err : asAppError(err);
      stderr.write(`Daemon error: ${appErr.message}\n`);
      void shutdown({ exitCode: 1, cause: err });
    });
  }

  return {
    httpPort,
    shutdown,
    socketPort,
    token,
  };
}

export async function cleanupWebBrowserOrphansForDaemonStartup(params: {
  stateDir: string;
  sessionStore: SessionStore;
}): Promise<void> {
  const status = getManagedAgentBrowserStatus({ stateDir: params.stateDir });
  if (!status.installed) return;
  try {
    await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
      openWebSessionNames: openWebSessionNames(params.sessionStore),
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'web_agent_browser_orphan_cleanup_failed',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}
