import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { runScriptInProcess } from './run-script-vm.ts';
import type { RunScriptChildOutput, RunScriptRequest } from './run-script-vm.ts';

/** Runs one Maestro runScript request from stdin and reports the result on stdout. */
function runScriptChild(): void {
  writeOutput(readScriptChildOutput(readFileSync(0, 'utf8')));
}

function readScriptChildOutput(input: string): RunScriptChildOutput {
  try {
    return { outputEnv: runScriptInProcess(JSON.parse(input) as RunScriptRequest) };
  } catch (error) {
    if (error instanceof AppError) {
      return { error: { code: error.code, message: error.message, details: error.details } };
    }
    const normalized = normalizeError(error);
    return { error: { code: normalized.code, message: normalized.message } };
  }
}

function writeOutput(output: RunScriptChildOutput): void {
  process.stdout.write(JSON.stringify(output));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runScriptChild();
}
