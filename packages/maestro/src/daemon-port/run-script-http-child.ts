import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { RunScriptHttpRequest } from './run-script-http.ts';
import { executeRunScriptHttpRequest } from './run-script-http.ts';

export async function runScriptHttpChild(): Promise<void> {
  const response = await executeRunScriptHttpRequest(
    JSON.parse(readFileSync(0, 'utf8')) as RunScriptHttpRequest,
  );
  process.stdout.write(JSON.stringify(response));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runScriptHttpChild().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
