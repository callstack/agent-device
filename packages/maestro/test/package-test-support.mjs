import { runCmdSync } from '@agent-device/host-kit/command';
import http from 'node:http';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function run(command, args, cwd, env = process.env) {
  return runCmdSync(command, args, {
    cwd,
    env,
    timeoutMs: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  }).stdout;
}
async function assertPackagedRunScriptChildren(plugin, scratch) {
  const alias = path.join(scratch, 'plugin-alias');
  fs.symlinkSync(plugin, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const server = http.createServer((_request, response) =>
    response.end('x'.repeat(2 * 1024 * 1024)),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const scriptPath = path.join(scratch, 'http.js');
    fs.writeFileSync(scriptPath, 'output.size = http.post(SERVER_URL).body.length');
    for (const directory of [plugin, alias]) {
      const result = promisify(execFile)(
        process.execPath,
        [path.join(directory, 'dist/run-script-child.mjs')],
        { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      );
      result.child.stdin.end(
        JSON.stringify({
          scriptPath,
          env: { SERVER_URL: `http://127.0.0.1:${server.address().port}/` },
          publicNetworkOnly: false,
        }),
      );
      assert.deepEqual(JSON.parse((await result).stdout), {
        outputEnv: { 'output.size': String(2 * 1024 * 1024) },
      });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export { run, assertPackagedRunScriptChildren };
