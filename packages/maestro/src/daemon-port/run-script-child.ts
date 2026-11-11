import { readFileSync } from 'node:fs';
import { runScriptChildOutput } from './run-script-vm.ts';

process.stdout.write(JSON.stringify(runScriptChildOutput(readFileSync(0, 'utf8'))));
