import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { executeRunScriptFile } from '../run-script-execution.ts';
import { MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES } from '../run-script-http.ts';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from './loopback.fixtures.ts';

async function withLoopbackServer(
  handler: http.RequestListener,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  try {
    const port = await listenOnLoopback(server);
    await run(`http://127.0.0.1:${port}/`);
  } finally {
    await closeLoopbackServer(server);
  }
}

function writeScript(source: string): { root: string; scriptPath: string } {
  const root = mkdtempForTestSync('agent-device-maestro-run-script-');
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(scriptPath, source);
  return { root, scriptPath };
}

test('executeRunScriptFile keeps the event loop free while http.post waits', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { root, scriptPath } = writeScript(`output.body = http.post(SERVER_URL).body`);
  let timerFired = false;
  // The server answers only after a timer in this process fires; a blocked loop never answers.
  try {
    await withLoopbackServer(
      (_req, res) => {
        setTimeout(() => {
          timerFired = true;
          res.end('late');
        }, 50);
      },
      async (url) => {
        await expect(
          executeRunScriptFile({ scriptPath, env: { SERVER_URL: url }, publicNetworkOnly: false }),
        ).resolves.toEqual({ 'output.body': 'late' });
      },
    );
    expect(timerFired).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile stops the script when its signal aborts', async () => {
  const { root, scriptPath } = writeScript(`for (;;) {}`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const startedAt = Date.now();
  try {
    await expect(
      executeRunScriptFile({
        scriptPath,
        env: {},
        publicNetworkOnly: false,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile returns an http.post body above the 1 MiB process buffer default', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { root, scriptPath } = writeScript(`output.size = http.post(SERVER_URL).body.length`);
  const body = '"'.repeat(2 * 1024 * 1024);
  try {
    await withLoopbackServer(
      (_req, res) => res.end(body),
      async (url) => {
        await expect(
          executeRunScriptFile({ scriptPath, env: { SERVER_URL: url }, publicNetworkOnly: false }),
        ).resolves.toEqual({ 'output.size': String(body.length) });
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile reports the typed response cap for an oversized http.post body', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { root, scriptPath } = writeScript(`output.body = http.post(SERVER_URL).body`);
  const body = Buffer.alloc(MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES + 1, 'a');
  try {
    await withLoopbackServer(
      (_req, res) => res.end(body),
      async (url) => {
        const error = await executeRunScriptFile({
          scriptPath,
          env: { SERVER_URL: url },
          publicNetworkOnly: false,
        }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).message).toBe(
          `Maestro runScript failed: Maestro runScript HTTP response exceeded ${MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES} bytes`,
        );
        expect((error as AppError).details).toMatchObject({
          limitBytes: MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES,
          scriptPath,
        });
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile exposes env and serializes output values', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-run-script-');
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(
    scriptPath,
    `
output.text = SERVER_PATH
output.number = 42
output.boolean = false
output.object = { ready: true }
`,
  );

  try {
    await expect(
      executeRunScriptFile({ scriptPath, env: { SERVER_PATH: 'local' }, publicNetworkOnly: false }),
    ).resolves.toEqual({
      'output.text': 'local',
      'output.number': '42',
      'output.boolean': 'false',
      'output.object': '{"ready":true}',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile rejects output keys that cannot become replay variables', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-run-script-');
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(scriptPath, `output['nested.value'] = 'ambiguous'`);

  try {
    const error = await executeRunScriptFile({
      scriptPath,
      env: {},
      publicNetworkOnly: false,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_ARGS');
    expect((error as AppError).message).toContain('output key cannot contain');
    expect((error as AppError).details).toEqual({ scriptPath, key: 'nested.value' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile keeps recovery guidance separate from its bounded error message', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-run-script-');
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(scriptPath, `output.result = json('').value`);

  try {
    const error = await executeRunScriptFile({
      scriptPath,
      env: {},
      publicNetworkOnly: false,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toBe(
      'Maestro runScript failed: Maestro runScript json() received an empty body.',
    );
    expect((error as AppError).details).toEqual({
      hint: 'Check the preceding HTTP response status and setup server output.',
      scriptPath,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile strips prototype keys from json output', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-run-script-');
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(
    scriptPath,
    `
const parsed = json('{"safe":1,"__proto__":{"polluted":true},"nested":{"prototype":{"polluted":true},"ok":2}}')
output.result = [
  Object.prototype.hasOwnProperty.call(parsed, '__proto__'),
  Object.prototype.hasOwnProperty.call(parsed.nested, 'prototype'),
  parsed.nested.ok
].join(':')
`,
  );

  try {
    await expect(
      executeRunScriptFile({ scriptPath, env: {}, publicNetworkOnly: false }),
    ).resolves.toEqual({ 'output.result': 'false:false:2' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile refuses remote scripts before reading or running host code', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-run-script-');
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(scriptPath, `throw new Error('host-script-canary')`);
  const read = vi.spyOn(fs, 'readFileSync');

  try {
    await expect(
      executeRunScriptFile({
        scriptPath,
        env: {},
        publicNetworkOnly: true,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(read.mock.calls.some(([file]) => file === scriptPath)).toBe(false);
  } finally {
    read.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
