import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES } from '../run-script-http.ts';
import { runScriptChildOutput } from '../run-script-vm.ts';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';

// `http.post` blocks this thread while its HTTP child runs, so the server answering it must live
// in another process.
const SERVER_SOURCE = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  if (req.url === '/json') return res.end('{"ready":true,"__proto__":{"polluted":true}}');
  if (req.url === '/big') return res.end(Buffer.alloc(${MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES + 1}, 'a'));
  res.end('');
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

let server: ChildProcess | undefined;
let baseUrl = '';

beforeAll(async () => {
  const child = spawn(process.execPath, ['-e', SERVER_SOURCE], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  server = child;
  const port = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.stdout?.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()));
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.kill();
});

function run(source: string, env: Record<string, string> = {}) {
  const root = mkdtempForTestSync('agent-device-maestro-run-script-vm-');
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(scriptPath, source);
  return {
    scriptPath,
    output: runScriptChildOutput(
      JSON.stringify({ scriptPath, env: { BASE_URL: baseUrl, ...env }, publicNetworkOnly: false }),
    ),
  };
}

test('runs the script with its env and serializes every output value', () => {
  expect(
    run(`output.text = NAME; output.number = 42; output.flag = false; output.object = { a: 1 }`, {
      NAME: 'local',
    }).output,
  ).toEqual({
    outputEnv: {
      'output.text': 'local',
      'output.number': '42',
      'output.flag': 'false',
      'output.object': '{"a":1}',
    },
  });
});

test('parses an http.post body with json() and strips prototype keys', () => {
  expect(
    run(`
const parsed = json(http.post(BASE_URL + '/json', { body: '{}' }).body);
output.result = [parsed.ready, Object.prototype.hasOwnProperty.call(parsed, '__proto__')].join(':');
`).output,
  ).toEqual({ outputEnv: { 'output.result': 'true:false' } });
});

test('reports the typed json() refusals with their recovery details', () => {
  const empty = run(`output.x = json('')`);
  expect(empty.output).toEqual({
    error: {
      code: 'COMMAND_FAILED',
      message: 'Maestro runScript failed: Maestro runScript json() received an empty body.',
      details: {
        hint: 'Check the preceding HTTP response status and setup server output.',
        scriptPath: empty.scriptPath,
      },
    },
  });
  expect(run(`output.x = json(5)`).output).toMatchObject({
    error: { message: expect.stringContaining('json() expected a string body, received number') },
  });
  expect(run(`output.x = json('{')`).output).toMatchObject({
    error: {
      message: expect.stringContaining('json() could not parse response body'),
      details: { bodyPreview: '{' },
    },
  });
});

test('reports the typed response cap of an oversized http.post body', () => {
  expect(run(`output.x = http.post(BASE_URL + '/big').body`).output).toMatchObject({
    error: {
      message: `Maestro runScript failed: Maestro runScript HTTP response exceeded ${MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES} bytes`,
      details: { limitBytes: MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES, url: `${baseUrl}/big` },
    },
  });
});

test('reports an HTTP child that failed without a typed error', () => {
  expect(run(`output.x = http.post('not a url')`).output).toMatchObject({
    error: {
      code: 'COMMAND_FAILED',
      message: expect.stringContaining('Maestro runScript http.post failed for not a url'),
    },
  });
});

test('rejects output keys that cannot become replay variables', () => {
  const dotted = run(`output['nested.value'] = 'x'`);
  expect(dotted.output).toEqual({
    error: {
      code: 'INVALID_ARGS',
      message: 'Maestro runScript output key cannot contain ".": nested.value',
      details: { scriptPath: dotted.scriptPath, key: 'nested.value' },
    },
  });
});

test('reports malformed child input as a normalized error', () => {
  expect(runScriptChildOutput('{')).toMatchObject({ error: { message: expect.any(String) } });
});
