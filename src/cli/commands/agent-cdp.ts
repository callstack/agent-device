import { runCmdStreaming } from '../../utils/exec.ts';
import { AppError } from '../../utils/errors.ts';
import { isRemoteBridgeBackend } from './remote-bridge.ts';
import type { SessionRuntimeHints } from '../../contracts.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';

const AGENT_CDP_VERSION = '1.6.0';
export const AGENT_CDP_PACKAGE = `agent-cdp@${AGENT_CDP_VERSION}`;
const AGENT_CDP_BIN = 'agent-cdp';

type AgentCdpCommandOptions = {
  flags?: Pick<
    CliFlags,
    | 'leaseBackend'
    | 'leaseId'
    | 'metroProxyBaseUrl'
    | 'metroPublicBaseUrl'
    | 'runId'
    | 'session'
    | 'tenant'
  >;
  runtime?: SessionRuntimeHints;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function buildAgentCdpNpmExecArgs(args: string[]): string[] {
  return ['exec', '--yes', '--package', AGENT_CDP_PACKAGE, '--', AGENT_CDP_BIN, ...args];
}

function hasExplicitUrl(args: string[]): boolean {
  return args.some((arg) => arg === '--url' || arg.startsWith('--url='));
}

export function shouldAgentCdpUseRemoteBridgeUrl(args: string[]): boolean {
  return (
    args[0] === 'target' && (args[1] === 'list' || args[1] === 'select') && !hasExplicitUrl(args)
  );
}

function normalizeCdpBaseUrl(value: string): string {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/index.bundle')
    ? pathname.slice(0, -'/index.bundle'.length) || '/'
    : pathname || '/';
  return url.toString().replace(/\/+$/, '');
}

function resolveRemoteBridgeCdpUrl(flags: AgentCdpCommandOptions['flags']): string | null {
  const publicBaseUrl = flags?.metroPublicBaseUrl?.trim();
  if (publicBaseUrl) {
    return normalizeCdpBaseUrl(publicBaseUrl);
  }
  return null;
}

export function buildAgentCdpPassthroughArgs(
  args: string[],
  options: Pick<AgentCdpCommandOptions, 'flags' | 'runtime'> = {},
): string[] {
  if (!shouldAgentCdpUseRemoteBridgeUrl(args)) return args;
  if (!options.flags?.metroProxyBaseUrl || !isRemoteBridgeBackend(options.flags.leaseBackend)) {
    return args;
  }
  const cdpUrl = resolveRemoteBridgeCdpUrl(options.flags);
  if (!cdpUrl) {
    throw new AppError(
      'INVALID_ARGS',
      'cdp remote bridge target discovery requires a Metro public base URL.',
      {
        hint: 'Include metroPublicBaseUrl in the remote config so cdp can reach the local or tunneled Metro CDP endpoint without bridge proxy authentication.',
      },
    );
  }
  return [...args, '--url', cdpUrl];
}

export async function runAgentCdpCommand(
  args: string[],
  options: AgentCdpCommandOptions = {},
): Promise<number> {
  const passthroughArgs = buildAgentCdpPassthroughArgs(args, options);
  const result = await runCmdStreaming('npm', buildAgentCdpNpmExecArgs(passthroughArgs), {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    allowFailure: true,
    onStdoutChunk: (chunk) => {
      process.stdout.write(chunk);
    },
    onStderrChunk: (chunk) => {
      process.stderr.write(chunk);
    },
  });
  return result.exitCode;
}
