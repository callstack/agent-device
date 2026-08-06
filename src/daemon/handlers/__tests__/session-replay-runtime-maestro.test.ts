import { test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

// ADR 0012 migration step 2: every replay step failure now attempts a
// post-failure screen digest capture + suggestion re-resolution, both via
// dispatchCommand('snapshot', ...). None of this file's fixtures model a real
// device runner, so without a mock those calls fall through to the real
// (slow/hanging) runner dispatch path. Reject fast so failure-path tests keep
// exercising `divergence.screen: unavailable` deterministically, exactly like
// a real capture failure would.
//
// This file carries the Maestro-heavy majority of what used to live in
// session-replay-vars.test.ts, plus a handful of generic (non-Maestro) `.ad`
// runReplayScriptFile tests that happen to share the same runReplayFixture
// helper and mock configuration below. It is a sibling of
// session-replay-runtime.test.ts rather than a merge into it because that
// file mocks '../../../core/dispatch.ts' differently (dispatchCommand
// resolves `{}`, not throws) — vitest allows only one vi.mock per module per
// file, so reconciling the two configurations was out of scope for a pure
// test-file split (see #1460).
vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    resolveTargetDevice: vi.fn(async (flags) =>
      flags.platform === 'android'
        ? {
            platform: 'android',
            id: 'emulator-5554',
            name: 'Pixel',
            kind: 'emulator',
            booted: true,
          }
        : {
            platform: 'apple',
            appleOs: 'ios',
            id: 'sim-1',
            name: 'iPhone 17 Pro',
            kind: 'simulator',
            booted: true,
          },
    ),
    dispatchCommand: vi.fn(async () => {
      throw new Error('no device runner available in this test');
    }),
    dispatchGestureViewport: vi.fn(async () => ({ x: 0, y: 0, width: 400, height: 800 })),
  };
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { PNG } from '../../../utils/png.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../types.ts';
import type { CommandFlags } from '../../../core/dispatch.ts';
import { SessionStore } from '../../session-store.ts';
import { makeAndroidSession, makeIosSession } from '../../../__tests__/test-utils/index.ts';
import { runReplayScriptFile } from '../session-replay-runtime.ts';

type CapturedInvocation = {
  command: string;
  positionals?: string[];
  input?: Record<string, unknown>;
  flags?: CommandFlags;
};

async function runReplayFixture(params: {
  label: string;
  script: string;
  files?: Record<string, string>;
  flags?: CommandFlags;
  invoke?: DaemonInvokeFn;
  sessionPlatform?: 'android' | 'ios';
}): Promise<{
  response: DaemonResponse;
  calls: CapturedInvocation[];
  root: string;
  scriptPath: string;
}> {
  const root = mkdtempForTestSync(`agent-device-replay-${params.label}-`);
  writeFixtureFiles(root, params.files);
  const isMaestro = params.flags?.replayBackend === 'maestro';
  const scriptPath = path.join(root, isMaestro ? 'flow.yaml' : 'flow.ad');
  fs.writeFileSync(scriptPath, params.script);
  const calls: CapturedInvocation[] = [];
  const invoke = createFixtureInvoke({ calls, delegate: params.invoke, isMaestro });
  const sessionStore = new SessionStore(path.join(root, 'state'));
  seedFixtureSession(sessionStore, params.sessionPlatform);
  const response = await runReplayScriptFile({
    req: fixtureReplayRequest({ root, scriptPath, flags: params.flags, isMaestro }),
    sessionName: 's',
    logPath: path.join(root, 'log'),
    sessionStore,
    invoke,
  });
  return { response, calls, root, scriptPath };
}

function writeFixtureFiles(root: string, files: Record<string, string> | undefined): void {
  for (const [name, contents] of Object.entries(files ?? {})) {
    fs.writeFileSync(path.join(root, name), contents);
  }
}

function createFixtureInvoke(params: {
  calls: CapturedInvocation[];
  delegate: DaemonInvokeFn | undefined;
  isMaestro: boolean;
}): DaemonInvokeFn {
  return async (req) => {
    params.calls.push({
      command: req.command,
      positionals: req.positionals,
      input: req.input,
      flags: req.flags,
    });
    if (params.delegate) return await params.delegate(req);
    return params.isMaestro && req.command === 'snapshot'
      ? { ok: true, data: { createdAt: 0, nodes: [] } }
      : { ok: true, data: {} };
  };
}

function seedFixtureSession(
  sessionStore: SessionStore,
  platform: 'android' | 'ios' | undefined,
): void {
  if (platform === 'android') sessionStore.set('s', makeAndroidSession('s'));
  if (platform === 'ios') sessionStore.set('s', makeIosSession('s'));
}

function fixtureReplayRequest(params: {
  root: string;
  scriptPath: string;
  flags: CommandFlags | undefined;
  isMaestro: boolean;
}): DaemonRequest {
  return {
    token: 't',
    session: 's',
    command: 'replay',
    positionals: [params.scriptPath],
    flags: {
      ...(params.flags ?? {}),
      ...(params.isMaestro && params.flags?.platform === undefined ? { platform: 'ios' } : {}),
    },
    meta: { cwd: params.root },
  };
}

test('--update no longer rejects Maestro compat flow controls (the guard existed only for rewrite safety)', async () => {
  const { response } = await runReplayFixture({
    label: 'maestro-replay-update-flow-control',
    script: [
      'appId: demo.app',
      '---',
      '- retry:',
      '    maxRetries: 1',
      '    commands:',
      '      - back',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', replayUpdate: true },
  });

  assert.equal(response.ok, true);
});

function assertNoUnresolvedInterpolation(calls: CapturedInvocation[]): void {
  for (const call of calls) {
    for (const pos of call.positionals ?? []) {
      assert.equal(pos.includes('${'), false, `unresolved interpolation leaked: ${pos}`);
    }
  }
}

test('runReplayScriptFile dispatches resolved literals with file env overridden by CLI', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'green',
    script:
      [
        'context platform=android',
        'env APP=file-app',
        'env SCOPE=file-scope',
        '',
        'open ${APP}',
        'snapshot -s ${SCOPE}',
        'click "at ${AD_FILENAME}"',
      ].join('\n') + '\n',
    flags: { replayEnv: ['APP=cli-app'] },
  });
  assert.equal(response.ok, true);
  const [open, snapshot, click] = calls;
  assert.ok(open && snapshot && click);
  // open ${APP} -> CLI override wins.
  assert.equal(open.command, 'open');
  assert.deepEqual(open.positionals, ['cli-app']);
  // snapshot -s ${SCOPE} -> file env fills in.
  assert.equal(snapshot.command, 'snapshot');
  assert.equal(snapshot.flags?.snapshotScope, 'file-scope');
  // click with ${AD_FILENAME} resolves to the relative script path.
  assert.equal(click.command, 'click');
  assert.deepEqual(click.positionals, ['at flow.ad']);
  // And nothing dispatched still contains a literal ${...} token.
  assertNoUnresolvedInterpolation(calls);
});

test('.ad replay normalizes resolved gesture and swipe syntax into structured daemon input', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'structured-gesture-input',
    script: [
      'env X=10',
      'gesture pan ${X} 20 30 40 500 --pointer-count 2',
      'swipe ${X} 20 30 40 --count 2 --pause-ms 5 --pattern ping-pong',
      '',
    ].join('\n'),
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => ({
      command: call.command,
      positionals: call.positionals,
      input: call.input,
    })),
    [
      {
        command: 'gesture',
        positionals: [],
        input: {
          kind: 'pan',
          origin: { x: 10, y: 20 },
          delta: { x: 30, y: 40 },
          pointerCount: 2,
          durationMs: 500,
        },
      },
      {
        command: 'swipe',
        positionals: [],
        input: {
          from: { x: 10, y: 20 },
          to: { x: 30, y: 40 },
          count: 2,
          pauseMs: 5,
          pattern: 'ping-pong',
        },
      },
    ],
  );
});

test('runReplayScriptFile reports snapshot diagnostics from per-action session samples', async () => {
  const root = mkdtempForTestSync('agent-device-replay-snapshot-samples-');
  const scriptPath = path.join(root, 'flow.ad');
  // Four warm captures beyond the cold start: the slow-run warning judges warm
  // samples only and needs at least three of them.
  fs.writeFileSync(
    scriptPath,
    ['snapshot', 'snapshot', 'snapshot', 'snapshot', 'snapshot', ''].join('\n'),
  );
  const sessionStore = new SessionStore(path.join(root, 'state'));
  sessionStore.set(
    's',
    makeIosSession('s', {
      snapshotDiagnostics: { samples: [] },
    }),
  );
  let captures = 0;

  const response = await runReplayScriptFile({
    req: {
      token: 't',
      session: 's',
      command: 'replay',
      positionals: [scriptPath],
      meta: { cwd: root },
    },
    sessionName: 's',
    logPath: path.join(root, 'log'),
    sessionStore,
    invoke: async (): Promise<DaemonResponse> => {
      captures += 1;
      const session = sessionStore.get('s');
      session?.snapshotDiagnostics?.samples.push({
        durationMs: captures === 1 ? 400 : 1_900,
        backend: 'xctest',
        platform: 'ios',
      });
      return {
        ok: true,
        data: {
          snapshotDiagnostics: {
            stats: {
              count: captures,
              p50Ms: captures === 1 ? 400 : 1_900,
              p95Ms: captures === 1 ? 400 : 1_900,
              maxMs: captures === 1 ? 400 : 1_900,
              slowThresholdMs: 1_500,
              platform: 'ios',
            },
          },
        },
      };
    },
  });

  assert.equal(response.ok, true);
  const diagnostics = response.data?.snapshotDiagnostics as
    | { stats?: { count?: number }; warning?: string }
    | undefined;
  assert.equal(diagnostics?.stats?.count, 5);
  assert.match(String(diagnostics?.warning), /p95 1900ms over 4 captures/);
});

test('runReplayScriptFile reports snapshot diagnostics on replay failure', async () => {
  const root = mkdtempForTestSync('agent-device-replay-snapshot-failure-');
  const scriptPath = path.join(root, 'flow.ad');
  // Three warm captures precede the failing click so the failure-path summary
  // has enough warm samples to judge.
  fs.writeFileSync(
    scriptPath,
    ['snapshot', 'snapshot', 'snapshot', 'snapshot', 'click "Missing"', ''].join('\n'),
  );
  const sessionStore = new SessionStore(path.join(root, 'state'));
  sessionStore.set(
    's',
    makeIosSession('s', {
      snapshotDiagnostics: { samples: [] },
    }),
  );
  let captures = 0;

  const response = await runReplayScriptFile({
    req: {
      token: 't',
      session: 's',
      command: 'replay',
      positionals: [scriptPath],
      meta: { cwd: root },
    },
    sessionName: 's',
    logPath: path.join(root, 'log'),
    sessionStore,
    invoke: async (): Promise<DaemonResponse> => {
      captures += 1;
      const session = sessionStore.get('s');
      session?.snapshotDiagnostics?.samples.push({
        durationMs: captures === 1 ? 450 : 2_100,
        backend: 'xctest',
        platform: 'ios',
      });
      if (captures < 5) return { ok: true, data: {} };
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'button missing' } };
    },
  });

  assert.equal(response.ok, false);
  const diagnostics = response.error.details?.snapshotDiagnostics as
    | { stats?: { count?: number; p95Ms?: number }; warning?: string }
    | undefined;
  assert.equal(diagnostics?.stats?.count, 5);
  assert.equal(diagnostics?.stats?.p95Ms, 2_100);
  assert.match(String(diagnostics?.warning), /p95 2100ms over 4 captures/);
});

test('runReplayScriptFile applies CLI env overrides before Maestro compat mapping', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-env',
    script: [
      'appId: ${APP_ID}',
      'env:',
      '  APP_ID: yaml-app',
      '  BUTTON_ID: yaml-button',
      '---',
      '- launchApp',
      '- tapOn:',
      '    id: ${BUTTON_ID}',
      '',
    ].join('\n'),
    flags: {
      replayBackend: 'maestro',
      platform: 'android',
      replayShellEnv: { AD_VAR_BUTTON_ID: 'shell-button' },
      replayEnv: ['APP_ID=cli-app'],
    },
    invoke: async (req) => {
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                identifier: 'shell-button',
                rect: { x: 20, y: 40, width: 120, height: 44 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls[0]?.positionals, ['cli-app']);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['open', ['cli-app']],
      ['snapshot', []],
      ['snapshot', []],
      ['click', ['80', '62']],
    ],
  );
});

test('runReplayScriptFile runs Maestro runScript in replay order and exposes output variables', async () => {
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

test('runReplayScriptFile supports successful Maestro runScript http.post calls', async () => {
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

test('runReplayScriptFile strips prototype pollution keys from runScript json()', async () => {
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

test('runReplayScriptFile reports Maestro runScript failures at the runScript step', async () => {
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

test('runReplayScriptFile reports iOS Maestro openLink setup failures before assertions', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-ios-openlink-prewarm-fail',
    script: [
      'appId: demo.app',
      '---',
      '- openLink: demo://screen',
      '- assertVisible: Ready',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'ios' },
    invoke: async (req) => {
      if (req.command === 'open') {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: 'Developer mode is disabled for Apple development tools',
            details: {
              hint: 'Run `sudo DevToolsSecurity -enable`.',
            },
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.match(response.error.message, /Replay failed at step 1/);
    assert.match(response.error.message, /openLink "demo:\/\/screen"/);
    assert.match(response.error.message, /Developer mode is disabled/);
    // The cause's details-borne hint is hoisted onto the error field by the
    // divergence transport (arbitrary cause details are stripped).
    assert.match(String(response.error.hint ?? ''), /DevToolsSecurity -enable/);
  }
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['open', ['demo.app', 'demo://screen']]],
  );
  assert.equal(calls[0]?.flags?.maestro?.prewarmRunnerBeforeOpen, true);
});

test('runReplayScriptFile explains empty Maestro runScript JSON bodies', async () => {
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

test('runReplayScriptFile rejects Maestro runScript output keys containing dots', async () => {
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

test('runReplayScriptFile retries Maestro scrollUntilVisible with scroll probes', async () => {
  const calls: CapturedInvocation[] = [];
  let snapshotAttempts = 0;
  const { response } = await runReplayFixture({
    label: 'maestro-scroll-until-visible',
    script: [
      'appId: demo.app',
      '---',
      '- scrollUntilVisible:',
      '    element: Discover',
      '    direction: UP',
      '    timeout: 1200',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        snapshotAttempts += 1;
        return {
          ok: true,
          data: {
            nodes:
              snapshotAttempts < 3
                ? []
                : [
                    {
                      index: 1,
                      label: 'Discover',
                      rect: { x: 10, y: 600, width: 240, height: 44 },
                    },
                  ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['scroll', ['up']],
      ['snapshot', []],
      ['snapshot', []],
      ['snapshot', []],
    ],
  );
});

test('runReplayScriptFile uses semantic iOS dispatch for an exact text tapOn', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-visible-text-atomic-ios',
    script: ['appId: demo.app', '---', '- tapOn: Article', ''].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'ios' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                type: 'XCUIElementTypeButton',
                label: 'Article',
                rect: { x: 40, y: 100, width: 120, height: 48 },
                hittable: true,
              },
              {
                index: 2,
                parentIndex: 1,
                type: 'XCUIElementTypeStaticText',
                label: 'Article',
                rect: { x: 76, y: 114, width: 48, height: 20 },
                hittable: false,
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['click', ['text="Article"']],
    ],
  );
});

test('runReplayScriptFile uses matched Android id geometry for tapOn', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-id-matched-geometry',
    script: ['appId: demo.app', '---', '- tapOn:', '    id: album-0', ''].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                type: 'android.widget.Button',
                rect: { x: 24, y: 320, width: 312, height: 64 },
                hittable: true,
              },
              {
                index: 2,
                parentIndex: 1,
                type: 'android.widget.TextView',
                identifier: 'album-0',
                rect: { x: 44, y: 334, width: 80, height: 24 },
                hittable: false,
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['click', ['84', '346']],
    ],
  );
});

test('runReplayScriptFile captures fresh geometry for tapOn after assertVisible', async () => {
  let snapshots = 0;
  const { response, calls } = await runReplayFixture({
    label: 'maestro-assert-visible-tap-fresh-snapshot',
    script: [
      'appId: demo.app',
      '---',
      '- assertVisible:',
      '    id: open-feed',
      '- tapOn: Open feed',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      if (req.command === 'snapshot') {
        snapshots += 1;
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                label: 'Article',
                rect: { x: 10, y: 100, width: 160, height: 44 },
              },
              {
                index: 2,
                label: 'Open feed',
                identifier: 'open-feed',
                rect: { x: 20, y: 180, width: 180, height: 48 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.equal(snapshots, 2);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['snapshot', []],
      ['click', ['110', '204']],
    ],
  );
});

test('runReplayScriptFile scopes duplicate tap targets after native Maestro assertVisible', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-native-assert-context-duplicate-tap',
    script: ['appId: demo.app', '---', '- assertVisible: Albums', '- tapOn: Push article', ''].join(
      '\n',
    ),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                depth: 1,
                type: 'android.widget.ScrollView',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              {
                index: 2,
                depth: 2,
                parentIndex: 1,
                type: 'android.widget.TextView',
                label: 'Albums',
                rect: { x: 24, y: 120, width: 120, height: 40 },
              },
              {
                index: 3,
                depth: 2,
                parentIndex: 1,
                type: 'android.widget.TextView',
                label: 'Push article',
                rect: { x: 32, y: 220, width: 160, height: 44 },
              },
              {
                index: 10,
                depth: 1,
                type: 'android.widget.ScrollView',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              {
                index: 11,
                depth: 2,
                parentIndex: 10,
                type: 'android.widget.TextView',
                label: 'Push article',
                rect: { x: 32, y: 520, width: 160, height: 44 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['snapshot', []],
      ['click', ['112', '242']],
    ],
  );
});

test('runReplayScriptFile treats absent Maestro assertNotVisible targets as passing', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-assert-not-visible-absent',
    script: ['appId: demo.app', '---', '- assertNotVisible: Archived banner', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      return {
        ok: true,
        data: {
          createdAt: 1,
          nodes: [],
        },
      };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['snapshot', []]],
  );
  assert.equal(calls[0]?.flags?.noRecord, true);
});

test('runReplayScriptFile propagates Maestro assertNotVisible infrastructure failures', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-assert-not-visible-infra-fail',
    script: ['appId: demo.app', '---', '- assertNotVisible: Archived banner', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      return {
        ok: false,
        error: { code: 'COMMAND_FAILED', message: 'Snapshot capture failed' },
      };
    },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.match(response.error.message, /Replay failed at step 1/);
    assert.match(response.error.message, /Snapshot capture failed/);
  }
  assert.equal(calls.length, 1);
});

test('runReplayScriptFile waits briefly for Maestro assertNotVisible to stabilize', async () => {
  const calls: CapturedInvocation[] = [];
  let snapshots = 0;
  const { response } = await runReplayFixture({
    label: 'maestro-assert-not-visible-stable',
    script: ['appId: demo.app', '---', '- assertNotVisible: Archived banner', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      snapshots += 1;
      if (snapshots === 1) {
        return {
          ok: true,
          data: {
            createdAt: 1,
            nodes: [
              {
                index: 1,
                label: 'Archived banner',
                rect: { x: 10, y: 20, width: 180, height: 44 },
              },
            ],
          },
        };
      }
      return {
        ok: true,
        data: {
          createdAt: snapshots,
          nodes: [],
        },
      };
    },
  });

  assert.equal(response.ok, true);
  assert.equal(calls.length, 2);
});

test('runReplayScriptFile treats absent Maestro extendedWaitUntil.notVisible targets as passing', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'maestro-extended-wait-not-visible-absent',
    script: [
      'appId: demo.app',
      '---',
      '- extendedWaitUntil:',
      '    notVisible: Archived banner',
      '    timeout: 1',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async () => ({
      ok: true,
      data: {
        createdAt: 1,
        nodes: [],
      },
    }),
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['snapshot', []]],
  );
  assert.equal(calls[0]?.flags?.noRecord, true);
});

test('runReplayScriptFile resolves Maestro percentage point taps from the direct viewport', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-point-percent',
    script: ['appId: demo.app', '---', '- tapOn:', '    point: 20%,20%', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    sessionPlatform: 'ios',
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 1000, height: 2000 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['click', ['80', '160']]],
  );
  assert.equal(
    calls.some((call) => call.command === 'snapshot'),
    false,
  );
});

test('runReplayScriptFile retries Maestro id tapOn through snapshot coordinates', async () => {
  const calls: CapturedInvocation[] = [];
  let snapshotAttempts = 0;
  const { response } = await runReplayFixture({
    label: 'maestro-tap-on-retry',
    script: ['appId: demo.app', '---', '- tapOn:', '    id: delayedButton', ''].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        snapshotAttempts += 1;
        if (snapshotAttempts === 3) {
          return {
            ok: true,
            data: {
              nodes: [
                {
                  index: 1,
                  identifier: 'delayedButton',
                  rect: { x: 20, y: 40, width: 120, height: 44 },
                },
              ],
            },
          };
        }
        return { ok: true, data: { nodes: [] } };
      }
      if (req.command === 'click') return { ok: true, data: {} };
      return {
        ok: false,
        error: { code: 'ELEMENT_NOT_FOUND', message: 'element not found' },
      };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['snapshot', []],
      ['snapshot', []],
      ['click', ['80', '62']],
    ],
  );
});

test('runReplayScriptFile resolves Maestro tapOn index and childOf from snapshots', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-index-childof',
    script: [
      'appId: demo.app',
      '---',
      '- tapOn:',
      '    id: childActionButton',
      '    childOf:',
      '      id: parent-row-secondary',
      '- tapOn:',
      '    id: overflowButton',
      '    index: 1',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              { index: 1, identifier: 'parent-row-primary' },
              {
                index: 2,
                parentIndex: 1,
                identifier: 'childActionButton',
                rect: { x: 10, y: 10, width: 40, height: 20 },
              },
              { index: 10, identifier: 'parent-row-secondary' },
              {
                index: 11,
                parentIndex: 10,
                identifier: 'childActionButton',
                rect: { x: 20, y: 120, width: 40, height: 20 },
              },
              {
                index: 20,
                identifier: 'overflowButton',
                rect: { x: 100, y: 200, width: 40, height: 20 },
              },
              {
                index: 21,
                identifier: 'overflowButton',
                rect: { x: 200, y: 300, width: 40, height: 20 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['click', ['40', '130']],
      ['snapshot', []],
      ['click', ['220', '310']],
    ],
  );
  assert.equal(calls[0]?.flags?.noRecord, true);
});

test('runReplayScriptFile lets snapshot id tap handle Maestro one-point edge controls', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-edge-rect',
    script: ['appId: demo.app', '---', '- tapOn:', '    id: hiddenTestLogin', ''].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                identifier: 'hiddenTestLogin',
                rect: { x: 0, y: 0, width: 1, height: 1 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['click', ['0', '0']],
    ],
  );
});

test('runReplayScriptFile resolves a text-entry target once before typing', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-tap-input-text-snapshot',
    script: [
      'appId: demo.app',
      '---',
      '- tapOn:',
      '    id: editableNameInput',
      '- inputText: Saved list',
      '- pressKey: Enter',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                identifier: 'editableNameInput',
                rect: { x: 20, y: 100, width: 200, height: 40 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['click', ['120', '120']],
      ['snapshot', []],
      ['type', ['Saved list']],
      ['snapshot', []],
      ['snapshot', []],
      ['keyboard', ['enter']],
    ],
  );
});

test('runReplayScriptFile resolves Maestro swipe.label from a labeled element rect', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-swipe-label',
    script: [
      'appId: demo.app',
      '---',
      '- swipe:',
      '    label: Thread body',
      '    direction: UP',
      '    duration: 400',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({
        command: req.command,
        positionals: req.positionals,
        input: req.input,
        flags: req.flags,
      });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                label: 'Thread body',
                rect: { x: 10, y: 100, width: 200, height: 300 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.input]),
    [
      ['snapshot', undefined],
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 110, y: 250 },
          delta: { x: 0, y: -210 },
          durationMs: 400,
        },
      ],
    ],
  );
});

test('runReplayScriptFile keeps Maestro swipe.label anchored to the matched label rect', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-swipe-label-child-rect',
    script: [
      'appId: demo.app',
      '---',
      '- swipe:',
      '    label: Article',
      '    direction: UP',
      '    duration: 400',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'ios' },
    invoke: async (req) => {
      calls.push({
        command: req.command,
        positionals: req.positionals,
        input: req.input,
        flags: req.flags,
      });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 1,
                type: 'XCUIElementTypeButton',
                rect: { x: 40, y: 100, width: 120, height: 48 },
                hittable: true,
              },
              {
                index: 2,
                parentIndex: 1,
                type: 'XCUIElementTypeStaticText',
                label: 'Article',
                rect: { x: 76, y: 114, width: 48, height: 20 },
                hittable: false,
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.input]),
    [
      ['snapshot', undefined],
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 100, y: 124 },
          delta: { x: 0, y: -110 },
          durationMs: 400,
        },
      ],
    ],
  );
});

test('runReplayScriptFile resolves Maestro screen swipes from the direct viewport', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-screen-swipe',
    script: [
      'appId: demo.app',
      '---',
      '- swipe:',
      '    direction: LEFT',
      '    duration: 300',
      '- swipe:',
      '    start: 90%,50%',
      '    end: 10%,50%',
      '    duration: 300',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    sessionPlatform: 'ios',
    invoke: async (req) => {
      calls.push({
        command: req.command,
        positionals: req.positionals,
        input: req.input,
        flags: req.flags,
      });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 400, height: 800 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.input]),
    [
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 340, y: 400 },
          delta: { x: -280, y: 0 },
          durationMs: 300,
        },
      ],
      ['snapshot', undefined],
      ['snapshot', undefined],
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 360, y: 400 },
          delta: { x: -320, y: 0 },
          durationMs: 300,
        },
      ],
    ],
  );
});

test('runReplayScriptFile delegates Android directional swipes and preserves percentage points', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-screen-swipe-android-midpoint-lane',
    script: [
      'appId: demo.app',
      '---',
      '- swipe:',
      '    direction: LEFT',
      '    duration: 300',
      '- swipe:',
      '    start: 90%,50%',
      '    end: 10%,50%',
      '    duration: 300',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    sessionPlatform: 'android',
    invoke: async (req) => {
      calls.push({
        command: req.command,
        positionals: req.positionals,
        input: req.input,
        flags: req.flags,
      });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 400, height: 800 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.input]),
    [
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 340, y: 400 },
          delta: { x: -280, y: 0 },
          durationMs: 300,
        },
      ],
      ['snapshot', undefined],
      ['snapshot', undefined],
      [
        'gesture',
        {
          kind: 'pan',
          origin: { x: 360, y: 400 },
          delta: { x: -320, y: 0 },
          durationMs: 300,
        },
      ],
    ],
  );
});

test('runReplayScriptFile maps Maestro enter to keyboard enter', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-press-enter',
    script: ['appId: demo.app', '---', '- pressKey: Enter', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['keyboard', ['enter']]],
  );
});

test('runReplayScriptFile waits for Maestro animation screenshots to stabilize', async () => {
  const calls: CapturedInvocation[] = [];
  const screenshot = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const { response } = await runReplayFixture({
    label: 'maestro-wait-animation-stable',
    script: ['appId: demo.app', '---', '- waitForAnimationToEnd:', '    timeout: 0', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'screenshot') fs.writeFileSync(req.positionals[0]!, screenshot);
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['screenshot', [calls[0]?.positionals?.[0]]],
      ['screenshot', [calls[1]?.positionals?.[0]]],
    ],
  );
  assert.equal(calls[0]?.flags?.screenshotNoStabilize, true);
  assert.equal(calls[1]?.flags?.screenshotNoStabilize, true);
});

test('runReplayScriptFile propagates unsupported keyboard enter dispatch', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-press-enter-unsupported',
    script: ['appId: demo.app', '---', '- pressKey: Enter', ''].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'keyboard') {
        return { ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'unsupported' } };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.equal(response.error.code, 'REPLAY_DIVERGENCE');
    assert.match(response.error.message, /unsupported/);
  }
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['keyboard', ['enter']]],
  );
});

test('runReplayScriptFile retries Maestro retry commands until they pass', async () => {
  const calls: CapturedInvocation[] = [];
  let openAttempts = 0;
  const { response } = await runReplayFixture({
    label: 'maestro-retry',
    script: [
      'appId: demo.app',
      '---',
      '- retry:',
      '    maxRetries: 2',
      '    commands:',
      '      - openLink:',
      '          link: demo://details',
      '      - extendedWaitUntil:',
      '          visible: Article',
      '          timeout: 1',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'open') openAttempts += 1;
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              ...(openAttempts > 1
                ? [
                    {
                      index: 1,
                      depth: 1,
                      parentIndex: 0,
                      type: 'statictext',
                      label: 'Article',
                      rect: { x: 16, y: 100, width: 120, height: 24 },
                    },
                  ]
                : []),
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.filter((call) => call.command === 'open').map((call) => [call.command, call.positionals]),
    [
      ['open', ['demo.app', 'demo://details']],
      ['open', ['demo.app', 'demo://details']],
    ],
  );
  assert.equal(calls.filter((call) => call.command === 'snapshot').length > 1, true);
});

test('runReplayScriptFile propagates Maestro runFlow.when runtime errors', async () => {
  const { response } = await runReplayFixture({
    label: 'maestro-run-flow-when-visible-runtime-error',
    script: [
      'appId: demo.app',
      '---',
      '- runFlow:',
      '    when:',
      '      visible: Continue',
      '    commands:',
      '      - tapOn: Continue',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async () => ({
      ok: false,
      error: { code: 'UNKNOWN', message: 'fetch failed' },
    }),
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    // ADR 0012 migration step 2: the wire-level code is now REPLAY_DIVERGENCE;
    // the original code/message are preserved verbatim in divergence.cause.
    assert.equal(response.error.code, 'REPLAY_DIVERGENCE');
    assert.match(response.error.message, /fetch failed/);
    const divergence = response.error.details?.divergence as
      | { cause: { code: string; message: string }; repairHint: string }
      | undefined;
    assert.equal(divergence?.cause.code, 'UNKNOWN');
    assert.match(divergence?.cause.message ?? '', /fetch failed/);
    assert.equal(divergence?.repairHint, 'manual');
  }
});

test('runReplayScriptFile runs Maestro runFlow.when.visible commands when present', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-run-flow-when-visible-run',
    script: [
      'appId: demo.app',
      '---',
      '- runFlow:',
      '    when:',
      '      visible: Continue',
      '    commands:',
      '      - tapOn: Continue',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              {
                index: 1,
                depth: 1,
                parentIndex: 0,
                type: 'button',
                label: 'Continue',
                rect: { x: 16, y: 100, width: 120, height: 44 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['snapshot', []],
      ['click', ['76', '122']],
    ],
  );
  assert.equal(
    calls.find((call) => call.command === 'click')?.flags?.interactionOutcome,
    undefined,
  );
  assert.equal(
    calls.find((call) => call.command === 'click')?.flags?.postGestureStabilization,
    undefined,
  );
});

test('runReplayScriptFile runs nested Maestro runtime commands inside runFlow.when', async () => {
  const calls: CapturedInvocation[] = [];
  let snapshots = 0;
  const { response } = await runReplayFixture({
    label: 'maestro-run-flow-when-nested-runtime',
    script: [
      'appId: demo.app',
      '---',
      '- runFlow:',
      '    when:',
      '      visible: Feed',
      '    commands:',
      '      - scrollUntilVisible:',
      '          element: Done',
      '          direction: DOWN',
      '          timeout: 500',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        snapshots += 1;
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              {
                index: 1,
                depth: 1,
                parentIndex: 0,
                type: 'statictext',
                label: 'Feed',
                rect: { x: 16, y: 100, width: 120, height: 24 },
              },
              ...(snapshots < 3
                ? []
                : [
                    {
                      index: 2,
                      depth: 1,
                      parentIndex: 0,
                      type: 'statictext',
                      label: 'Done',
                      rect: { x: 16, y: 300, width: 120, height: 24 },
                    },
                  ]),
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['snapshot', []],
      ['scroll', ['down']],
      ['snapshot', []],
      ['snapshot', []],
    ],
  );
});

test('runReplayScriptFile resolves nested Maestro runFlow.when command variables once at execution', async () => {
  const calls: CapturedInvocation[] = [];
  const { response } = await runReplayFixture({
    label: 'maestro-run-flow-when-nested-vars',
    script: [
      'appId: demo.app',
      'env:',
      '  TARGET_LABEL: ${NEXT_LABEL}',
      '  NEXT_LABEL: ${FINAL_LABEL}',
      '  FINAL_LABEL: Done',
      '---',
      '- runFlow:',
      '    when:',
      '      visible: Feed',
      '    commands:',
      '      - tapOn: ${TARGET_LABEL}',
      '',
    ].join('\n'),
    flags: { replayBackend: 'maestro', platform: 'android' },
    invoke: async (req) => {
      calls.push({ command: req.command, positionals: req.positionals, flags: req.flags });
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                type: 'application',
                rect: { x: 0, y: 0, width: 390, height: 844 },
              },
              {
                index: 1,
                depth: 1,
                parentIndex: 0,
                type: 'statictext',
                label: 'Feed',
                rect: { x: 16, y: 100, width: 120, height: 24 },
              },
              {
                index: 2,
                depth: 1,
                parentIndex: 0,
                type: 'button',
                label: 'Done',
                rect: { x: 100, y: 300, width: 80, height: 40 },
              },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [
      ['snapshot', []],
      ['snapshot', []],
      ['click', ['140', '320']],
    ],
  );
});

test('runReplayScriptFile reads shell env from request (client-collected), not daemon process.env', async () => {
  // Ensure the daemon's own process.env does NOT contain AD_VAR_APP.
  assert.equal(process.env.AD_VAR_APP, undefined);
  const { response, calls } = await runReplayFixture({
    label: 'shell',
    script: 'context platform=android\nopen ${APP}\n',
    // Client-collected shell env; still uses the raw AD_VAR_* prefix.
    flags: { replayShellEnv: { AD_VAR_APP: 'client-shell-app' } },
  });
  assert.equal(response.ok, true);
  assert.deepEqual(calls[0]?.positionals, ['client-shell-app']);
});

test('runReplayScriptFile falls back to process.env when request omits replayShellEnv', async () => {
  const previous = process.env.AD_VAR_APP;
  process.env.AD_VAR_APP = 'daemon-env-app';
  try {
    const { response, calls } = await runReplayFixture({
      label: 'shell-fallback',
      script: 'context platform=android\nopen ${APP}\n',
    });
    assert.equal(response.ok, true);
    assert.deepEqual(calls[0]?.positionals, ['daemon-env-app']);
  } finally {
    if (previous === undefined) delete process.env.AD_VAR_APP;
    else process.env.AD_VAR_APP = previous;
  }
});

test('runReplayScriptFile writes per-action timing events to active trace', async () => {
  const root = mkdtempForTestSync('agent-device-replay-trace-');
  const scriptPath = path.join(root, 'flow.ad');
  const tracePath = path.join(root, 'trace.ndjson');
  fs.writeFileSync(scriptPath, 'context platform=ios\nclick id="submit"\nwait "Done" 5000\n');
  fs.writeFileSync(tracePath, '');

  const sessionStore = new SessionStore(path.join(root, 'state'));
  sessionStore.set('s', {
    name: 's',
    device: {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    },
    createdAt: Date.now(),
    trace: { outPath: tracePath, startedAt: Date.now() },
    actions: [],
  });

  const response = await runReplayScriptFile({
    req: {
      token: 't',
      session: 's',
      command: 'replay',
      positionals: [scriptPath],
      flags: {},
      meta: { cwd: root },
    },
    sessionName: 's',
    logPath: path.join(root, 'log'),
    sessionStore,
    invoke: async (req) => ({
      ok: true,
      data:
        req.command === 'click'
          ? { timing: { totalDurationMs: 12, internal: { ignored: true } } }
          : {},
    }),
  });

  assert.equal(response.ok, true);
  const events = fs
    .readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    events.map((event) => [event.type, event.step, event.command]),
    [
      ['replay_action_start', 1, 'click'],
      ['replay_action_stop', 1, 'click'],
      ['replay_action_start', 2, 'wait'],
      ['replay_action_stop', 2, 'wait'],
    ],
  );
  assert.equal(typeof events[1]?.durationMs, 'number');
  assert.deepEqual(events[1]?.resultTiming, { totalDurationMs: 12 });
});

test('AD_ARTIFACTS resolves to per-attempt dir when artifactsDir flag is set by the test runner', async () => {
  const attemptDir = '/tmp/agent-device-replay-artifacts-stub/run-x/flow/attempt-1';
  const { response, calls } = await runReplayFixture({
    label: 'artifacts',
    script: 'context platform=android\nscreenshot "${AD_ARTIFACTS}/shot.png"\n',
    flags: { artifactsDir: attemptDir },
  });
  assert.equal(response.ok, true);
  assert.deepEqual(calls[0]?.positionals, [`${attemptDir}/shot.png`]);
});
