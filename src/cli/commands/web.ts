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
      const status = await setupManagedAgentBrowser({
        stateDir: options.stateDir,
      });
      printWebResult(options.flags.json, 'Managed web backend installed.', { status });
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

function printWebResult(json: boolean | undefined, message: string, data: Record<string, unknown>) {
  if (json) {
    printJson({ success: true, data });
    return;
  }
  process.stdout.write(`${message}\n`);
}
