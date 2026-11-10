import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runScriptChildOutput } from './run-script-vm.ts';

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stdout.write(JSON.stringify(runScriptChildOutput(readFileSync(0, 'utf8'))));
}
