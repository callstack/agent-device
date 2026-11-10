import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runScriptHttpChildOutput } from './run-script-http.ts';

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runScriptHttpChildOutput(readFileSync(0, 'utf8'), process.env).then(
    (output) => process.stdout.write(JSON.stringify(output)),
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    },
  );
}
