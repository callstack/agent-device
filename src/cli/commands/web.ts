import {
  doctorManagedAgentBrowser,
  setupManagedAgentBrowser,
  type AgentBrowserToolStatus,
} from '../../platforms/web/agent-browser-tool.ts';
import { AppError } from '../../kernel/errors.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import { printJson } from '../../utils/output.ts';

type PublicAgentBrowserToolStatus = Omit<AgentBrowserToolStatus, 'socketDir'>;

export async function runWebCommand(
  positionals: string[],
  options: { flags: CliFlags; stateDir: string },
): Promise<number> {
  const action = positionals[0];
  switch (action) {
    case 'setup': {
      printWebSetupStart(options.flags.json);
      const status = await setupManagedAgentBrowser({
        stateDir: options.stateDir,
      });
      printWebSetupResult(options.flags.json, status);
      return 0;
    }
    case 'doctor': {
      const result = await doctorManagedAgentBrowser({
        stateDir: options.stateDir,
      });
      printWebResult(
        options.flags.json,
        result.exitCode === 0 ? 'Web backend is healthy.' : 'Web backend doctor reported issues.',
        result,
      );
      return result.exitCode;
    }
    default:
      throw new AppError('INVALID_ARGS', 'web requires setup or doctor');
  }
}

function printWebSetupStart(json: boolean | undefined): void {
  if (json) return;
  process.stdout.write('Setting up managed agent-browser backend (downloads if needed)...\n');
}

function printWebSetupResult(
  json: boolean | undefined,
  status: Awaited<ReturnType<typeof setupManagedAgentBrowser>>,
): void {
  if (json) {
    printJson({ success: true, data: { status: toPublicAgentBrowserToolStatus(status) } });
    return;
  }
  process.stdout.write(
    `Managed web backend installed.\nagent-browser available at: ${status.binaryPath}\n`,
  );
}

function printWebResult(json: boolean | undefined, message: string, data: Record<string, unknown>) {
  if (json) {
    printJson({ success: true, data: toPublicWebResult(data) });
    return;
  }
  process.stdout.write(`${message}\n`);
}

function toPublicAgentBrowserToolStatus(
  status: AgentBrowserToolStatus,
): PublicAgentBrowserToolStatus {
  const { socketDir: _socketDir, ...publicStatus } = status;
  return publicStatus;
}

function toPublicWebResult(data: Record<string, unknown>): Record<string, unknown> {
  const status = data.status;
  if (!isAgentBrowserToolStatus(status)) return data;
  return {
    ...data,
    status: toPublicAgentBrowserToolStatus(status),
  };
}

function isAgentBrowserToolStatus(value: unknown): value is AgentBrowserToolStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    'socketDir' in value &&
    'installDir' in value &&
    'binaryPath' in value
  );
}
