import { parseRawArgs, usage, usageForCommand } from './utils/args.ts';
import { asAppError, AppError, normalizeError } from './kernel/errors.ts';
import { printHumanError, printJson } from './utils/output.ts';
import { readVersion } from './utils/version.ts';
import { pathToFileURL } from 'node:url';
import { sendToDaemon } from './daemon-client.ts';
import fs from 'node:fs';
import type { BatchStep } from './client-types.ts';
import {
  createAgentDeviceClient,
  type AgentDeviceClientConfig,
  type AgentDeviceDaemonTransport,
} from './client.ts';
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
import type { CliFlags, FlagKey } from './utils/cli-flags.ts';
import type { SessionRuntimeHints } from './kernel/contracts.ts';

type CliDeps = {
  sendToDaemon: typeof sendToDaemon;
};

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
        if (jsonRequested) {
          printJson({ success: false, error: normalized });
        } else {
          printHumanError(normalized, { showDetails: debugEnabled });
        }
        process.exit(1);
        return;
      }

      for (const warning of parsed.warnings) {
        process.stderr.write(`Warning: ${warning}\n`);
      }

      if (parsed.flags.version) {
        process.stdout.write(`${version}\n`);
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
          process.stdout.write(`${usage()}\n`);
          process.exit(0);
        }
        const commandHelp = usageForCommand(helpTarget);
        if (commandHelp) {
          process.stdout.write(commandHelp);
          process.exit(0);
        }
        printHumanError(new AppError('INVALID_ARGS', `Unknown command: ${helpTarget}`));
        process.stdout.write(`${usage()}\n`);
        process.exit(1);
      }

      if (!parsed.command) {
        process.stdout.write(`${usage()}\n`);
        process.exit(1);
      }

      const { command, positionals } = parsed;
      const debugOutputEnabled = isParsedDebugRequested(command, parsed.providedFlags);
      let binding: ReturnType<typeof resolveBindingSettings>;
      let flags: typeof parsed.flags;
      let daemonPaths: ReturnType<typeof resolveDaemonPaths>;
      let sessionName: string;
      let connectionDefaults: ReturnType<typeof resolveActiveConnectionDefaults>;
      let effectiveFlags: typeof parsed.flags;
      const explicitFlagKeys = new Set(parsed.providedFlags.map((entry) => entry.key));
      try {
        binding = resolveBindingSettings({
          policyOverrides: parsed.flags,
          configuredPlatform: parsed.flags.platform,
          configuredSession: parsed.flags.session,
        });
        flags = binding.lockPolicy
          ? { ...parsed.flags }
          : applyDefaultPlatformBinding(parsed.flags, {
              policyOverrides: parsed.flags,
              configuredPlatform: parsed.flags.platform,
              configuredSession: parsed.flags.session,
            });
        daemonPaths = resolveDaemonPaths(flags.stateDir);
        sessionName = flags.session ?? 'default';
        connectionDefaults = resolveActiveConnectionDefaults({
          command,
          explicitFlagKeys,
          stateDir: daemonPaths.baseDir,
          session: sessionName,
          remoteConfig: flags.remoteConfig,
          hasResolvedSession: flags.session !== undefined,
        });
        effectiveFlags = connectionDefaults
          ? mergeConnectionFlags(flags, connectionDefaults.flags, explicitFlagKeys)
          : flags;
      } catch (err) {
        const appErr = asAppError(err);
        const normalized = normalizeError(appErr, {
          diagnosticId: getDiagnosticsMeta().diagnosticId,
          logPath: flushDiagnosticsToSessionFile({ force: true }) ?? undefined,
        });
        if (parsed.flags.json) {
          printJson({ success: false, error: normalized });
        } else {
          printHumanError(normalized, { showDetails: debugOutputEnabled });
        }
        process.exit(1);
        return;
      }
      let logTailStopper: (() => void) | null = null;
      try {
        if (command === 'react-devtools') {
          const exitCode = await runReactDevtoolsCommand(positionals, {
            flags: effectiveFlags,
            stateDir: daemonPaths.baseDir,
            session: effectiveFlags.session ?? sessionName,
            cwd: process.cwd(),
            env: process.env,
          });
          process.exit(exitCode);
          return;
        }
        if (command === 'web') {
          const exitCode = await runWebCommand(positionals, {
            flags: effectiveFlags,
            stateDir: daemonPaths.baseDir,
          });
          process.exit(exitCode);
          return;
        }
        maybeRunUpgradeNotifier({
          command,
          currentVersion: version,
          stateDir: daemonPaths.baseDir,
          flags: effectiveFlags,
        });
        let resolvedRuntime = connectionDefaults?.runtime;
        let connectionMetadata = connectionDefaults?.connection;
        const buildClientConfig = (
          currentFlags: CliFlags,
          runtime: SessionRuntimeHints | undefined,
          connection: RemoteConnectionRequestMetadata | undefined,
        ): AgentDeviceClientConfig => ({
          session: currentFlags.session,
          requestId,
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
          runtime,
          lockPolicy: binding.lockPolicy,
          lockPlatform: binding.defaultPlatform,
          cwd: process.cwd(),
          debug: debugOutputEnabled,
          cost: currentFlags.cost,
          responseLevel: currentFlags.responseLevel,
        });
        let parsedBatchSteps: BatchStep[] | undefined;
        if (command === 'batch') {
          if (positionals.length > 0) {
            throw new AppError('INVALID_ARGS', 'batch does not accept positional arguments.');
          }
          parsedBatchSteps = readBatchSteps(flags);
        }

        if (shouldResolveRemoteAuth(command)) {
          const authResolution = await resolveRemoteAuthForCli({
            command,
            flags: effectiveFlags,
            stateDir: daemonPaths.baseDir,
            env: process.env,
          });
          effectiveFlags = authResolution.flags;
        }

        if (effectiveFlags.remoteConfig && shouldMaterializeRemoteConnection(command)) {
          const materializationClient = createAgentDeviceClient(
            buildClientConfig(effectiveFlags, resolvedRuntime, connectionMetadata),
            {
              transport: deps.sendToDaemon as AgentDeviceDaemonTransport,
            },
          );
          const materialized = await materializeRemoteConnectionForCommand({
            command,
            flags: effectiveFlags,
            client: materializationClient,
            runtime: resolvedRuntime,
            positionals,
            batchSteps: parsedBatchSteps,
            forceRuntimePrepare: hasExplicitMetroRuntimeOverrides(explicitFlagKeys),
          });
          effectiveFlags = materialized.flags;
          resolvedRuntime = materialized.runtime;
          connectionMetadata = materialized.connection;
        }
        if (
          shouldWarnOpenMayMissRemoteRuntime({
            command,
            flags: effectiveFlags,
            runtime: resolvedRuntime,
            explicitFlagKeys,
            hadConnectionDefaults: Boolean(connectionDefaults),
          })
        ) {
          process.stderr.write(
            'Warning: open is using explicit remote daemon or tenant flags without saved Metro runtime hints. React Native apps may launch without bundle/runtime hints; prefer connect --remote-config <path> first or pass --remote-config <path> on this command.\n',
          );
        }
        if (command === 'cdp') {
          const exitCode = await runAgentCdpCommand(positionals, {
            flags: effectiveFlags,
            runtime: resolvedRuntime,
            cwd: process.cwd(),
            env: process.env,
          });
          process.exit(exitCode);
          return;
        }
        const remoteDaemonBaseUrl = effectiveFlags.daemonBaseUrl;
        logTailStopper =
          debugOutputEnabled && !effectiveFlags.json && !remoteDaemonBaseUrl
            ? startDaemonLogTail(daemonPaths.logPath)
            : null;
        const client = createAgentDeviceClient(
          buildClientConfig(effectiveFlags, resolvedRuntime, connectionMetadata),
          {
            transport: createCliDaemonTransport({
              command,
              flags: effectiveFlags,
              transport: deps.sendToDaemon as AgentDeviceDaemonTransport,
            }),
          },
        );
        if (command === 'batch') {
          if (!parsedBatchSteps) {
            throw new AppError('INVALID_ARGS', 'batch requires --steps or --steps-file.');
          }
          const batchSteps = parsedBatchSteps.map((step, _index) => ({
            ...step,
            input:
              binding.lockPolicy && flags.platform === undefined
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
              debug: debugOutputEnabled,
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
            debug: debugOutputEnabled,
          })
        ) {
          return;
        }

        throw new AppError('INVALID_ARGS', `Unknown command: ${command}`);
      } catch (err) {
        const appErr = asAppError(err);
        const normalized = normalizeError(appErr, {
          diagnosticId: getDiagnosticsMeta().diagnosticId,
          logPath: flushDiagnosticsToSessionFile({ force: true }) ?? undefined,
        });
        if (command === 'close' && isDaemonStartupFailure(appErr)) {
          if (effectiveFlags.json) {
            printJson({ success: true, data: { closed: 'session', source: 'no-daemon' } });
          }
          return;
        }
        if (effectiveFlags.json) {
          printJson({
            success: false,
            error: normalized,
          });
        } else {
          printHumanError(normalized, { showDetails: debugOutputEnabled });
          if (debugOutputEnabled) {
            try {
              const logPath = daemonPaths.logPath;
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
        }
        if (logTailStopper) logTailStopper();
        process.exit(1);
      } finally {
        if (logTailStopper) logTailStopper();
      }
    },
  );
}

function isDebugRequested(argv: string[]): boolean {
  try {
    const parsed = parseRawArgs(argv);
    return isParsedDebugRequested(parsed.command ?? '', parsed.providedFlags);
  } catch {
    return argv.includes('--debug') || argv.includes('-v') || argv.includes('--verbose');
  }
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
  return command !== 'auth' && command !== 'connection' && command !== 'proxy';
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
  transport: AgentDeviceDaemonTransport;
}): AgentDeviceDaemonTransport {
  const { command, flags, transport } = options;
  if (flags.json) return transport;
  return async (req) =>
    await transport({
      ...req,
      meta: {
        ...req.meta,
        requestProgress: command === 'test' ? 'replay-test' : 'command',
      },
    });
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
