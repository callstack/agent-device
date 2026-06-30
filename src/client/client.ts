import { sendToDaemon } from '../daemon/client/daemon-client.ts';
import { prepareMetroRuntime, reloadMetro } from '../metro/client-metro.ts';
import { resolveDaemonPaths } from '../daemon/config.ts';
import { symbolicateCrashArtifact } from '../platforms/apple/core/debug-symbols.ts';
import { INTERNAL_COMMANDS } from '../command-catalog.ts';
import {
  prepareDaemonCommandRequest,
  type DaemonCommandName,
} from '../commands/command-projection.ts';
import { buildRequestFlags } from '../commands/command-flags.ts';
import { throwDaemonError } from '../daemon-error.ts';
import {
  buildMeta,
  normalizeDeployResult,
  normalizeDevice,
  normalizeInstallFromSourceResult,
  normalizeMaterializationReleaseResult,
  normalizeOpenDevice,
  normalizeRuntimeHints,
  normalizeSession,
  normalizeStartupSample,
  normalizeTargetShutdownResult,
  readOptionalString,
  readRequiredString,
  readSnapshotNodes,
  resolveSessionName,
} from './client-normalizers.ts';
import { readScreenshotResultData } from '../utils/screenshot-result.ts';
import { isRecord } from '../utils/parsing.ts';
import type {
  AgentDeviceClient,
  AgentDeviceClientConfig,
  AgentDeviceDaemonTransport,
  AppCloseOptions,
  AppDeployOptions,
  AppInstallOptions,
  AppInstallFromSourceOptions,
  AppListOptions,
  AppOpenOptions,
  CaptureScreenshotOptions,
  CaptureScreenshotResult,
  CaptureSnapshotOptions,
  CaptureSnapshotResult,
  InternalRequestOptions,
  Lease,
  MaterializationReleaseOptions,
  MetroPrepareOptions,
} from './client-types.ts';
import type { CommandResult } from '../core/command-descriptor/command-result.ts';
import { isNonDefaultResponseLevel, type ResponseLevel } from '../kernel/contracts.ts';
import { readSerializedSnapshotCaptureAnnotations } from '../snapshot-capture-annotations.ts';
import { readSnapshotDiagnosticsSummary } from '../snapshot-diagnostics.ts';
import type { CommandFlags } from '../core/dispatch-context.ts';

export function createAgentDeviceClient(
  config: AgentDeviceClientConfig = {},
  deps: { transport?: AgentDeviceDaemonTransport } = {},
): AgentDeviceClient {
  const transport = deps.transport ?? sendToDaemon;

  // A non-default responseLevel (digest/full) makes the daemon return a leveled
  // shape; the per-command client normalizers assume the default shape, so the
  // capture methods pass the leveled payload through unnormalized instead.
  const isLeveledResponse = (options: { responseLevel?: ResponseLevel }): boolean =>
    isNonDefaultResponseLevel(options.responseLevel ?? config.responseLevel);

  const execute = async (
    command: string,
    positionals: string[] = [],
    options: InternalRequestOptions = {},
    metadataFlags?: Partial<CommandFlags>,
  ): Promise<Record<string, unknown>> => {
    const merged = mergeClientOptions(config, options);
    const response = await transport({
      session: resolveSessionName(merged.session),
      command,
      positionals,
      flags: buildRequestFlags(merged, metadataFlags),
      runtime: merged.runtime,
      meta: buildMeta(merged),
    });
    if (!response.ok) {
      throwDaemonError(response.error);
    }
    return (response.data ?? {}) as Record<string, unknown>;
  };

  const listSessions = async (options = {}) => {
    const data = await execute(INTERNAL_COMMANDS.sessionList, [], options);
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return sessions.map(normalizeSession);
  };

  const executeCommand = async <T>(
    command: DaemonCommandName,
    options: InternalRequestOptions = {},
  ): Promise<T> => {
    const request = prepareDaemonCommandRequest(command, options);
    return (await execute(
      request.command,
      request.positionals,
      request.options,
      request.metadataFlags,
    )) as T;
  };

  const resolveRequestSession = (options: InternalRequestOptions = {}) =>
    resolveSessionName(mergeClientOptions(config, options).session);

  return {
    command: {
      wait: async (options) => await executeCommand('wait', options),
      alert: async (options = {}) => await executeCommand('alert', options),
      appState: async (options = {}) =>
        await executeCommand<CommandResult<'appstate'>>('appstate', options),
      back: async (options = {}) => await executeCommand<CommandResult<'back'>>('back', options),
      home: async (options = {}) => await executeCommand<CommandResult<'home'>>('home', options),
      rotate: async (options) => await executeCommand<CommandResult<'rotate'>>('rotate', options),
      appSwitcher: async (options = {}) =>
        await executeCommand<CommandResult<'app-switcher'>>('app-switcher', options),
      keyboard: async (options = {}) =>
        await executeCommand<CommandResult<'keyboard'>>('keyboard', options),
      clipboard: async (options) =>
        await executeCommand<CommandResult<'clipboard'>>('clipboard', options),
      reactNative: async (options) => await executeCommand('react-native', options),
      prepare: async (options) => await executeCommand('prepare', options),
      viewport: async (options) =>
        await executeCommand<CommandResult<'viewport'>>('viewport', options),
    },
    devices: {
      list: async (options = {}) => {
        const data = await executeCommand<Record<string, unknown>>('devices', options);
        const devices = Array.isArray(data.devices) ? data.devices : [];
        return devices.map(normalizeDevice);
      },
      boot: async (options = {}) => await executeCommand<CommandResult<'boot'>>('boot', options),
      shutdown: async (options = {}) =>
        await executeCommand<CommandResult<'shutdown'>>('shutdown', options),
    },
    sessions: {
      list: async (options = {}) => await listSessions(options),
      // Pure local resolution; mirrors how the daemon client picks its state dir.
      stateDir: async (options = {}) => {
        const merged = mergeClientOptions(config, options);
        return resolveDaemonPaths(merged.stateDir ?? process.env.AGENT_DEVICE_STATE_DIR).baseDir;
      },
      close: async (options = {}) => {
        const session = resolveRequestSession(options);
        const data = await executeCommand<Record<string, unknown>>('close', options);
        return {
          session,
          shutdown: normalizeTargetShutdownResult(data.shutdown),
          identifiers: { session },
        };
      },
    },
    apps: {
      install: async (options: AppInstallOptions) =>
        normalizeDeployResult(
          await executeCommand('install', options),
          resolveRequestSession(options),
        ),
      reinstall: async (options: AppDeployOptions) =>
        normalizeDeployResult(
          await executeCommand('reinstall', options),
          resolveRequestSession(options),
        ),
      installFromSource: async (options: AppInstallFromSourceOptions) =>
        normalizeInstallFromSourceResult(
          await executeCommand('install-from-source', options),
          resolveRequestSession(options),
        ),
      list: async (options: AppListOptions = {}) => {
        const data = await executeCommand<Record<string, unknown>>('apps', options);
        return Array.isArray(data.apps)
          ? data.apps.filter((app): app is string => typeof app === 'string')
          : [];
      },
      open: async (options: AppOpenOptions) => {
        const session = resolveRequestSession(options);
        const data = await executeCommand<Record<string, unknown>>('open', options);
        const device = normalizeOpenDevice(data);
        const appBundleId = readOptionalString(data, 'appBundleId');
        const appId = appBundleId;
        return {
          session,
          sessionStateDir: readOptionalString(data, 'sessionStateDir'),
          appName: readOptionalString(data, 'appName'),
          appBundleId,
          appId,
          startup: normalizeStartupSample(data.startup),
          runtime: normalizeRuntimeHints(data.runtime),
          device,
          identifiers: {
            session,
            deviceId: device?.id,
            deviceName: device?.name,
            udid: device?.ios?.udid,
            serial: device?.android?.serial,
            appId,
            appBundleId,
          },
        };
      },
      close: async (options: AppCloseOptions = {}) => {
        const session = resolveRequestSession(options);
        const data = await executeCommand<Record<string, unknown>>('close', options);
        return {
          session,
          closedApp: options.app,
          shutdown: normalizeTargetShutdownResult(data.shutdown),
          identifiers: { session },
        };
      },
      push: async (options) => await executeCommand('push', options),
      triggerEvent: async (options) => await executeCommand('trigger-app-event', options),
    },
    materializations: {
      release: async (options: MaterializationReleaseOptions) =>
        normalizeMaterializationReleaseResult(
          await execute(INTERNAL_COMMANDS.releaseMaterializedPaths, [], {
            ...options,
            materializationId: options.materializationId,
          }),
        ),
    },
    leases: {
      allocate: async (options) =>
        normalizeLease(
          await execute(INTERNAL_COMMANDS.leaseAllocate, [], {
            ...options,
            leaseId: undefined,
          }),
        ),
      heartbeat: async (options) =>
        normalizeLease(await execute(INTERNAL_COMMANDS.leaseHeartbeat, [], options)),
      release: async (options) => {
        const data = await execute(INTERNAL_COMMANDS.leaseRelease, [], options);
        return { released: data.released === true };
      },
    },
    metro: {
      prepare: async (options: MetroPrepareOptions) =>
        await prepareMetroRuntime({
          projectRoot: options.projectRoot ?? config.cwd,
          kind: options.kind,
          publicBaseUrl: options.publicBaseUrl,
          proxyBaseUrl: options.proxyBaseUrl,
          proxyBearerToken: options.bearerToken,
          bridgeScope: options.bridgeScope,
          launchUrl: options.launchUrl,
          companionProfileKey: options.companionProfileKey,
          companionConsumerKey: options.companionConsumerKey,
          metroPort: options.port,
          listenHost: options.listenHost,
          statusHost: options.statusHost,
          startupTimeoutMs: options.startupTimeoutMs,
          probeTimeoutMs: options.probeTimeoutMs,
          reuseExisting: options.reuseExisting,
          installDependenciesIfNeeded: options.installDependenciesIfNeeded,
          runtimeFilePath: options.runtimeFilePath,
          logPath: options.logPath,
        }),
      reload: async (options = {}) =>
        await reloadMetro({
          metroHost: options.metroHost,
          metroPort: options.metroPort,
          bundleUrl: options.bundleUrl,
          runtime: config.runtime,
          timeoutMs: options.timeoutMs,
        }),
    },
    capture: {
      snapshot: async (options: CaptureSnapshotOptions = {}) => {
        const session = resolveRequestSession(options);
        const data = await executeCommand<Record<string, unknown>>('snapshot', options);
        // A non-default responseLevel returns the leveled snapshot digest
        // ({ nodeCount, refs, … }); normalizeSnapshotResult expects the full
        // `nodes` tree and would collapse it to an empty snapshot. Pass the
        // leveled payload through verbatim. (Mirrors capture.screenshot; the
        // caller opted into the level, so the runtime value is the leveled shape.)
        if (isLeveledResponse(options)) return data as unknown as CaptureSnapshotResult;
        return normalizeSnapshotResult(data, session);
      },
      screenshot: async (options: CaptureScreenshotOptions = {}) => {
        const session = resolveRequestSession(options);
        const data = await executeCommand<Record<string, unknown>>('screenshot', options);
        // A non-default responseLevel returns a leveled (digest) screenshot shape
        // — `overlayCount`, leveled `overlayRefs`, `artifacts` — that the default
        // normalizer below would drop. Pass the leveled payload through verbatim.
        // (The caller opted into a non-default level, so the static type is the
        // default shape; the runtime value is the leveled payload.)
        if (isLeveledResponse(options)) return data as unknown as CaptureScreenshotResult;
        const screenshot = readScreenshotResultData(data);
        return {
          path: readRequiredString(data, 'path'),
          overlayRefs: screenshot?.overlayRefs,
          identifiers: { session },
        };
      },
      diff: async (options) => await executeCommand('diff', options),
    },
    interactions: {
      click: async (options) => await executeCommand('click', options),
      press: async (options) => await executeCommand('press', options),
      longPress: async (options) => await executeCommand('longpress', options),
      swipe: async (options) => await executeCommand('swipe', options),
      pan: async (options) => await executeCommand('gesture-pan', options),
      fling: async (options) => await executeCommand('gesture-fling', options),
      swipeGesture: async (options) => await executeCommand('gesture-swipe', options),
      focus: async (options) => await executeCommand('focus', options),
      type: async (options) => await executeCommand('type', options),
      fill: async (options) => await executeCommand('fill', options),
      scroll: async (options) => await executeCommand('scroll', options),
      pinch: async (options) => await executeCommand('gesture-pinch', options),
      rotateGesture: async (options) => await executeCommand('gesture-rotate', options),
      transformGesture: async (options) => await executeCommand('gesture-transform', options),
      get: async (options) => await executeCommand('get', options),
      is: async (options) => await executeCommand('is', options),
      find: async (options) => await executeCommand('find', options),
    },
    replay: {
      run: async (options) => await executeCommand('replay', options),
      test: async (options) => await executeCommand('test', options),
    },
    batch: {
      run: async (options) => await executeCommand('batch', options),
    },
    observability: {
      perf: async (options = {}) => await executeCommand('perf', options),
      logs: async (options = {}) => await executeCommand('logs', options),
      network: async (options = {}) => await executeCommand('network', options),
    },
    debug: {
      symbols: async (options) =>
        await symbolicateCrashArtifact({ cwd: options.cwd ?? config.cwd, ...options }),
    },
    recording: {
      record: async (options) => await executeCommand('record', options),
      trace: async (options) => await executeCommand('trace', options),
    },
    settings: {
      update: async (options) => await executeCommand('settings', options),
    },
  };
}

function normalizeSnapshotResult(
  data: Record<string, unknown>,
  session: string | undefined,
): CaptureSnapshotResult {
  const appBundleId = readOptionalString(data, 'appBundleId');
  return {
    nodes: readSnapshotNodes(data.nodes),
    truncated: data.truncated === true,
    appName: readOptionalString(data, 'appName'),
    appBundleId,
    ...optionalSnapshotResponseFields(data),
    identifiers: {
      session,
      appId: appBundleId,
      appBundleId,
    },
  };
}

function optionalSnapshotResponseFields(
  data: Record<string, unknown>,
): Partial<
  Pick<
    CaptureSnapshotResult,
    | 'androidSnapshot'
    | 'unchanged'
    | 'visibility'
    | 'warnings'
    | 'snapshotQuality'
    | 'snapshotDiagnostics'
  >
> {
  const visibility = readObject(data.visibility);
  const unchanged = readObject(data.unchanged);
  const snapshotDiagnostics = readSnapshotDiagnosticsSummary(data.snapshotDiagnostics);
  return {
    ...(visibility ? { visibility: visibility as CaptureSnapshotResult['visibility'] } : {}),
    ...readSerializedSnapshotCaptureAnnotations(data),
    ...(unchanged ? { unchanged: unchanged as CaptureSnapshotResult['unchanged'] } : {}),
    ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
  };
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function mergeClientOptions(
  config: AgentDeviceClientConfig,
  options: InternalRequestOptions,
): InternalRequestOptions {
  return { ...config, ...options };
}

function normalizeLease(data: Record<string, unknown>): Lease {
  const rawLease = data.lease;
  if (!isRecord(rawLease)) {
    throw new Error('Invalid lease response from daemon');
  }
  return {
    leaseId: readRequiredString(rawLease, 'leaseId'),
    tenantId: readRequiredString(rawLease, 'tenantId'),
    runId: readRequiredString(rawLease, 'runId'),
    backend: readRequiredString(rawLease, 'backend') as Lease['backend'],
    leaseProvider: readOptionalString(rawLease, 'leaseProvider'),
    clientId: readOptionalString(rawLease, 'clientId'),
    deviceKey: readOptionalString(rawLease, 'deviceKey'),
    createdAt: typeof rawLease.createdAt === 'number' ? rawLease.createdAt : undefined,
    heartbeatAt: typeof rawLease.heartbeatAt === 'number' ? rawLease.heartbeatAt : undefined,
    expiresAt: typeof rawLease.expiresAt === 'number' ? rawLease.expiresAt : undefined,
  };
}

export type * from './client-types.ts';
