import { runCmdStreaming } from '@agent-device/host-kit/command';
import {
  ensureReactDevtoolsCompanion,
  stopReactDevtoolsCompanion,
} from '../../client/client-react-devtools-companion.ts';
import { AppError } from '@agent-device/kernel/errors';
import { isRemoteBridgeBackend } from './remote-bridge.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import { connectionProviderCapabilities } from '../connection/provider-policy.ts';

const AGENT_REACT_DEVTOOLS_VERSION = '0.4.0';
export const AGENT_REACT_DEVTOOLS_PACKAGE = `agent-react-devtools@${AGENT_REACT_DEVTOOLS_VERSION}`;
const AGENT_REACT_DEVTOOLS_BIN = 'agent-react-devtools';

type ReactDevtoolsFlags = Pick<
  CliFlags,
  | 'leaseBackend'
  | 'metroProxyBaseUrl'
  | 'metroBearerToken'
  | 'tenant'
  | 'runId'
  | 'leaseId'
  | 'remoteConfig'
  | 'session'
> & {
  leaseProvider?: string;
};

type ReactDevtoolsCommandOptions = {
  flags?: ReactDevtoolsFlags;
  stateDir?: string;
  session?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configureDirectPortReverse?: () => Promise<void>;
};

type RemoteBridgeConfig = {
  serverBaseUrl: string;
  bearerToken: string;
  tenantId: string;
  runId: string;
  leaseId: string;
};

export function buildReactDevtoolsNpmExecArgs(args: string[]): string[] {
  return [
    'exec',
    '--yes',
    '--package',
    AGENT_REACT_DEVTOOLS_PACKAGE,
    '--',
    AGENT_REACT_DEVTOOLS_BIN,
    ...args,
  ];
}

/**
 * Subcommands that answer a question about an attached app's React tree. The
 * passthrough starts a daemon on demand and answers them from its empty tree,
 * so `errors` reports the same "nothing found" as a healthy app with nothing
 * wrong. Gating them on attachment keeps a failed observation from reading as
 * a negative one.
 */
const COMPONENT_READ_COMMANDS = new Set(['errors', 'find', 'count', 'get']);

// The pinned passthrough has no machine-readable status, so the connected-app
// count is read off its `status` rendering. A status the probe cannot parse
// means unknown and lets the read through; a status it cannot obtain means no
// daemon is reachable, which no component read can observe around.
const CONNECTED_APPS_PATTERN = /^Apps: (\d+) connected/m;

type Attachment = number | 'no-daemon' | 'unknown';

async function readAttachment(cwd: string, env: NodeJS.ProcessEnv): Promise<Attachment> {
  const result = await runCmdStreaming('npm', buildReactDevtoolsNpmExecArgs(['status']), {
    cwd,
    env,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return 'no-daemon';
  const match = CONNECTED_APPS_PATTERN.exec(result.stdout);
  return match ? Number(match[1]) : 'unknown';
}

async function assertComponentReadCanObserve(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const subcommand = args[0] ?? '';
  if (!COMPONENT_READ_COMMANDS.has(subcommand)) return;
  const attachment = await readAttachment(cwd, env);
  if (attachment === 'unknown') return;
  if (typeof attachment === 'number' && attachment > 0) return;
  throw new AppError(
    'COMMAND_FAILED',
    `react-devtools ${subcommand} observed nothing: ${
      attachment === 'no-daemon'
        ? 'the React DevTools daemon is not running'
        : 'the React DevTools daemon has 0 apps connected'
    }.`,
    {
      subcommand,
      connectedApps: attachment === 'no-daemon' ? null : attachment,
      hint: 'Attach an app first: `agent-device react-devtools wait --connected` blocks until one connects or reconnects. If none ever attaches, run `agent-device react-devtools start` and launch or relaunch the app.',
    },
  );
}

function isRemoteIosBridgeBackend(leaseBackend: CliFlags['leaseBackend']): boolean {
  return leaseBackend === 'ios-instance';
}

function isWaitConnectedCommand(args: string[]): boolean {
  return args[0] === 'wait' && args.includes('--connected');
}

function maybePrintRemoteIosWaitHint(
  args: string[],
  flags: ReactDevtoolsCommandOptions['flags'],
  exitCode: number,
): void {
  if (
    exitCode === 0 ||
    !isWaitConnectedCommand(args) ||
    !isRemoteIosBridgeBackend(flags?.leaseBackend)
  ) {
    return;
  }
  process.stderr.write(
    [
      'Hint: Remote iOS React DevTools connects during JavaScript startup.',
      'If the app was already open before `agent-device react-devtools start`, relaunch it with `agent-device open <bundle-id> --platform ios --relaunch`, then retry `agent-device react-devtools wait --connected`.',
      '',
    ].join('\n'),
  );
}

function readRemoteBridgeField(
  missing: string[],
  field: string,
  value: string | undefined,
): string {
  if (value) return value;
  missing.push(field);
  return '';
}

function resolveRemoteBridgeConfig(
  flags: ReactDevtoolsCommandOptions['flags'],
): RemoteBridgeConfig | null {
  if (!flags?.metroProxyBaseUrl || !isRemoteBridgeBackend(flags.leaseBackend)) return null;
  const missing: string[] = [];
  const config = {
    serverBaseUrl: readRemoteBridgeField(missing, 'metroProxyBaseUrl', flags.metroProxyBaseUrl),
    bearerToken: readRemoteBridgeField(missing, 'metroBearerToken', flags.metroBearerToken),
    tenantId: readRemoteBridgeField(missing, 'tenant', flags.tenant),
    runId: readRemoteBridgeField(missing, 'runId', flags.runId),
    leaseId: readRemoteBridgeField(missing, 'leaseId', flags.leaseId),
  };
  if (missing.length > 0) {
    throw new AppError(
      'INVALID_ARGS',
      `react-devtools remote bridge requires ${missing.join(', ')}.`,
      { missing },
    );
  }
  return config;
}

async function withRemoteDevtoolsCompanion<T>(
  args: string[],
  options: ReactDevtoolsCommandOptions,
  action: () => Promise<T>,
): Promise<T> {
  const { flags } = options;
  const bridgeConfig = resolveRemoteBridgeConfig(flags);
  if (!bridgeConfig) return action();

  const stateDir = options.stateDir ?? process.cwd();
  const session = options.session ?? flags?.session ?? 'default';
  const profileKey =
    flags?.remoteConfig ?? `${bridgeConfig.tenantId}:${bridgeConfig.runId}:${bridgeConfig.leaseId}`;

  if (args[0] === 'stop') {
    try {
      return await action();
    } finally {
      await stopReactDevtoolsCompanion({
        projectRoot: options.cwd ?? process.cwd(),
        stateDir,
        profileKey,
        consumerKey: session,
      });
    }
  }

  await ensureReactDevtoolsCompanion({
    projectRoot: options.cwd ?? process.cwd(),
    stateDir,
    serverBaseUrl: bridgeConfig.serverBaseUrl,
    bearerToken: bridgeConfig.bearerToken,
    bridgeScope: {
      tenantId: bridgeConfig.tenantId,
      runId: bridgeConfig.runId,
      leaseId: bridgeConfig.leaseId,
    },
    session,
    profileKey,
    consumerKey: session,
    env: options.env ?? process.env,
  });
  return await action();
}

function shouldConfigureDirectReverse(
  args: string[],
  options: ReactDevtoolsCommandOptions,
): boolean {
  if (args[0] !== 'start') return false;
  const { flags } = options;
  if (!flags) return false;
  return (
    connectionProviderCapabilities(flags.leaseProvider).supportsDirectPortReverse &&
    flags.leaseBackend === 'android-instance' &&
    flags.metroProxyBaseUrl === undefined &&
    options.configureDirectPortReverse !== undefined
  );
}

export async function runReactDevtoolsCommand(
  args: string[],
  options: ReactDevtoolsCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const exitCode = await withRemoteDevtoolsCompanion(args, options, async () => {
    if (shouldConfigureDirectReverse(args, options)) {
      await options.configureDirectPortReverse?.();
    }
    await assertComponentReadCanObserve(args, cwd, env);
    const result = await runCmdStreaming('npm', buildReactDevtoolsNpmExecArgs(args), {
      cwd,
      env,
      allowFailure: true,
      onStdoutChunk: (chunk) => {
        process.stdout.write(chunk);
      },
      onStderrChunk: (chunk) => {
        process.stderr.write(chunk);
      },
    });
    return result.exitCode;
  });
  maybePrintRemoteIosWaitHint(args, options.flags, exitCode);
  return exitCode;
}
