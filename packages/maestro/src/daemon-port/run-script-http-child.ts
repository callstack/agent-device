import { readFileSync } from 'node:fs';
import { runScriptHttpChildOutput } from './run-script-http.ts';

void runScriptHttpChildOutput(readFileSync(0, 'utf8'), process.env).then(
  (output) => process.stdout.write(JSON.stringify(output)),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  },
);
