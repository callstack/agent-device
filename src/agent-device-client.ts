import { sendToDaemon } from './daemon/client/daemon-client.ts';
import { prepareMetroRuntime, reloadMetro } from './metro/client-metro.ts';
import {
  clearMetroSessionHints,
  readMetroSessionHints,
  writeMetroSessionHints,
  type MetroSessionHints,
} from './metro/metro-session-hints.ts';
import { resolveDaemonPaths } from './daemon/config.ts';
import { INTERNAL_COMMANDS } from './command-catalog.ts';
import {
  prepareDaemonCommandRequest,
  type DaemonCommandName,
} from './commands/command-projection.ts';
import { systemCommandFamily } from './commands/system/index.ts';
import { buildRequestFlags } from './commands/command-flags.ts';
import { throwDaemonError } from './daemon-error.ts';
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
} from './client/client-normalizers.ts';
import { readScreenshotResultData } from './utils/screenshot-result.ts';
import { isRecord } from './utils/parsing.ts';
import type {
  AgentDeviceCommandClient,
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
  MetroPrepareResult,
  OrientationCommandResult,
  PanOptions,
  FlingOptions,
  RotateCommandResult,
  SwipeGestureOptions,
  PinchOptions,
  RotateGestureOptions,
  TransformGestureOptions,
} from './client/client-types.ts';
import type { CommandResult } from './core/command-descriptor/command-result.ts';
import {
  isNonDefaultResponseLevel,
  type ResponseLevel,
  type SessionRuntimeHints,
} from './kernel/contracts.ts';
import { readSerializedSnapshotCaptureAnnotations } from './snapshot-capture-annotations.ts';
import { readSnapshotDiagnosticsSummary } from './snapshot-diagnostics.ts';
import type { CommandFlags } from './core/dispatch-context.ts';
import type { AgentArtifactsResult } from './cloud-artifacts.ts';
import type { ProjectedNavigationCommandClient } from './commands/system/navigation-projection.ts';
import { AppError } from './kernel/errors.ts';

type ProjectedSystemCommandClient = ProjectedNavigationCommandClient<InternalRequestOptions> &
  Pick<AgentDeviceCommandClient, 'appState' | 'keyboard' | 'clipboard' | 'rotate'>;

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
    input?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const merged = mergeClientOptions(config, options);
    const response = await transport({
      session: resolveSessionName(merged.session),
      command,
      positionals,
      ...(input ? { input } : {}),
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
      request.input,
    )) as T;
  };

  const resolveRequestSession = (options: InternalRequestOptions = {}) =>
    resolveSessionName(mergeClientOptions(config, options).session);
  const projectedSystemCommands = buildProjectedSystemCommandClient(executeCommand);

  return {
    command: {
      wait: async (options) => await executeCommand<CommandResult<'wait'>>('wait', options),
      alert: async (options = {}) => await executeCommand('alert', options),
      ...projectedSystemCommands,
      reactNative: async (options) => await executeCommand('react-native', options),
      doctor: async (options = {}) =>
        await executeCommand<CommandResult<'doctor'>>('doctor', options),
      prepare: async (options) =>
        await executeCommand<CommandResult<'prepare'>>('prepare', options),
      viewport: async (options) =>
        await executeCommand<CommandResult<'viewport'>>('viewport', options),
    },
    devices: {
      list: async (options = {}) => {
        const data = await executeCommand<Record<string, unknown>>('devices', options);
        const devices = Array.isArray(data.devices) ? data.devices : [];
        return devices.map(normalizeDevice);
      },
      capabilities: async (options = {}) => {
        const data = await executeCommand<Record<string, unknown>>('capabilities', options);
        const availableCommands = Array.isArray(data.availableCommands)
          ? data.availableCommands.filter(
              (command): command is string => typeof command === 'string',
            )
          : [];
        return {
          device: normalizeDevice(data.device),
          availableCommands,
        };
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
        try {
          const data = await executeCommand<Record<string, unknown>>('close', options);
          return {
            session,
            shutdown: normalizeTargetShutdownResult(data.shutdown),
            provider: readObject(data.provider),
            identifiers: { session },
          };
        } finally {
          // Close is teardown intent: drop the dev-server binding even if the daemon call fails.
          clearMetroSessionHintsQuietly(config, options);
        }
      },
      artifacts: async (options = {}) =>
        await executeCommand<AgentArtifactsResult>('artifacts', options),
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
        recordMetroSessionHintsAfterOpen({
          config,
          options,
          runtime: mergeClientOptions(config, options).runtime,
          sessionReused: data.sessionReused === true,
        });
        const device = normalizeOpenDevice(data);
        const appBundleId = readOptionalString(data, 'appBundleId');
        const appId = appBundleId;
        return {
          session,
          sessionStateDir: readOptionalString(data, 'sessionStateDir'),
          eventLogPath: readOptionalString(data, 'eventLogPath'),
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
      push: async (options) => await executeCommand<CommandResult<'push'>>('push', options),
      triggerEvent: async (options) =>
        await executeCommand<CommandResult<'trigger-app-event'>>('trigger-app-event', options),
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
        return { released: data.released === true, provider: readObject(data.provider) };
      },
    },
    metro: {
      prepare: async (options: MetroPrepareOptions) => {
        const result = await prepareMetroRuntime({
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
        });
        persistMetroSessionHints(config, result);
        return result;
      },
      reload: async (options = {}) =>
        await reloadMetro({
          metroHost: options.metroHost,
          metroPort: options.metroPort,
          bundleUrl: options.bundleUrl,
          runtime: config.runtime ?? resolveMetroSessionHints(config),
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
          width: screenshot?.width,
          height: screenshot?.height,
          logicalWidth: screenshot?.logicalWidth,
          logicalHeight: screenshot?.logicalHeight,
          pixelDensity: screenshot?.pixelDensity,
          overlayRefs: screenshot?.overlayRefs,
          identifiers: { session },
        };
      },
      diff: async (options) => await executeCommand<CommandResult<'diff'>>('diff', options),
    },
    interactions: {
      click: async (options) => await executeCommand('click', options),
      press: async (options) => await executeCommand('press', options),
      longPress: async (options) => await executeCommand('longpress', options),
      swipe: async (options) => await executeCommand('swipe', options),
      pan: async (options) => await executeCommand('gesture', panGestureInput(options)),
      fling: async (options) => await executeCommand('gesture', flingGestureInput(options)),
      swipeGesture: async (options) =>
        await executeCommand('gesture', swipePresetGestureInput(options)),
      focus: async (options) => await executeCommand('focus', options),
      type: async (options) => await executeCommand('type', options),
      fill: async (options) => await executeCommand('fill', options),
      scroll: async (options) => await executeCommand('scroll', options),
      pinch: async (options) => await executeCommand('gesture', pinchGestureInput(options)),
      rotateGesture: async (options) =>
        await executeCommand('gesture', rotateGestureInput(options)),
      transformGesture: async (options) =>
        await executeCommand('gesture', transformGestureInput(options)),
      get: async (options) => await executeCommand('get', options),
      is: async (options) => await executeCommand('is', options),
      find: async (options) => await executeCommand('find', options),
    },
    replay: {
      run: async (options) => await executeCommand<CommandResult<'replay'>>('replay', options),
      test: async (options) => await executeCommand<CommandResult<'test'>>('test', options),
    },
    batch: {
      run: async (options) => await executeCommand('batch', options),
    },
    observability: {
      perf: async (options = {}) => await executeCommand('perf', options),
      logs: async (options = {}) => await executeCommand('logs', options),
      events: async (options = {}) => await executeCommand('events', options),
      network: async (options = {}) => await executeCommand('network', options),
      audio: async (options = {}) => await executeCommand('audio', options),
    },
    debug: {
      symbols: async (options) => {
        const { symbolicateCrashArtifact } =
          await import('./platforms/apple/core/debug-symbols.ts');
        return symbolicateCrashArtifact({ cwd: options.cwd ?? config.cwd, ...options });
      },
    },
    recording: {
      record: async (options) => await executeCommand<CommandResult<'record'>>('record', options),
      trace: async (options) => await executeCommand<CommandResult<'trace'>>('trace', options),
    },
    settings: {
      update: async (options) => await executeCommand('settings', options),
    },
  };
}

function panGestureInput(options: PanOptions): InternalRequestOptions & Record<string, unknown> {
  const { x, y, dx, dy, ...common } = options;
  return { ...common, kind: 'pan', origin: { x, y }, delta: { x: dx, y: dy } };
}

function flingGestureInput(
  options: FlingOptions,
): InternalRequestOptions & Record<string, unknown> {
  const { x, y, ...common } = options;
  return { ...common, kind: 'fling', origin: { x, y } };
}

function swipePresetGestureInput(
  options: SwipeGestureOptions,
): InternalRequestOptions & Record<string, unknown> {
  return { ...options, kind: 'swipe' };
}

function pinchGestureInput(
  options: PinchOptions,
): InternalRequestOptions & Record<string, unknown> {
  const { x, y, ...common } = options;
  assertCompleteGestureCenter(x, y, 'pinch');
  return {
    ...common,
    kind: 'pinch',
    ...(x === undefined && y === undefined ? {} : { origin: { x, y } }),
  };
}

function rotateGestureInput(
  options: RotateGestureOptions,
): InternalRequestOptions & Record<string, unknown> {
  const { x, y, ...common } = options;
  assertCompleteGestureCenter(x, y, 'rotate');
  return {
    ...common,
    kind: 'rotate',
    ...(x === undefined && y === undefined ? {} : { origin: { x, y } }),
  };
}

function transformGestureInput(
  options: TransformGestureOptions,
): InternalRequestOptions & Record<string, unknown> {
  const { x, y, dx, dy, ...common } = options;
  return { ...common, kind: 'transform', origin: { x, y }, delta: { x: dx, y: dy } };
}

function assertCompleteGestureCenter(
  x: number | undefined,
  y: number | undefined,
  gesture: 'pinch' | 'rotate',
): void {
  if ((x === undefined) !== (y === undefined)) {
    throw new AppError('INVALID_ARGS', `gesture ${gesture} center requires both x and y`);
  }
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
    | 'refsGeneration'
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
    // ADR 0014: keep the response-level ref-frame generation on Node.js results
    // so callers can pin refs (`@e12~s<refsGeneration>`) before a mutation.
    ...(typeof data.refsGeneration === 'number' ? { refsGeneration: data.refsGeneration } : {}),
  };
}

function buildProjectedSystemCommandClient(
  executeCommand: <T>(command: DaemonCommandName, options?: InternalRequestOptions) => Promise<T>,
): ProjectedSystemCommandClient {
  const methods: Record<string, (options?: InternalRequestOptions) => Promise<unknown>> = {};
  for (const [method, command] of Object.entries(systemCommandFamily.clientCommandMethods ?? {})) {
    methods[method] = async (options = {}) =>
      await executeCommand<CommandResult<typeof command>>(command as DaemonCommandName, options);
  }
  // Deprecated (v0.18/v0.19): `rotate` was renamed to `orientation`. Retain a
  // thin wrapper that delegates to `orientation` and restores the legacy
  // `action: 'rotate'` response contract for existing consumers.
  const orientation = methods.orientation;
  if (!orientation) {
    throw new Error('orientation client method missing from the system command family');
  }
  methods.rotate = async (options = {}) => {
    const result = (await orientation(options)) as OrientationCommandResult;
    return { ...result, action: 'rotate' } satisfies RotateCommandResult;
  };
  return methods as unknown as ProjectedSystemCommandClient;
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

function metroSessionHintsScope(
  config: AgentDeviceClientConfig,
  options: InternalRequestOptions = {},
): { stateDir: string; session: string } {
  const merged = mergeClientOptions(config, options);
  return {
    stateDir: resolveDaemonPaths(merged.stateDir ?? process.env.AGENT_DEVICE_STATE_DIR).baseDir,
    session: resolveSessionName(merged.session),
  };
}

// The metro-sessions file is the session's dev-server binding; see MetroSessionHints.
function persistMetroSessionHints(
  config: AgentDeviceClientConfig,
  result: Pick<MetroPrepareResult, 'statusUrl' | 'bridge' | 'iosRuntime' | 'androidRuntime'>,
): void {
  try {
    const url = new URL(result.statusUrl);
    const port = Number.parseInt(url.port, 10);
    if (!url.hostname || !Number.isInteger(port)) return;
    // Bridge runtimes carry remote bundle URLs; persist local-flow bundle URLs only.
    const bundleUrl = result.bridge
      ? undefined
      : (result.iosRuntime.bundleUrl ?? result.androidRuntime.bundleUrl);
    writeMetroSessionHints({
      ...metroSessionHintsScope(config),
      hints: { metroHost: url.hostname, metroPort: port, bundleUrl },
    });
  } catch {
    // Session-hint persistence is best-effort; reload still works with explicit flags.
  }
}

function resolveMetroSessionHints(config: AgentDeviceClientConfig): MetroSessionHints | undefined {
  try {
    return readMetroSessionHints(metroSessionHintsScope(config));
  } catch {
    return undefined;
  }
}

function metroHintsFromRuntime(
  runtime: SessionRuntimeHints | undefined,
): MetroSessionHints | undefined {
  if (!runtime) return undefined;
  const { metroHost, metroPort, bundleUrl } = runtime;
  if (metroHost === undefined && metroPort === undefined && bundleUrl === undefined) {
    return undefined;
  }
  return { metroHost, metroPort, bundleUrl };
}

// Hint flags rebind the session's dev server; a hintless open that created the session clears
// any leftover binding from a previous same-name session.
function recordMetroSessionHintsAfterOpen(params: {
  config: AgentDeviceClientConfig;
  options: InternalRequestOptions;
  runtime: SessionRuntimeHints | undefined;
  sessionReused: boolean;
}): void {
  try {
    const scope = metroSessionHintsScope(params.config, params.options);
    const hints = metroHintsFromRuntime(params.runtime);
    if (hints) {
      writeMetroSessionHints({ ...scope, hints });
      return;
    }
    if (!params.sessionReused) {
      clearMetroSessionHints(scope);
    }
  } catch {
    // Session-hint sync is best-effort; reload still works with explicit flags.
  }
}

function clearMetroSessionHintsQuietly(
  config: AgentDeviceClientConfig,
  options: InternalRequestOptions,
): void {
  try {
    clearMetroSessionHints(metroSessionHintsScope(config, options));
  } catch {
    // Session-hint cleanup is best-effort; close must not fail on local file state.
  }
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

export type * from './client/client-types.ts';
