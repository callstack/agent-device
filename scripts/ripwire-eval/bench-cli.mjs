// Shared plumbing for the ripwire-eval scripts: flag reading, the tasks file, and the one way
// they all invoke the ripwire binary. Every bench needs the same three, and a bench that grows
// its own copy is how the three drift apart.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The directory this harness lives in — where `tasks.json` and the result files sit. */
export const harnessDir = dirname(fileURLToPath(import.meta.url));

/** Reads `--name=value` off argv. */
function arg(name, fallback) {
  const hit = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/**
 * Reads the named flags, exiting with the given usage line if any of `required` is missing, so a
 * bench states its contract once instead of repeating the check and the message.
 */
export function readArgs({ usage, required, optional = {} }) {
  const values = {};
  for (const name of required) values[name] = arg(name);
  for (const [name, fallback] of Object.entries(optional)) values[name] = arg(name, fallback);
  const missing = required.filter((name) => !values[name]);
  if (missing.length > 0) {
    console.error(`usage: ${usage}`);
    process.exit(2);
  }
  return values;
}

export function loadTasks() {
  return JSON.parse(readFileSync(join(harnessDir, 'tasks.json'), 'utf8')).tasks;
}

/**
 * One ripwire invocation, timed. A non-zero exit is data, not an abort: ripwire writes its answer
 * to stdout even on the exit codes that report a refusal, and a bench row that says which verb
 * failed is worth more than a dead run.
 */
export async function runRipwire(ripwire, args, cwd) {
  const started = process.hrtime.bigint();
  const { stdout, failed } = await capture(ripwire, args, cwd);
  return {
    stdout,
    failed,
    ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
    bytes: Buffer.byteLength(stdout),
  };
}

async function capture(ripwire, args, cwd) {
  try {
    const { stdout } = await execFileAsync(ripwire, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, failed: null };
  } catch (error) {
    return failureOf(error);
  }
}

// A refusal still writes its answer to stdout, so keep whatever came back and record why.
function failureOf(error) {
  return {
    stdout: textOf(error?.stdout, ''),
    failed: textOf(error?.message, error).slice(0, 200),
  };
}

function textOf(value, fallback) {
  return String(value === undefined ? fallback : value);
}
