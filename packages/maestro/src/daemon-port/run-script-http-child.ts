import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AppError } from '@agent-device/kernel/errors';
import type { RunScriptHttpChildOutput, RunScriptHttpRequest } from './run-script-http.ts';
import { executeRunScriptHttpRequest } from './run-script-http.ts';

export async function runScriptHttpChild(): Promise<void> {
  const response = await executeRunScriptHttpRequest(
    JSON.parse(readFileSync(0, 'utf8')) as RunScriptHttpRequest,
    process.env,
  );
  writeOutput({ response });
}

function writeOutput(output: RunScriptHttpChildOutput): void {
  process.stdout.write(JSON.stringify(output));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runScriptHttpChild().catch((error: unknown) => {
    if (error instanceof AppError) {
      writeOutput({ error: { code: error.code, message: error.message, details: error.details } });
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
