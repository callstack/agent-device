import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';

const stdin = vi.hoisted(() => ({ text: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      args[0] === 0 ? stdin.text : actual.readFileSync(...args),
  };
});

let originalExitCode: typeof process.exitCode;
let originalArgv: typeof process.argv;

beforeEach(() => {
  vi.resetModules();
  originalExitCode = process.exitCode;
  originalArgv = process.argv;
  process.argv = [...process.argv];
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  process.argv = originalArgv;
});

function captureOutput() {
  const chunks: string[] = [];
  const written = new Promise<void>((resolve) => {
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      resolve();
      return true;
    });
  });
  return { written, text: () => chunks.join('') };
}

test('the VM entry reads its stdin request and writes the output envelope', async () => {
  const scriptPath = path.join(mkdtempForTestSync('run-script-entry-'), 'setup.js');
  fs.writeFileSync(scriptPath, 'output.answer = VALUE.toUpperCase();');
  stdin.text = JSON.stringify({ scriptPath, env: { VALUE: 'child' }, publicNetworkOnly: false });
  const output = captureOutput();
  process.argv[1] = fileURLToPath(new URL('../run-script-child.ts', import.meta.url));

  await import('../run-script-child.ts');

  await output.written;
  assert.deepEqual(JSON.parse(output.text()), { outputEnv: { 'output.answer': 'CHILD' } });
});

test('the HTTP entry writes typed refusals as JSON without failing the process', async () => {
  stdin.text = JSON.stringify({
    method: 'POST',
    url: 'not a URL',
    headers: {},
    publicNetworkOnly: true,
  });
  const output = captureOutput();
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.argv[1] = fileURLToPath(new URL('../run-script-http-child.ts', import.meta.url));

  await import('../run-script-http-child.ts');

  await output.written;
  assert.deepEqual(JSON.parse(output.text()), {
    error: { code: 'INVALID_ARGS', message: 'Invalid Maestro runScript HTTP URL' },
  });
  assert.equal(stderr.mock.calls.length, 0);
  assert.equal(process.exitCode, undefined);
});

test('the HTTP entry reports malformed protocol input on stderr with a failing exit code', async () => {
  stdin.text = '{';
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const failure = new Promise<unknown>((resolve) => {
    vi.spyOn(console, 'error').mockImplementation((value) => resolve(value));
  });
  process.argv[1] = fileURLToPath(new URL('../run-script-http-child.ts', import.meta.url));

  await import('../run-script-http-child.ts');

  assert.match(String(await failure), /SyntaxError/);
  assert.equal(stdout.mock.calls.length, 0);
  assert.equal(process.exitCode, 1);
});
