import { parseRawArgs, usage } from './cli/parser/args.ts';
import {
  asAppError,
  AppError,
  normalizeError,
  type NormalizedError,
} from '@agent-device/kernel/errors';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { withCommandHost } from '@agent-device/host-kit/command';
import { captureHostEnvironment } from '@agent-device/host-kit/environment';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { exitAfterFlush, writeStderr, writeStdout } from './cli/process-exit.ts';
import { readVersion } from '@agent-device/host-kit/version';
import { pathToFileURL } from 'node:url';
import { createEnsuredDaemonTransport, resolveRunTransport } from '@agent-device/daemon-client';
import fs from 'node:fs';
import type { ReplayTestReporterRuntime } from './cli/replay-test/reporting.ts';
import type { CommandProgressState } from '@agent-device/command-output';
import {
  createCommandProgressState,
  createStderrCommandProgressSink,
} from './commands/command-progress.ts';
import { createAgentDeviceClient } from '@agent-device/client';
import type {
  AgentDeviceClientConfig,
  AgentDeviceDaemonTransport,
  BatchStep,
  LeaseDevice,
} from '@agent-device/contracts/client';
import { tryRunClientBackedCommand } from './cli/commands/router.ts';
import { runAgentCdpCommand } from './cli/commands/agent-cdp.ts';
import {
  applyDefaultPlatformBinding,
  type DevicePin,
  getCommandSchema,
  isFlagSupportedForCommand,
  readCliBatchStepsJson,
  resolveBindingSettings,
} from '@agent-device/command-surface';
import {
  createRequestId,
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  registerDiagnosticSensitiveValue,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { resolveCliOptions } from './cli/resolve-cli-options.ts';
import type { CommandConnection } from './cli/connection/command-connection.ts';
import { maybeRunUpgradeNotifier } from './cli/update-check.ts';
import { remoteSessionRequiredError } from '@agent-device/contracts/lease-scope';
import {
  buildRemoteConnectionRequestMetadata,
  type RemoteConnectionState,
  type CloudSessionBinding,
  type RemoteConnectionRequestMetadata,
} from '@agent-device/remote/remote-connection-state';
import type { FlagKey } from '@agent-device/command-registry/flag-types';
import type { CliFlags } from '@agent-device/contracts/command';
import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import { isKnownCliCommandName } from '@agent-device/command-registry/catalog';

type CliDeps = Parameters<typeof resolveRunTransport>[0];

type CliDaemonTransport = ReturnType<typeof resolveRunTransport>;
type CliDaemonRequest = Parameters<CliDaemonTransport>[0];
type CliDaemonTransportOptions = Parameters<CliDaemonTransport>[1];
type ClientDaemonRequest = Parameters<AgentDeviceDaemonTransport>[0];

const printHumanError = async (
  ...args: Parameters<typeof import('./cli/failure-output.ts').printHumanError>
): Promise<void> => (await import('./cli/failure-output.ts')).printHumanError(...args);

const printJson = (
  result: { success: true; data?: unknown } | { success: false; error: NormalizedError },
): Promise<void> =>
  import('./commands/output/json.ts').then(({ printJson: write }) => write(result));

const DEFAULT_CLI_DEPS: CliDeps = {
  sendToDaemon: createEnsuredDaemonTransport({ onReplaced: writeDaemonReplacedNotice }),
  transportForHost: (host, admit) =>
    createEnsuredDaemonTransport({ host, admit, onReplaced: writeDaemonReplacedNotice }),
};

function writeDaemonReplacedNotice(replaced: {
  stateDir: string;
  previous: { pid: number; version?: string };
  reason: 'incompatible' | 'unreachable';
}): void {
  const { stateDir, previous, reason } = replaced;
  const identity = previous.version
    ? `pid ${previous.pid}, v${previous.version}`
    : `pid ${previous.pid}`;
  writeStderr(
    reason === 'unreachable'
      ? `Replaced unreachable daemon (${identity}) in ${stateDir}.\n`
      : `Replaced idle daemon (${identity}) in ${stateDir}: it did not match this client.\n`,
  );
}

const METRO_RUNTIME_OVERRIDE_FLAG_KEYS = new Set<FlagKey>([
  'launchUrl',
  'kind',
  'metroBearerToken',
  'metroKind',
  'metroListenHost',
  'metroNoInstallDeps',
  'metroNoReuseExisting',
  'metroPreparePort',
  'metroProbeTimeoutMs',
  'metroProjectRoot',
  'metroProxyBaseUrl',
  'metroPublicBaseUrl',
  'metroRuntimeFile',
  'metroStartupTimeoutMs',
  'metroStatusHost',
]);

const REMOTE_MATERIALIZATION_DEFERRED_COMMANDS = new Set([
  'connect',
  'connection',
  'close',
  'disconnect',
  'metro',
  'session',
  'takeover',
]);

export async function runCli(
  argv: string[],
  deps: CliDeps = DEFAULT_CLI_DEPS,
  host: HostEnvironment = captureHostEnvironment(process),
): Promise<void> {
  await withCommandHost(
    { host, requestEnv: undefined },
    async () => await runCliOnHost(argv, deps, host),
  );
}

async function runCliOnHost(argv: string[], deps: CliDeps, host: HostEnvironment): Promise<void> {
  // One transport per run: its ensure-once state is shared by the materialization client and the
  // command client, so a run ensures the daemon once.
  const requestId = createRequestId();
  const version = readVersion();
  const debugEnabled = isDebugRequested(argv);
  const jsonRequested = argv.includes('--json');
  // Best-effort session guess used only for pre-parse diagnostics scope.
  // After parse succeeds, request dispatch uses parsed flags/session resolution.
  const sessionGuess = guessSessionFromArgv(argv) ?? host.env.AGENT_DEVICE_SESSION ?? 'default';

  await withDiagnosticsScope(
    {
      session: sessionGuess,
      requestId,
      command: argv[0],
      debug: debugEnabled,
    },
    async () => {
      // A provider this route cannot supply is refused here: before this run resolves an option that
      // can carry a credential, and before any credential value is registered for redaction.
      const { runConnectPreflight } = await import('./cli/connect-preflight.ts');
      if (await runConnectPreflight(argv, host, { jsonRequested, debugEnabled })) return;
      const { parsed, command, positionals } = await parseCliInputOrExit(argv, {
        host,
        version,
        jsonRequested,
        debugEnabled,
      });
      const debugOutputEnabled = isParsedDebugRequested(command, parsed.providedFlags);
      const ctx = await resolveRunContextOrExit(parsed, {
        host,
        command,
        positionals,
        requestId,
        debugOutputEnabled,
      });
      if (ctx.effectiveFlags.daemonAuthToken)
        registerDiagnosticSensitiveValue(ctx.effectiveFlags.daemonAuthToken);
      let logTailStopper: (() => void) | null = null;
      try {
        if (command === 'react-devtools') {
          if (ctx.cloudSession) {
            throw new AppError('INVALID_ARGS', 'This command is unavailable on a cloud session.');
          }
          await exitAfterFlush(await runReactDevtoolsCli(ctx));
          return;
        }
        if (command === 'web') {
          const { runWebCommand } = await import('./cli/commands/web.ts');
          await exitAfterFlush(
            await runWebCommand(positionals, {
              flags: ctx.effectiveFlags,
              stateDir: ctx.daemonPaths.baseDir,
              host,
            }),
          );
          return;
        }
        maybeRunUpgradeNotifier({
          command,
          currentVersion: version,
          stateDir: ctx.daemonPaths.baseDir,
          flags: ctx.effectiveFlags,
        });
        await applySavedCloudAttachment(ctx);
        let transport = resolveRunTransport(deps, ctx.host, ctx.admitConnection);
        if (ctx.effectiveFlags.daemonAuthToken) {
          const { protectConnectionTransport } =
            await import('./cli/connection/cloud-attachment.ts');
          transport = await protectConnectionTransport(ctx, transport);
        }
        await resolveRemoteContext(ctx, transport);
        if (ctx.effectiveFlags.daemonAuthToken)
          registerDiagnosticSensitiveValue(ctx.effectiveFlags.daemonAuthToken);
        if (command === 'cdp') {
          if (ctx.cloudSession) {
            throw new AppError('INVALID_ARGS', 'This command is unavailable on a cloud session.');
          }
          await exitAfterFlush(
            await runAgentCdpCommand(positionals, {
              flags: ctx.effectiveFlags,
              runtime: ctx.resolvedRuntime,
              cwd: host.cwd,
              env: host.env,
            }),
          );
          return;
        }
        logTailStopper = maybeStartDaemonLogTail(ctx);
        const replayTestReporterRuntime = await createReplayReporterForTest(ctx);
        const commandProgress = createCommandProgressState();
        const send = createCliDaemonTransport({
          host: ctx.host,
          command,
          flags: ctx.effectiveFlags,
          replayTestReporterRuntime,
          commandProgress,
          cloudGeneration: ctx.cloudSession?.generation,
          transport,
        });
        const client = createAgentDeviceClient(buildClientConfig(ctx), {
          host: ctx.host,
          devicePin: ctx.devicePin,
          transport: send,
        });
        await dispatchCliCommand(ctx, client, replayTestReporterRuntime, commandProgress);
      } catch (error) {
        await handleRunCliFailure(error, ctx, logTailStopper);
      } finally {
        if (logTailStopper) logTailStopper();
      }
    },
  );
}

type ParsedCliInput = {
  parsed: ReturnType<typeof resolveCliOptions>;
  command: string;
  positionals: string[];
};

async function parseCliInputOrExit(
  argv: string[],
  options: {
    host: HostEnvironment;
    version: string;
    jsonRequested: boolean;
    debugEnabled: boolean;
  },
): Promise<ParsedCliInput> {
  let parsed: ReturnType<typeof resolveCliOptions>;
  try {
    parsed = resolveCliOptions(argv, { cwd: options.host.cwd, env: options.host.env });
  } catch (error) {
    return await exitOnParseFailure(error, argv, options);
  }

  for (const warning of parsed.warnings) {
    writeStderr(`Warning: ${warning}\n`);
  }

  if (parsed.flags.version) {
    writeStdout(`${options.version}\n`);
    return exitAfterFlush(0);
  }

  const isHelpAlias = parsed.command === 'help';
  const isHelpFlag = parsed.flags.help;
  if (isHelpAlias || isHelpFlag) {
    return await (await import('./cli/help-output.ts')).exitAfterHelp(parsed, isHelpAlias);
  }

  if (!parsed.command) {
    writeStdout(`${await usage()}\n`);
    return exitAfterFlush(1);
  }

  // The process entry starts the MCP server only for a bare `mcp`; anything that reaches here
  // carried flags the server would silently ignore.
  if (parsed.command === 'mcp') {
    return await exitOnParseFailure(
      new AppError(
        'INVALID_ARGS',
        'mcp accepts no flags or arguments other than --structured, --help, and --version.',
        {
          hint: 'Run agent-device mcp or agent-device mcp --structured. Configure the server with AGENT_DEVICE_* environment variables or AGENT_DEVICE_CONFIG.',
        },
      ),
      argv,
      options,
    );
  }

  return { parsed, command: parsed.command, positionals: parsed.positionals };
}

async function exitOnParseFailure(
  error: unknown,
  argv: string[],
  options: { jsonRequested: boolean; debugEnabled: boolean },
): Promise<never> {
  const { exitBeforeCommand } = await import('./cli/pre-command-failure.ts');
  return await exitBeforeCommand(error, argv, options, 'cli_parse_failed');
}

type CliRunContext = {
  host: HostEnvironment;
  command: string;
  positionals: string[];
  requestId: string;
  debugOutputEnabled: boolean;
  binding: ReturnType<typeof resolveBindingSettings>;
  // Flags after platform binding but before connection-default merge; batch
  // step inheritance keys off this pre-merge view.
  flags: CliFlags;
  daemonPaths: ReturnType<typeof resolveDaemonPaths>;
  sessionName: string;
  hadConnectionDefaults: boolean;
  claimedConnection?: RemoteConnectionState | null;
  commandConnection: CommandConnection | null;
  cloudSession?: CloudSessionBinding;
  admitConnection?: Parameters<typeof resolveRunTransport>[2];
  explicitFlagKeys: Set<FlagKey>;
  // Mutated in place by resolveRemoteContext (auth, materialization) so the
  // failure handler always sees the same state the throwing phase saw.
  effectiveFlags: CliFlags;
  resolvedRuntime: SessionRuntimeHints | undefined;
  connectionMetadata: RemoteConnectionRequestMetadata | undefined;
  /** The device a proxy backend granted for the lease's device spec; `open` reports it. */
  leaseDevice?: LeaseDevice;
  parsedBatchSteps: BatchStep[] | undefined;
  devicePin: DevicePin | undefined;
};

async function resolveRunContextOrExit(
  parsed: ReturnType<typeof resolveCliOptions>,
  base: {
    host: HostEnvironment;
    command: string;
    positionals: string[];
    requestId: string;
    debugOutputEnabled: boolean;
  },
): Promise<CliRunContext> {
  const explicitFlagKeys = new Set(parsed.providedFlags.map((entry) => entry.key));
  try {
    const binding = resolveBindingSettings({
      env: base.host.env,
      policyOverrides: parsed.flags,
      configuredPlatform: parsed.flags.platform,
      configuredSession: parsed.flags.session,
    });
    const flags = bindRunPlatform(parsed.flags, base.command, base.host, binding);
    if (base.command === 'connect' && flags.remoteConfig) {
      const { admitConnectProfileWithDiagnostics } = await import('./cli/connect-preflight.ts');
      await admitConnectProfileWithDiagnostics(
        parsed.remoteConfigLeaseProvider,
        flags.daemonBaseUrl,
        base.host,
      );
    }
    // A leased remote config, or a connect without one (it always leases through a provider), needs
    // an explicit session before anything is resolved or leased (#3931).
    const leasedRemoteConfig =
      parsed.remoteConfigLeaseProvider && runsOnRemoteConnection(base.command);
    const leasedConnect = base.command === 'connect' && !flags.remoteConfig;
    if (flags.session === undefined && (leasedRemoteConfig || leasedConnect)) {
      throw remoteSessionRequiredError(parsed.remoteConfigLeaseProvider);
    }
    const { resolveCommandConnection } = await import('./cli/connection/command-connection.ts');
    const { daemonPaths, effectiveFlags, defaults, connection } = resolveCommandConnection({
      host: base.host,
      flags,
      explicitFlagKeys,
      readDefaults:
        base.command !== 'connect' &&
        base.command !== 'connection' &&
        runsOnRemoteConnection(base.command),
      materializes: shouldMaterializeRemoteConnection(base.command),
      claimForDisconnect: base.command === 'disconnect',
    });
    const { resolveCloudAdmission } = await import('./cli/connection/active-connection.ts');
    const cloudSession = defaults?.cloudSession;
    const admitConnection = await resolveCloudAdmission({
      command: base.command,
      usesSessions: runsOnRemoteConnection(base.command),
      stateDir: daemonPaths.baseDir,
      session: effectiveFlags.session ?? flags.session,
      binding: cloudSession,
      remoteConfig: effectiveFlags.remoteConfig,
      remoteRoute: [
        defaults,
        effectiveFlags.daemonBaseUrl,
        base.host.env.AGENT_DEVICE_DAEMON_BASE_URL,
      ].some(Boolean),
    });
    return {
      ...base,
      binding,
      cloudSession,
      admitConnection,
      flags,
      daemonPaths,
      sessionName: flags.session ?? 'default',
      hadConnectionDefaults: defaults !== null,
      claimedConnection: defaults?.claimed,
      commandConnection: connection,
      explicitFlagKeys,
      effectiveFlags,
      resolvedRuntime: defaults?.runtime,
      connectionMetadata: defaults?.connection,
      parsedBatchSteps: undefined,
      devicePin: parsed.devicePin,
    };
  } catch (error) {
    const appErr = asAppError(error);
    const normalized = normalizeError(appErr, {
      diagnosticId: getDiagnosticsMeta().diagnosticId,
      logPath: flushDiagnosticsToSessionFile({ force: true })?.path,
    });
    if (parsed.flags.json) {
      await printJson({ success: false, error: normalized });
    } else {
      await printHumanError(normalized, {
        debugTier: base.debugOutputEnabled,
        command: parsed.command,
      });
    }
    return exitAfterFlush(1);
  }
}

function bindRunPlatform(
  flags: CliFlags,
  command: string,
  host: HostEnvironment,
  binding: ReturnType<typeof resolveBindingSettings>,
): CliFlags {
  if (binding.lockPolicy || getCommandSchema(command)?.explicitOnlyFlags?.includes('platform')) {
    return { ...flags };
  }
  return applyDefaultPlatformBinding(flags, {
    env: host.env,
    policyOverrides: flags,
    configuredPlatform: flags.platform,
    configuredSession: flags.session,
  });
}

async function runReactDevtoolsCli(ctx: CliRunContext): Promise<number> {
  const { runReactDevtoolsCommand } = await import('./cli/commands/react-devtools.ts');
  return await runReactDevtoolsCommand(ctx.positionals, {
    flags: ctx.effectiveFlags,
    stateDir: ctx.daemonPaths.baseDir,
    session: ctx.effectiveFlags.session ?? ctx.sessionName,
  });
}

async function applySavedCloudAttachment(ctx: CliRunContext): Promise<void> {
  const session = ctx.cloudSession;
  if (!session || ctx.command === 'disconnect' || ctx.command === 'auth') return;
  const { bindCloudAttachment } = await import('./cli/connection/cloud-attachment.ts');
  const location = { stateDir: ctx.daemonPaths.baseDir, session: ctx.sessionName };
  const attachment = await bindCloudAttachment({
    host: ctx.host,
    flags: ctx.effectiveFlags,
    location,
    session,
  });
  ctx.host = attachment.host;
  ctx.effectiveFlags = attachment.flags;
  if (session.transport === 'agent-device-daemon') {
    ctx.connectionMetadata = undefined;
    ctx.commandConnection = null;
  }
}

async function resolveRemoteContext(
  ctx: CliRunContext,
  transport: CliDaemonTransport,
): Promise<void> {
  if (ctx.command === 'batch') {
    if (ctx.positionals.length > 0) {
      throw new AppError('INVALID_ARGS', 'batch does not accept positional arguments.');
    }
    ctx.parsedBatchSteps = readBatchSteps(ctx.flags);
  }

  const remote = ctx.commandConnection
    ? await import('./cli/commands/connection-runtime.ts')
    : undefined;
  const selection =
    remote && ctx.commandConnection
      ? await remote.selectRemoteConnectionForCommand(
          ctx.commandConnection,
          ctx.effectiveFlags,
          ctx.host,
        )
      : undefined;
  if (selection) {
    ctx.connectionMetadata = buildRemoteConnectionRequestMetadata(selection.state);
  }

  if (!ctx.cloudSession && shouldResolveRemoteAuth(ctx.command)) {
    const { resolveConnectionAuthFlags } = await import('./cli/connection/active-connection.ts');
    ctx.effectiveFlags = await resolveConnectionAuthFlags({
      command: ctx.command,
      provider: ctx.positionals[0],
      flags: ctx.effectiveFlags,
      host: ctx.host,
      location: { stateDir: ctx.daemonPaths.baseDir, session: ctx.sessionName },
    });
  }

  if (remote && selection) {
    const send = createClientDaemonTransport(transport);
    const materializationClient = createAgentDeviceClient(buildClientConfig(ctx), {
      host: ctx.host,
      devicePin: ctx.devicePin,
      transport: send,
    });
    const materialized = await remote.materializeRemoteConnectionForCommand({
      selection,
      host: ctx.host,
      command: ctx.command,
      flags: ctx.effectiveFlags,
      client: materializationClient,
      runtime: ctx.resolvedRuntime,
      positionals: ctx.positionals,
      batchSteps: ctx.parsedBatchSteps,
      forceRuntimePrepare: hasExplicitMetroRuntimeOverrides(ctx.explicitFlagKeys),
      cloudGeneration: ctx.cloudSession?.generation,
    });
    ctx.effectiveFlags = materialized.flags;
    ctx.resolvedRuntime = materialized.runtime;
    ctx.connectionMetadata = materialized.connection;
    ctx.leaseDevice = materialized.leaseDevice;
  }
  if (
    shouldWarnOpenMayMissRemoteRuntime({
      command: ctx.command,
      flags: ctx.effectiveFlags,
      runtime: ctx.resolvedRuntime,
      explicitFlagKeys: ctx.explicitFlagKeys,
      hadConnectionDefaults: ctx.hadConnectionDefaults,
    })
  ) {
    writeStderr(
      'Warning: open is using explicit remote daemon or tenant flags without saved Metro runtime hints. React Native apps may launch without bundle/runtime hints; prefer connect --remote-config <path> first or pass --remote-config <path> on this command.\n',
    );
  }
}

function buildClientConfig(ctx: CliRunContext): AgentDeviceClientConfig {
  const currentFlags = ctx.effectiveFlags;
  const connection = ctx.connectionMetadata;
  return {
    session: currentFlags.session,
    requestId: ctx.requestId,
    stateDir: currentFlags.stateDir,
    daemonBaseUrl: currentFlags.daemonBaseUrl,
    daemonAuthToken: currentFlags.daemonAuthToken,
    daemonTransport: currentFlags.daemonTransport,
    daemonServerMode: currentFlags.daemonServerMode,
    tenant: currentFlags.tenant,
    sessionIsolation: currentFlags.sessionIsolation,
    runId: currentFlags.runId,
    leaseId: currentFlags.leaseId,
    leaseBackend: currentFlags.leaseBackend,
    leaseProvider: connection?.leaseProvider,
    clientId: connection?.clientId,
    deviceKey: connection?.deviceKey,
    providerApp: currentFlags.providerApp,
    providerOsVersion: currentFlags.providerOsVersion,
    providerDeviceType: currentFlags.providerDeviceType,
    providerProject: currentFlags.providerProject,
    providerBuild: currentFlags.providerBuild,
    providerSessionName: currentFlags.providerSessionName,
    providerDeviceOrientation: currentFlags.providerDeviceOrientation,
    providerGeoLocation: currentFlags.providerGeoLocation,
    providerTimezone: currentFlags.providerTimezone,
    providerAppiumVersion: currentFlags.providerAppiumVersion,
    providerLanguage: currentFlags.providerLanguage,
    providerLocale: currentFlags.providerLocale,
    providerNetworkProfile: currentFlags.providerNetworkProfile,
    providerCustomNetwork: currentFlags.providerCustomNetwork,
    providerNoResignApp: currentFlags.providerNoResignApp,
    providerNetworkLogs: currentFlags.providerNetworkLogs,
    providerNetworkHosts: currentFlags.providerNetworkHosts,
    awsProjectArn: currentFlags.awsProjectArn,
    awsDeviceArn: currentFlags.awsDeviceArn,
    awsAppArn: currentFlags.awsAppArn,
    awsRegion: currentFlags.awsRegion,
    awsInteractionMode: currentFlags.awsInteractionMode,
    runtime: ctx.resolvedRuntime,
    lockPolicy: ctx.binding.lockPolicy,
    lockPlatform: ctx.binding.defaultPlatform,
    cwd: ctx.host.cwd,
    debug: ctx.debugOutputEnabled,
    cost: currentFlags.cost,
    responseLevel: currentFlags.responseLevel,
  };
}

function maybeStartDaemonLogTail(ctx: CliRunContext): (() => void) | null {
  const remoteDaemonBaseUrl = ctx.effectiveFlags.daemonBaseUrl;
  return ctx.debugOutputEnabled && !ctx.effectiveFlags.json && !remoteDaemonBaseUrl
    ? startDaemonLogTail(ctx.daemonPaths.logPath)
    : null;
}

async function createReplayReporterForTest(
  ctx: CliRunContext,
): Promise<ReplayTestReporterRuntime | undefined> {
  if (ctx.command !== 'test') return undefined;
  // Lazy: the replay test reporter is only needed by `test`, and its
  // static import would put the reporting runtime on every command's path.
  const { createReplayTestReporterRuntime } = await import('./cli/replay-test/reporting.ts');
  return createReplayTestReporterRuntime({
    debug: ctx.debugOutputEnabled,
    verbose: ctx.effectiveFlags.verbose,
    json: ctx.effectiveFlags.json,
    reporter: ctx.effectiveFlags.reporter,
    reportJunit: ctx.effectiveFlags.reportJunit,
  });
}

async function dispatchCliCommand(
  ctx: CliRunContext,
  client: ReturnType<typeof createAgentDeviceClient>,
  replayTestReporterRuntime: ReplayTestReporterRuntime | undefined,
  commandProgress: CommandProgressState,
): Promise<void> {
  const { command, positionals, effectiveFlags } = ctx;
  if (command === 'batch') {
    if (!ctx.parsedBatchSteps) {
      throw new AppError('INVALID_ARGS', 'batch requires --steps or --steps-file.');
    }
    const batchSteps = ctx.parsedBatchSteps.map((step, _index) => ({
      ...step,
      input:
        ctx.binding.lockPolicy && ctx.flags.platform === undefined
          ? { ...step.input }
          : applyDefaultPlatformBinding(step.input, {
              env: ctx.host.env,
              policyOverrides: effectiveFlags,
              configuredPlatform: effectiveFlags.platform,
              configuredSession: effectiveFlags.session,
              inheritedPlatform: effectiveFlags.platform,
            }),
    }));
    if (
      await tryRunClientBackedCommand({
        host: ctx.host,
        command,
        positionals,
        flags: { ...effectiveFlags, batchSteps },
        client,
        debug: ctx.debugOutputEnabled,
        replayTestReporterRuntime,
        commandProgress,
      })
    ) {
      return;
    }
  } else if (command === 'runtime') {
    throw new AppError(
      'INVALID_ARGS',
      'runtime command was removed. Use connect --remote-config <path> for remote runs, or metro prepare --remote-config <path> for inspection.',
    );
  } else if (
    await tryRunClientBackedCommand({
      host: ctx.host,
      command,
      positionals,
      flags: effectiveFlags,
      client,
      debug: ctx.debugOutputEnabled,
      replayTestReporterRuntime,
      commandProgress,
      leaseDevice: ctx.leaseDevice,
      claimedConnection: ctx.claimedConnection,
    })
  ) {
    return;
  }

  throw new AppError('INVALID_ARGS', formatUnhandledCommandMessage(command));
}

async function handleRunCliFailure(
  err: unknown,
  ctx: CliRunContext,
  logTailStopper: (() => void) | null,
): Promise<void> {
  const appErr = asAppError(err);
  const normalized = normalizeError(appErr, {
    diagnosticId: getDiagnosticsMeta().diagnosticId,
    logPath: flushDiagnosticsToSessionFile({ force: true })?.path,
  });
  if (ctx.command === 'close' && isDaemonStartupFailure(appErr)) {
    if (ctx.effectiveFlags.json) {
      await printJson({ success: true, data: { closed: 'session', source: 'no-daemon' } });
    }
    return;
  }
  // Stop the live --debug tail first so none of its output lands after the error's
  // closing summary line.
  if (logTailStopper) logTailStopper();
  if (ctx.effectiveFlags.json) {
    await printJson({
      success: false,
      error: normalized,
    });
  } else {
    await printHumanError(normalized, {
      debugTier: ctx.debugOutputEnabled,
      command: ctx.command,
      logTail: ctx.debugOutputEnabled
        ? {
            daemonBaseUrl: ctx.effectiveFlags.daemonBaseUrl,
            daemonPaths: ctx.daemonPaths,
            record: normalized.diagnosticsRecord,
          }
        : undefined,
    });
  }
  // #1596: a bare `process.exit()` right after these writes can drop them —
  // Node flushes stdout/stderr synchronously only to a file or TTY, and this
  // CLI is commonly piped by whatever is driving it. `exitAfterFlush` waits
  // for the writes above to actually reach the pipe first.
  await exitAfterFlush(1);
}

function isDebugRequested(argv: string[]): boolean {
  try {
    const parsed = parseRawArgs(argv);
    return isParsedDebugRequested(parsed.command ?? '', parsed.providedFlags);
  } catch {
    return argv.includes('--debug') || argv.includes('-v') || argv.includes('--verbose');
  }
}

function formatUnhandledCommandMessage(command: string): string {
  if (isKnownCliCommandName(command)) {
    // Registered-but-unhandled means catalog/dispatch drift — make it visible
    // in telemetry too, not just the thrown message (from #1055).
    emitDiagnostic({
      level: 'error',
      phase: 'cli_known_command_unhandled',
      data: { command },
    });
    return `Command is registered but no CLI handler accepted it: ${command}`;
  }
  return `Unknown command: ${command}`;
}

function isParsedDebugRequested(
  command: string,
  providedFlags: Array<{ key: FlagKey; token: string }>,
): boolean {
  return providedFlags.some(
    (entry) =>
      entry.key === 'verbose' &&
      (entry.token === '--debug' || entry.token === '-v' || command !== 'test'),
  );
}

function readBatchSteps(flags: ReturnType<typeof resolveCliOptions>['flags']): BatchStep[] {
  let raw = '';
  if (flags.steps) {
    raw = flags.steps;
  } else if (flags.stepsFile) {
    try {
      raw = fs.readFileSync(flags.stepsFile, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError(
        'INVALID_ARGS',
        `Failed to read --steps-file ${flags.stepsFile}: ${message}`,
      );
    }
  }
  return readCliBatchStepsJson(raw);
}

function isDaemonStartupFailure(error: AppError): boolean {
  if (error.code !== 'COMMAND_FAILED') return false;
  if (error.details?.kind === 'daemon_startup_failed') return true;
  if (!error.message.toLowerCase().includes('failed to start daemon')) return false;
  return typeof error.details?.infoPath === 'string' || typeof error.details?.lockPath === 'string';
}

// A command that cannot take a session runs on no remote connection. Reading, authenticating or
// leasing one would act for a session the command cannot name.
function runsOnRemoteConnection(command: string): boolean {
  return isFlagSupportedForCommand('session', command);
}

function shouldMaterializeRemoteConnection(command: string): boolean {
  return runsOnRemoteConnection(command) && !REMOTE_MATERIALIZATION_DEFERRED_COMMANDS.has(command);
}

function shouldResolveRemoteAuth(command: string): boolean {
  // `connection status` reports the stored record and sends no daemon request.
  return runsOnRemoteConnection(command) && command !== 'connection';
}

function shouldWarnOpenMayMissRemoteRuntime(options: {
  command: string;
  flags: CliFlags;
  runtime?: SessionRuntimeHints;
  explicitFlagKeys: Set<FlagKey>;
  hadConnectionDefaults: boolean;
  claimedConnection?: RemoteConnectionState | null;
}): boolean {
  if (options.command !== 'open') return false;
  if (options.runtime) return false;
  if (options.flags.bundleUrl || options.flags.metroHost || options.flags.metroPort) return false;
  if (options.flags.remoteConfig) return false;
  if (options.hadConnectionDefaults) return false;
  return hasExplicitRemoteScopeFlags(options.explicitFlagKeys);
}

function hasExplicitRemoteScopeFlags(explicitFlagKeys: Set<FlagKey>): boolean {
  return (
    explicitFlagKeys.has('daemonBaseUrl') ||
    explicitFlagKeys.has('daemonTransport') ||
    explicitFlagKeys.has('tenant') ||
    explicitFlagKeys.has('sessionIsolation') ||
    explicitFlagKeys.has('runId') ||
    explicitFlagKeys.has('leaseId') ||
    explicitFlagKeys.has('leaseBackend')
  );
}

function hasExplicitMetroRuntimeOverrides(explicitFlagKeys: Set<FlagKey>): boolean {
  for (const key of METRO_RUNTIME_OVERRIDE_FLAG_KEYS) {
    if (explicitFlagKeys.has(key)) {
      return true;
    }
  }
  return false;
}

type CliDaemonTransportSetup = {
  host: HostEnvironment;
  command: string;
  flags: CliFlags;
  replayTestReporterRuntime?: ReplayTestReporterRuntime;
  commandProgress: CommandProgressState;
  transport: CliDaemonTransport;
  cloudGeneration?: string;
};

/**
 * A remote connection reads each daemon reply for the leases its request ended, and forgets the
 * stored lease when the reply names it.
 */
function createCliDaemonTransport(options: CliDaemonTransportSetup): AgentDeviceDaemonTransport {
  const { flags, host, cloudGeneration } = options;
  const send = createCliProgressTransport(options);
  if (!flags.remoteConfig || options.command === 'connect' || options.command === 'disconnect')
    return send;
  return async (req, context) => {
    const response = await send(req, context);
    const { forgetEndedConnectionLease } = await import('./cli/connection/ended-lease.ts');
    await forgetEndedConnectionLease(flags, response, host, cloudGeneration);
    return response;
  };
}

/**
 * The human CLI renders streamed progress itself: `test` hands its events to the
 * replay-test reporter, every other command streams `command` lines to stderr
 * through `commandProgress`, whose state the output formatters then read (a
 * doctor summary does not repeat checks progress already printed). `--json` opts
 * out of progress entirely, so it installs no sink.
 */
function createCliProgressTransport(options: CliDaemonTransportSetup): AgentDeviceDaemonTransport {
  const { command, flags, replayTestReporterRuntime, transport } = options;
  if (flags.json) return createClientDaemonTransport(transport);
  const onProgress =
    command === 'test' && replayTestReporterRuntime
      ? replayTestReporterRuntime.onProgress
      : createStderrCommandProgressSink(options.commandProgress, options.host.env);
  return async (req, context) => {
    const transportOptions = { ...context, onProgress };
    return await sendClientRequestToCliTransport(
      transport,
      {
        ...req,
        meta: {
          ...req.meta,
          requestProgress: command === 'test' ? 'replay-test' : 'command',
        },
      },
      transportOptions,
    );
  };
}

function createClientDaemonTransport(transport: CliDaemonTransport): AgentDeviceDaemonTransport {
  return async (req, context) => await sendClientRequestToCliTransport(transport, req, context);
}

async function sendClientRequestToCliTransport(
  transport: CliDaemonTransport,
  req: ClientDaemonRequest,
  options?: CliDaemonTransportOptions,
): ReturnType<CliDaemonTransport> {
  return await transport(req as CliDaemonRequest, options);
}

function guessSessionFromArgv(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith('--session=')) {
      const inline = token.slice('--session='.length).trim();
      return inline.length > 0 ? inline : null;
    }
    if (token === '--session') {
      const value = argv[i + 1]?.trim();
      if (value && !value.startsWith('-')) return value;
      return null;
    }
  }
  return null;
}

const isDirectRun = pathToFileURL(process.argv[1] ?? '').href === import.meta.url;
if (isDirectRun) {
  runCli(process.argv.slice(2)).catch(async (error) => {
    const appErr = asAppError(error);
    await printHumanError(normalizeError(appErr), {
      debugTier: true,
      argv: process.argv.slice(2),
    });
    await exitAfterFlush(1);
  });
}

function startDaemonLogTail(logPath: string): (() => void) | null {
  try {
    let offset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    let stopped = false;
    const interval = setInterval(() => {
      if (stopped) return;
      if (!fs.existsSync(logPath)) return;
      try {
        const stats = fs.statSync(logPath);
        if (stats.size < offset) offset = 0;
        if (stats.size <= offset) return;
        const fd = fs.openSync(logPath, 'r');
        try {
          const buffer = Buffer.alloc(stats.size - offset);
          fs.readSync(fd, buffer, 0, buffer.length, offset);
          offset = stats.size;
          if (buffer.length > 0) {
            writeStdout(buffer.toString('utf8'));
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // Best-effort tailing should not crash CLI flow.
      }
    }, 200);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  } catch {
    return null;
  }
}
