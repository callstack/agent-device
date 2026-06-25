import { runCmdStreaming } from '../../utils/exec.ts';

const AGENT_CDP_VERSION = '1.6.0';
export const AGENT_CDP_PACKAGE = `agent-cdp@${AGENT_CDP_VERSION}`;
const AGENT_CDP_BIN = 'agent-cdp';

type AgentCdpCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function buildAgentCdpNpmExecArgs(args: string[]): string[] {
  return ['exec', '--yes', '--package', AGENT_CDP_PACKAGE, '--', AGENT_CDP_BIN, ...args];
}

export async function runAgentCdpCommand(
  args: string[],
  options: AgentCdpCommandOptions = {},
): Promise<number> {
  const result = await runCmdStreaming('npm', buildAgentCdpNpmExecArgs(args), {
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
