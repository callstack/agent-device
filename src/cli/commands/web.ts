import {
  doctorManagedAgentBrowser,
  setupManagedAgentBrowser,
} from '../../platforms/web/agent-browser-tool.ts';
import { AppError } from '../../utils/errors.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import { printJson } from '../../utils/output.ts';

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
    printJson({ success: true, data: { status } });
    return;
  }
  process.stdout.write(
    `Managed web backend installed.\nagent-browser available at: ${status.binaryPath}\n`,
  );
}

function printWebResult(json: boolean | undefined, message: string, data: Record<string, unknown>) {
  if (json) {
    printJson({ success: true, data });
    return;
  }
  process.stdout.write(`${message}\n`);
}
