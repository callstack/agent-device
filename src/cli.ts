import { parseRawArgs, usage, usageForCommand } from './cli/parser/args.ts';
import { suggestCommandFor } from './cli/parser/command-suggestions.ts';
import { asAppError, AppError, normalizeError } from './kernel/errors.ts';
import { throwDaemonError } from './daemon-error.ts';
import { printHumanError, printJson } from './utils/output.ts';
import { readVersion } from './utils/version.ts';
import { pathToFileURL } from 'node:url';
import { sendToDaemon } from './daemon/client/daemon-client.ts';
import fs from 'node:fs';
import type { BatchStep } from './client/client-types.ts';
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
  withDiagnosticsScope,
} from './utils/diagnostics.ts';
import { resolveDaemonPaths } from './daemon/config.ts';
import { applyDefaultPlatformBinding, resolveBindingSettings } from './utils/session-binding.ts';
import { resolveCliOptions } from './utils/cli-options.ts';
import { maybeRunUpgradeNotifier } from './utils/update-check.ts';
import {
  resolveRemoteConnectionDefaults,
  type RemoteConnectionRequestMetadata,
} from './remote/remote-connection-state.ts';
import { resolveRemoteAuthForCli } from './cli/auth-session.ts';
import type { CliFlags, FlagKey } from './commands/cli-grammar/flag-types.ts';
import type { SessionRuntimeHints } from './kernel/contracts.ts';
import { INTERNAL_COMMANDS, isKnownCliCommandName } from './command-catalog.ts';

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
      const ctx = resolveRunContextOrExit(parsed, {
        command,
        positionals,
        requestId,
        debugOutputEnabled,
      });
      let logTailStopper: (() => void) | null = null;
      try {
        if (command === 'react-devtools') {
          process.exit(await runReactDevtoolsCli(ctx, deps));
          return;
        }
        if (command === 'web') {
          process.exit(
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
        if (command === 'cdp') {
          process.exit(
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
        handleRunCliFailure(err, ctx, logTailStopper);
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
      logPath: flushDiagnosticsToSessionFile({ force: true }) ?? undefined,
    });
    if (options.jsonRequested) {
      printJson({ success: false, error: normalized });
    } else {
      printHumanError(normalized, { showDetails: options.debugEnabled });
    }
    process.exit(1);
  }

  for (const warning of parsed.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }

  if (parsed.flags.version) {
    process.stdout.write(`${options.version}\n`);
    process.exit(0);
  }

  const isHelpAlias = parsed.command === 'help';
  const isHelpFlag = parsed.flags.help;
  if (isHelpAlias || isHelpFlag) {
    if (isHelpAlias && parsed.positionals.length > 1) {
      printHumanError(new AppError('INVALID_ARGS', 'help accepts at most one command.'));
      process.exit(1);
    }
    const helpTarget = isHelpAlias ? parsed.positionals[0] : parsed.command;
    if (!helpTarget) {
      process.stdout.write(`${await usage()}\n`);
      process.exit(0);
    }
    const commandHelp = await usageForCommand(helpTarget);
    if (commandHelp) {
      process.stdout.write(commandHelp);
      process.exit(0);
    }
    printHumanError(new AppError('INVALID_ARGS', formatUnknownHelpTargetMessage(helpTarget)));
    process.stdout.write(`${await usage()}\n`);
    process.exit(1);
  }

  if (!parsed.command) {
    process.stdout.write(`${await usage()}\n`);
    process.exit(1);
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

function resolveRunContextOrExit(
  parsed: ReturnType<typeof resolveCliOptions>,
  base: { command: string; positionals: string[]; requestId: string; debugOutputEnabled: boolean },
): CliRunContext {
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
      logPath: flushDiagnosticsToSessionFile({ force: true }) ?? undefined,
    });
    if (parsed.flags.json) {
      printJson({ success: false, error: normalized });
    } else {
      printHumanError(normalized, { showDetails: base.debugOutputEnabled });
    }
    process.exit(1);
  }
}

async function runReactDevtoolsCli(ctx: CliRunContext, deps: CliDeps): Promise<number> {
  return await runReactDevtoolsCommand(ctx.positionals, {
    flags: {
      ...ctx.effectiveFlags,
      leaseProvider: ctx.connectionDefaults?.connection?.leaseProvider,
    },
    stateDir: ctx.daemonPaths.baseDir,
    session: ctx.effectiveFlags.session ?? ctx.sessionName,
    cwd: process.cwd(),
    env: process.env,
    configureDirectPortReverse: async () => {
      const response = await deps.sendToDaemon({
        command: INTERNAL_COMMANDS.runtime,
        positionals: ['port-reverse'],
        flags: {
          ...ctx.effectiveFlags,
          leaseProvider: ctx.connectionDefaults?.connection?.leaseProvider,
          devicePort: 8097,
          hostPort: 8097,
          portReverseName: 'react-devtools',
        },
        session: ctx.effectiveFlags.session ?? ctx.sessionName,
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

function handleRunCliFailure(
  err: unknown,
  ctx: CliRunContext,
  logTailStopper: (() => void) | null,
): void {
  const appErr = asAppError(err);
  const normalized = normalizeError(appErr, {
    diagnosticId: getDiagnosticsMeta().diagnosticId,
    logPath: flushDiagnosticsToSessionFile({ force: true }) ?? undefined,
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
      printDaemonLogTailOnError(ctx.daemonPaths.logPath);
    }
  }
  if (logTailStopper) logTailStopper();
  process.exit(1);
}

function printDaemonLogTailOnError(logPath: string): void {
  try {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n');
      const tail = lines.slice(Math.max(0, lines.length - 200)).join('\n');
      if (tail.trim().length > 0) {
        process.stderr.write(`\n[daemon log]\n${tail}\n`);
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
  return async (req) =>
    await sendClientRequestToCliTransport(
      transport,
      {
        ...req,
        meta: {
          ...req.meta,
          requestProgress: command === 'test' ? 'replay-test' : 'command',
        },
      },
      command === 'test' && replayTestReporterRuntime
        ? { onProgress: replayTestReporterRuntime.onProgress }
        : undefined,
    );
}

function createClientDaemonTransport(transport: CliDaemonTransport): AgentDeviceDaemonTransport {
  return async (req) => await sendClientRequestToCliTransport(transport, req);
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
  runCli(process.argv.slice(2)).catch((err) => {
    const appErr = asAppError(err);
    printHumanError(normalizeError(appErr), { showDetails: true });
    process.exit(1);
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
