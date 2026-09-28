import { maestroReplayFixture } from './session-replay-runtime-maestro.fixtures.ts';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { test } from 'vitest';

const { runReplayFixture } = maestroReplayFixture;

test('runReplayCommand runs Maestro runScript in replay order and exposes output variables', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-runscript-runtime',
    files: {
      'setup.js': `
var res = {body: '{"appviewDid":"did:plc:test"}'}
output.result = SERVER_PATH + ':' + json(res.body).appviewDid
`,
    },
    script: [
      'appId: demo.app',
      '---',
      '- runScript:',
      '    file: ./setup.js',
      '    env:',
      '      SERVER_PATH: local',
      '- inputText: ${output.result}',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['type', ['local:did:plc:test']],
      ['snapshot', []],
      ['snapshot', []],
    ],
  );
});

test('runReplayCommand supports successful Maestro runScript http.post calls', async () => {
  const server = new Worker(
    `
const http = require('node:http');
const { parentPort } = require('node:worker_threads');
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, body }));
  });
});
server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage(server.address().port);
});
`,
    { eval: true },
  );
  const port = await new Promise<number>((resolve, reject) => {
    server.once('message', (value) => resolve(Number(value)));
    server.once('error', reject);
    server.once('exit', (code) => {
      if (code !== 0) reject(new Error(`HTTP fixture worker exited with code ${code}`));
    });
  });

  try {
    const { response, calls } = await runReplayFixture({
      label: 'maestro-runscript-http-post',
      files: {
        'setup.js': `
var res = http.post('http://127.0.0.1:${port}/setup', {body: '{"ok":true}'})
var parsed = json(res.body)
output.result = parsed.method + ':' + json(parsed.body).ok
`,
      },
      script: [
        'appId: demo.app',
        '---',
        '- runScript: ./setup.js',
        '- inputText: ${output.result}',
        '',
      ].join('\n'),
      flags: { replayBackend: 'maestro' },
    });

    assert.equal(response.ok, true);
    assert.deepEqual(
      calls.map((call) => [call.command, call.positionals]),
      [
        ['type', ['POST:true']],
        ['snapshot', []],
        ['snapshot', []],
      ],
    );
  } finally {
    await server.terminate();
  }
});

test('runReplayCommand strips prototype pollution keys from runScript json()', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-runscript-json-prototype-keys',
    files: {
      'setup.js': `
var parsed = json('{"safe":1,"__proto__":{"polluted":true},"constructor":{"polluted":true},"nested":{"prototype":{"polluted":true},"ok":2}}')
output.result = [
  Object.prototype.hasOwnProperty.call(parsed, '__proto__'),
  Object.prototype.hasOwnProperty.call(parsed, 'constructor'),
  Object.prototype.hasOwnProperty.call(parsed.nested, 'prototype'),
  parsed.nested.ok
].join(':')
`,
    },
    script: [
      'appId: demo.app',
      '---',
      '- runScript: ./setup.js',
      '- inputText: ${output.result}',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['type', ['false:false:false:2']],
      ['snapshot', []],
      ['snapshot', []],
    ],
  );
});

test('runReplayCommand reports Maestro runScript failures at the runScript step', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-runscript-fail',
    files: {
      'setup.js': `output.result = http.post('http://127.0.0.1:1').body`,
    },
    script: ['appId: demo.app', '---', '- runScript: ./setup.js', '- inputText: never', ''].join(
      '\n',
    ),
    flags: { replayBackend: 'maestro' },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.match(response.error.message, /Replay failed at step 1/);
    assert.match(response.error.message, /runScript failed/);
    assert.match(response.error.message, /http\.post failed/);
  }
  assert.equal(calls.length, 0);
});

test('runReplayCommand explains empty Maestro runScript JSON bodies', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-runscript-empty-json',
    files: {
      'setup.js': `output.result = json('').value`,
    },
    script: ['appId: demo.app', '---', '- runScript: ./setup.js', '- inputText: never', ''].join(
      '\n',
    ),
    flags: { replayBackend: 'maestro' },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.match(response.error.message, /Replay failed at step 1/);
    assert.match(response.error.message, /json\(\) received an empty body/);
    assert.match(response.error.hint ?? '', /setup server output/);
  }
  assert.equal(calls.length, 0);
});

test('runReplayCommand rejects Maestro runScript output keys containing dots', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-runscript-dotted-output',
    files: {
      'setup.js': `output['nested.value'] = 'ambiguous'`,
    },
    script: ['appId: demo.app', '---', '- runScript: ./setup.js', '- inputText: never', ''].join(
      '\n',
    ),
    flags: { replayBackend: 'maestro' },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.match(response.error.message, /Replay failed at step 1/);
    assert.match(response.error.message, /output key cannot contain/);
  }
  assert.equal(calls.length, 0);
});
