import { runCmdStreaming } from '../../utils/exec.ts';
import {
  ensureReactDevtoolsCompanion,
  stopReactDevtoolsCompanion,
} from '../../client/client-react-devtools-companion.ts';
import { AppError } from '../../kernel/errors.ts';
import { isRemoteBridgeBackend } from './remote-bridge.ts';
import type { CliFlags } from '../../commands/cli-grammar/flag-types.ts';

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
    flags.leaseProvider === 'limrun' &&
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
