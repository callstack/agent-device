import { parseRawArgs, usage, usageForCommand } from './cli/parser/args.ts';
import { suggestCommandFor } from './cli/parser/command-suggestions.ts';
import {
  asAppError,
  AppError,
  normalizeError,
  throwDaemonError,
  type NormalizedError,
} from '@agent-device/kernel/errors';
import { resolveRemoteRequestDiagnosticsPath } from './daemon/session-store.ts';
import { printHumanError, printJson } from './utils/output.ts';
import { exitAfterFlush } from './utils/process-exit.ts';
import { readVersion } from '@agent-device/host-kit/version';
import { pathToFileURL } from 'node:url';
import { sendToDaemon } from './daemon/client/daemon-client.ts';
import fs from 'node:fs';
import type { BatchStep } from '@agent-device/contracts/client';
import type { ReplayTestReporterRuntime } from './replay/test/reporting.ts';
import {
  createAgentDeviceClient,
  type AgentDeviceClientConfig,
  type AgentDeviceDaemonTransport,
} from './agent-device-client.ts';
import { materializeRemoteConnectionForCommand } from './cli/commands/connection-runtime.ts';
import { tryRunClientBackedCommand } from './cli/commands/router.ts';
import { runAgentCdpCommand } from './cli/commands/agent-cdp.ts';
import { runReactDevtoolsCommand } from './cli/commands/react-devtools.ts';
import { runWebCommand } from './cli/commands/web.ts';
import { readCliBatchStepsJson } from './cli/batch-steps.ts';
import {
  createRequestId,
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  registerDiagnosticSensitiveValue,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { resolveDaemonPaths } from './daemon/config.ts';
import { applyDefaultPlatformBinding, resolveBindingSettings } from './utils/session-binding.ts';
import { resolveCliOptions } from './cli/resolve-cli-options.ts';
import { maybeRunUpgradeNotifier } from './utils/update-check.ts';
import {
  resolveRemoteConnectionDefaults,
  type RemoteConnectionRequestMetadata,
} from './remote/remote-connection-state.ts';
import { resolveRemoteAuthForCli } from './cli/auth-session.ts';
import type { FlagKey } from './commands/cli-grammar/flag-types.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import { INTERNAL_COMMANDS, isKnownCliCommandName } from './command-catalog.ts';
import { sendInjectedDaemonRequest } from './cli/injected-daemon-dispatch.ts';

type CliDeps = {
  sendToDaemon: typeof sendToDaemon;
};

type CliDaemonTransport = typeof sendToDaemon;
type CliDaemonRequest = Parameters<CliDaemonTransport>[0];
type CliDaemonTransportOptions = Parameters<CliDaemonTransport>[1];
type ClientDaemonRequest = Parameters<AgentDeviceDaemonTransport>[0];

const DEFAULT_CLI_DEPS: CliDeps = {
  sendToDaemon,
};

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
  'daemon',
  'device',
  'disconnect',
  'metro',
  'proxy',
  'session',
]);

export async function runCli(argv: string[], deps: CliDeps = DEFAULT_CLI_DEPS): Promise<void> {
  const requestId = createRequestId();
  const version = readVersion();
  const debugEnabled = isDebugRequested(argv);
  const jsonRequested = argv.includes('--json');
  // Best-effort session guess used only for pre-parse diagnostics scope.
  // After parse succeeds, request dispatch uses parsed flags/session resolution.
  const sessionGuess = guessSessionFromArgv(argv) ?? process.env.AGENT_DEVICE_SESSION ?? 'default';

  await withDiagnosticsScope(
    {
      session: sessionGuess,
      requestId,
      command: argv[0],
      debug: debugEnabled,
    },
    async () => {
      const { parsed, command, positionals } = await parseCliInputOrExit(argv, {
        version,
        jsonRequested,
        debugEnabled,
      });
      const debugOutputEnabled = isParsedDebugRequested(command, parsed.providedFlags);
      const ctx = await resolveRunContextOrExit(parsed, {
        command,
        positionals,
        requestId,
        debugOutputEnabled,
      });
      registerDaemonAuthDiagnosticValue(ctx.effectiveFlags);
      let logTailStopper: (() => void) | null = null;
      try {
        if (command === 'react-devtools') {
          await exitAfterFlush(await runReactDevtoolsCli(ctx, deps));
          return;
        }
        if (command === 'web') {
          await exitAfterFlush(
            await runWebCommand(positionals, {
              flags: ctx.effectiveFlags,
              stateDir: ctx.daemonPaths.baseDir,
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
        await resolveRemoteContext(ctx, deps);
        registerDaemonAuthDiagnosticValue(ctx.effectiveFlags);
        if (command === 'cdp') {
          await exitAfterFlush(
            await runAgentCdpCommand(positionals, {
              flags: ctx.effectiveFlags,
              runtime: ctx.resolvedRuntime,
              cwd: process.cwd(),
              env: process.env,
            }),
          );
          return;
        }
        logTailStopper = maybeStartDaemonLogTail(ctx);
        const replayTestReporterRuntime = await createReplayReporterForTest(ctx);
        const client = createAgentDeviceClient(buildClientConfig(ctx), {
          transport: createCliDaemonTransport({
            command,
            flags: ctx.effectiveFlags,
            replayTestReporterRuntime,
            transport: deps.sendToDaemon,
          }),
        });
        await dispatchCliCommand(ctx, client, replayTestReporterRuntime);
      } catch (err) {
        await handleRunCliFailure(err, ctx, logTailStopper);
      } finally {
        if (logTailStopper) logTailStopper();
      }
    },
  );
}

function registerDaemonAuthDiagnosticValue(flags: CliFlags): void {
  if (flags.daemonAuthToken) registerDiagnosticSensitiveValue(flags.daemonAuthToken);
}

type ParsedCliInput = {
  parsed: ReturnType<typeof resolveCliOptions>;
  command: string;
  positionals: string[];
};

async function parseCliInputOrExit(
  argv: string[],
  options: { version: string; jsonRequested: boolean; debugEnabled: boolean },
): Promise<ParsedCliInput> {
  let parsed: ReturnType<typeof resolveCliOptions>;
  try {
    parsed = resolveCliOptions(argv, { cwd: process.cwd(), env: process.env });
  } catch (error) {
    emitDiagnostic({
      level: 'error',
      phase: 'cli_parse_failed',
      data: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    const normalized = normalizeError(error, {
      diagnosticId: getDiagnosticsMeta().diagnosticId,
      logPath: flushDiagnosticsToSessionFile({ force: true })?.path,
    });
    if (options.jsonRequested) {
      printJson({ success: false, error: normalized });
    } else {
      printHumanError(normalized, { showDetails: options.debugEnabled });
    }
    return exitAfterFlush(1);
  }

  for (const warning of parsed.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }

  if (parsed.flags.version) {
    process.stdout.write(`${options.version}\n`);
    return exitAfterFlush(0);
  }

  const isHelpAlias = parsed.command === 'help';
  const isHelpFlag = parsed.flags.help;
  if (isHelpAlias || isHelpFlag) {
    if (isHelpAlias && parsed.positionals.length > 1) {
      printHumanError(new AppError('INVALID_ARGS', 'help accepts at most one command.'));
      return exitAfterFlush(1);
    }
    const helpTarget = isHelpAlias ? parsed.positionals[0] : parsed.command;
    if (!helpTarget) {
      process.stdout.write(`${await usage()}\n`);
      return exitAfterFlush(0);
    }
    const commandHelp = await usageForCommand(helpTarget);
    if (commandHelp) {
      process.stdout.write(commandHelp);
      return exitAfterFlush(0);
    }
    printHumanError(new AppError('INVALID_ARGS', formatUnknownHelpTargetMessage(helpTarget)));
    process.stdout.write(`${await usage()}\n`);
    return exitAfterFlush(1);
  }

  if (!parsed.command) {
    process.stdout.write(`${await usage()}\n`);
    return exitAfterFlush(1);
  }

  return { parsed, command: parsed.command, positionals: parsed.positionals };
}

type CliRunContext = {
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
  connectionDefaults: ReturnType<typeof resolveActiveConnectionDefaults>;
  explicitFlagKeys: Set<FlagKey>;
  // Mutated in place by resolveRemoteContext (auth, materialization) so the
  // failure handler always sees the same state the throwing phase saw.
  effectiveFlags: CliFlags;
  resolvedRuntime: SessionRuntimeHints | undefined;
  connectionMetadata: RemoteConnectionRequestMetadata | undefined;
  parsedBatchSteps: BatchStep[] | undefined;
};

async function resolveRunContextOrExit(
  parsed: ReturnType<typeof resolveCliOptions>,
  base: { command: string; positionals: string[]; requestId: string; debugOutputEnabled: boolean },
): Promise<CliRunContext> {
  const explicitFlagKeys = new Set(parsed.providedFlags.map((entry) => entry.key));
  try {
    const binding = resolveBindingSettings({
      policyOverrides: parsed.flags,
      configuredPlatform: parsed.flags.platform,
      configuredSession: parsed.flags.session,
    });
    const flags = binding.lockPolicy
      ? { ...parsed.flags }
      : applyDefaultPlatformBinding(parsed.flags, {
          policyOverrides: parsed.flags,
          configuredPlatform: parsed.flags.platform,
          configuredSession: parsed.flags.session,
        });
    const daemonPaths = resolveDaemonPaths(flags.stateDir);
    const sessionName = flags.session ?? 'default';
    const connectionDefaults = resolveActiveConnectionDefaults({
      command: base.command,
      explicitFlagKeys,
      stateDir: daemonPaths.baseDir,
      session: sessionName,
      remoteConfig: flags.remoteConfig,
      hasResolvedSession: flags.session !== undefined,
    });
    const effectiveFlags = connectionDefaults
      ? mergeConnectionFlags(flags, connectionDefaults.flags, explicitFlagKeys)
      : flags;
    return {
      ...base,
      binding,
      flags,
      daemonPaths,
      sessionName,
      connectionDefaults,
      explicitFlagKeys,
      effectiveFlags,
      resolvedRuntime: connectionDefaults?.runtime,
      connectionMetadata: connectionDefaults?.connection,
      parsedBatchSteps: undefined,
    };
  } catch (err) {
    const appErr = asAppError(err);
    const normalized = normalizeError(appErr, {
      diagnosticId: getDiagnosticsMeta().diagnosticId,
      logPath: flushDiagnosticsToSessionFile({ force: true })?.path,
    });
    if (parsed.flags.json) {
      printJson({ success: false, error: normalized });
    } else {
      printHumanError(normalized, { showDetails: base.debugOutputEnabled });
    }
    return exitAfterFlush(1);
  }
}

async function runReactDevtoolsCli(ctx: CliRunContext, deps: CliDeps): Promise<number> {
  const { daemonAuthToken, ...directRequestFlags } = ctx.effectiveFlags;
  return await runReactDevtoolsCommand(ctx.positionals, {
    flags: {
      ...directRequestFlags,
      leaseProvider: ctx.connectionDefaults?.connection?.leaseProvider,
    },
    stateDir: ctx.daemonPaths.baseDir,
    session: ctx.effectiveFlags.session ?? ctx.sessionName,
    cwd: process.cwd(),
    env: process.env,
    configureDirectPortReverse: async () => {
      const response = await sendInjectedDaemonRequest({
        route: 'react-devtools',
        command: INTERNAL_COMMANDS.runtime,
        request: {
          positionals: ['port-reverse'],
          flags: {
            ...directRequestFlags,
            leaseProvider: ctx.connectionDefaults?.connection?.leaseProvider,
            devicePort: 8097,
            hostPort: 8097,
            portReverseName: 'react-devtools',
          },
          session: ctx.effectiveFlags.session ?? ctx.sessionName,
        },
        transport: deps.sendToDaemon,
        transportOptions: { authToken: daemonAuthToken },
      });
      if (!response.ok) throwDaemonError(response.error);
    },
  });
}

async function resolveRemoteContext(ctx: CliRunContext, deps: CliDeps): Promise<void> {
  if (ctx.command === 'batch') {
    if (ctx.positionals.length > 0) {
      throw new AppError('INVALID_ARGS', 'batch does not accept positional arguments.');
    }
    ctx.parsedBatchSteps = readBatchSteps(ctx.flags);
  }

  if (shouldResolveRemoteAuth(ctx.command)) {
    const authResolution = await resolveRemoteAuthForCli({
      command: ctx.command,
      flags: ctx.effectiveFlags,
      stateDir: ctx.daemonPaths.baseDir,
      env: process.env,
    });
    ctx.effectiveFlags = authResolution.flags;
  }

  if (ctx.effectiveFlags.remoteConfig && shouldMaterializeRemoteConnection(ctx.command)) {
    const materializationClient = createAgentDeviceClient(buildClientConfig(ctx), {
      transport: createClientDaemonTransport(deps.sendToDaemon),
    });
    const materialized = await materializeRemoteConnectionForCommand({
      command: ctx.command,
      flags: ctx.effectiveFlags,
      client: materializationClient,
      runtime: ctx.resolvedRuntime,
      positionals: ctx.positionals,
      batchSteps: ctx.parsedBatchSteps,
      forceRuntimePrepare: hasExplicitMetroRuntimeOverrides(ctx.explicitFlagKeys),
    });
    ctx.effectiveFlags = materialized.flags;
    ctx.resolvedRuntime = materialized.runtime;
    ctx.connectionMetadata = materialized.connection;
  }
  if (
    shouldWarnOpenMayMissRemoteRuntime({
      command: ctx.command,
      flags: ctx.effectiveFlags,
      runtime: ctx.resolvedRuntime,
      explicitFlagKeys: ctx.explicitFlagKeys,
      hadConnectionDefaults: Boolean(ctx.connectionDefaults),
    })
  ) {
    process.stderr.write(
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
    providerProject: currentFlags.providerProject,
    providerBuild: currentFlags.providerBuild,
    providerSessionName: currentFlags.providerSessionName,
    providerDeviceOrientation: currentFlags.providerDeviceOrientation,
    providerGeoLocation: currentFlags.providerGeoLocation,
    providerTimezone: currentFlags.providerTimezone,
    providerLanguage: currentFlags.providerLanguage,
    providerLocale: currentFlags.providerLocale,
    providerNetworkProfile: currentFlags.providerNetworkProfile,
    providerCustomNetwork: currentFlags.providerCustomNetwork,
    providerNoResignApp: currentFlags.providerNoResignApp,
    awsProjectArn: currentFlags.awsProjectArn,
    awsDeviceArn: currentFlags.awsDeviceArn,
    awsAppArn: currentFlags.awsAppArn,
    awsRegion: currentFlags.awsRegion,
    awsInteractionMode: currentFlags.awsInteractionMode,
    runtime: ctx.resolvedRuntime,
    lockPolicy: ctx.binding.lockPolicy,
    lockPlatform: ctx.binding.defaultPlatform,
    cwd: process.cwd(),
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
  const { createReplayTestReporterRuntime } = await import('./replay/test/reporting.ts');
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
              policyOverrides: effectiveFlags,
              configuredPlatform: effectiveFlags.platform,
              configuredSession: effectiveFlags.session,
              inheritedPlatform: effectiveFlags.platform,
            }),
    }));
    if (
      await tryRunClientBackedCommand({
        command,
        positionals,
        flags: { ...effectiveFlags, batchSteps },
        client,
        debug: ctx.debugOutputEnabled,
        replayTestReporterRuntime,
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
      command,
      positionals,
      flags: effectiveFlags,
      client,
      debug: ctx.debugOutputEnabled,
      replayTestReporterRuntime,
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
      printJson({ success: true, data: { closed: 'session', source: 'no-daemon' } });
    }
    return;
  }
  if (ctx.effectiveFlags.json) {
    printJson({
      success: false,
      error: normalized,
    });
  } else {
    printHumanError(normalized, { showDetails: ctx.debugOutputEnabled });
    if (ctx.debugOutputEnabled) {
      printFailureLogTail(ctx, normalized);
    }
  }
  if (logTailStopper) logTailStopper();
  // #1596: a bare `process.exit()` right after these writes can drop them —
  // Node flushes stdout/stderr synchronously only to a file or TTY, and this
  // CLI is commonly piped by whatever is driving it. `exitAfterFlush` waits
  // for the writes above to actually reach the pipe first.
  await exitAfterFlush(1);
}

const DAEMON_LOG_TAIL_MAX_BYTES = 64_000;

/**
 * The evidence `--debug` puts inline in the caller's own log after a failure.
 *
 * For a LOCAL daemon that is the daemon log this process can read. For a REMOTE
 * one that file belongs to another machine (the same reason
 * `maybeStartDaemonLogTail` does not follow it), so the tail comes from the
 * request record fetched to this host instead — which is what makes a CI job's
 * transcript carry the evidence without a second round trip (#1801).
 */
function printFailureLogTail(ctx: CliRunContext, normalized: NormalizedError): void {
  if (!ctx.effectiveFlags.daemonBaseUrl) {
    printLogFileTail('daemon log', ctx.daemonPaths.logPath);
    return;
  }
  const record = normalized.diagnosticsRecord;
  if (!record) return;
  // Recomputed from the locator through the same helper that wrote the copy, so
  // the tail can only ever come from the fetched record (absent when the fetch
  // failed, since nothing was written).
  printLogFileTail(
    'remote diagnostics',
    resolveRemoteRequestDiagnosticsPath(ctx.daemonPaths.baseDir, record),
  );
}

function printLogFileTail(label: string, logPath: string): void {
  try {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n');
      let tail = lines.slice(Math.max(0, lines.length - 200)).join('\n');
      if (tail.length > DAEMON_LOG_TAIL_MAX_BYTES) {
        tail = tail.slice(tail.length - DAEMON_LOG_TAIL_MAX_BYTES);
      }
      if (tail.trim().length > 0) {
        process.stderr.write(`\n[${label}]\n${tail}\n`);
      }
    }
  } catch {}
}

function isDebugRequested(argv: string[]): boolean {
  try {
    const parsed = parseRawArgs(argv);
    return isParsedDebugRequested(parsed.command ?? '', parsed.providedFlags);
  } catch {
    return argv.includes('--debug') || argv.includes('-v') || argv.includes('--verbose');
  }
}

function formatUnknownHelpTargetMessage(helpTarget: string): string {
  const hint = suggestCommandFor(helpTarget);
  return hint
    ? `Unknown command: ${helpTarget}. Did you mean ${hint}?`
    : `Unknown command: ${helpTarget}`;
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

function resolveActiveConnectionDefaults(options: {
  command: string;
  explicitFlagKeys: Set<FlagKey>;
  stateDir: string;
  session: string;
  remoteConfig?: string;
  hasResolvedSession: boolean;
}): {
  flags: Partial<CliFlags>;
  runtime?: SessionRuntimeHints;
  connection?: RemoteConnectionRequestMetadata;
} | null {
  if (
    options.command === 'connect' ||
    options.command === 'connection' ||
    options.command === 'daemon' ||
    options.command === 'proxy'
  ) {
    return null;
  }
  const defaults = resolveRemoteConnectionDefaults({
    stateDir: options.stateDir,
    session: options.session,
    remoteConfig: options.remoteConfig,
    cwd: process.cwd(),
    env: process.env,
    allowActiveFallback:
      !options.explicitFlagKeys.has('session') &&
      (!options.remoteConfig || options.command === 'disconnect' || !options.hasResolvedSession),
    validateRemoteConfigHash: options.command !== 'disconnect',
  });
  return defaults;
}

function shouldMaterializeRemoteConnection(command: string): boolean {
  return !REMOTE_MATERIALIZATION_DEFERRED_COMMANDS.has(command);
}

function shouldResolveRemoteAuth(command: string): boolean {
  return (
    command !== 'auth' &&
    command !== 'connection' &&
    command !== 'daemon' &&
    command !== 'device' &&
    command !== 'proxy'
  );
}

function shouldWarnOpenMayMissRemoteRuntime(options: {
  command: string;
  flags: CliFlags;
  runtime?: SessionRuntimeHints;
  explicitFlagKeys: Set<FlagKey>;
  hadConnectionDefaults: boolean;
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

function mergeConnectionFlags(
  flags: CliFlags,
  defaults: Partial<CliFlags>,
  explicitFlagKeys: Set<FlagKey>,
): CliFlags {
  const merged = { ...flags };
  for (const [key, value] of Object.entries(defaults) as Array<[FlagKey, unknown]>) {
    if (value === undefined) continue;
    if (explicitFlagKeys.has(key)) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

function hasExplicitMetroRuntimeOverrides(explicitFlagKeys: Set<FlagKey>): boolean {
  for (const key of METRO_RUNTIME_OVERRIDE_FLAG_KEYS) {
    if (explicitFlagKeys.has(key)) {
      return true;
    }
  }
  return false;
}

function createCliDaemonTransport(options: {
  command: string;
  flags: CliFlags;
  replayTestReporterRuntime?: ReplayTestReporterRuntime;
  transport: CliDaemonTransport;
}): AgentDeviceDaemonTransport {
  const { command, flags, replayTestReporterRuntime, transport } = options;
  if (flags.json) return createClientDaemonTransport(transport);
  return async (req, context) => {
    const transportOptions =
      command === 'test' && replayTestReporterRuntime
        ? { ...context, onProgress: replayTestReporterRuntime.onProgress }
        : context;
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
  runCli(process.argv.slice(2)).catch(async (err) => {
    const appErr = asAppError(err);
    printHumanError(normalizeError(appErr), { showDetails: true });
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
            process.stdout.write(buffer.toString('utf8'));
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
