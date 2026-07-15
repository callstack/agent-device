import { test, vi } from 'vitest';

// ADR 0012 migration step 2: every replay step failure now attempts a
// post-failure screen digest capture + suggestion re-resolution, both via
// dispatchCommand('snapshot', ...). None of this file's fixtures model a real
// device runner, so without a mock those calls fall through to the real
// (slow/hanging) runner dispatch path. Reject fast so failure-path tests keep
// exercising `divergence.screen: unavailable` deterministically, exactly like
// a real capture failure would.
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
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../../kernel/errors.ts';
import { PNG } from '../../../utils/png.ts';
import { runCmdBackground, type ExecBackgroundResult } from '../../../utils/exec.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionAction } from '../../types.ts';
import type { CommandFlags } from '../../../core/dispatch.ts';
import { SessionStore } from '../../session-store.ts';
import { makeAndroidSession, makeIosSession } from '../../../__tests__/test-utils/index.ts';
import {
  buildReplayVarScope,
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  resolveReplayAction,
  resolveReplayString,
} from '../../../replay/vars.ts';
import { parseReplayScriptDetailed, readReplayScriptMetadata } from '../../../replay/script.ts';
import { runReplayScriptFile } from '../session-replay-runtime.ts';

const LOC = { file: 'test.ad', line: 1 };

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agent-device-replay-${params.label}-`));
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

async function readFirstStdoutLine(process: ExecBackgroundResult): Promise<string> {
  return await new Promise((resolve, reject) => {
    let stdout = '';
    const cleanup = (): void => {
      clearTimeout(timer);
      process.child.stdout?.off('data', onData);
      process.child.off('exit', onExit);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for child process stdout.'));
    }, 5000);
    const onData = (chunk: Buffer | string): void => {
      stdout += String(chunk);
      const lineEnd = stdout.indexOf('\n');
      if (lineEnd === -1) return;
      cleanup();
      resolve(stdout.slice(0, lineEnd));
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error('Child process exited before writing stdout.'));
    };
    process.child.stdout?.on('data', onData);
    process.child.on('exit', onExit);
  });
}

test('resolveReplayString substitutes variables', () => {
  const scope = buildReplayVarScope({ fileEnv: { APP: 'settings' } });
  assert.equal(resolveReplayString('open ${APP}', scope, LOC), 'open settings');
});

test('resolveReplayString supports fallback with :-default', () => {
  const scope = buildReplayVarScope({});
  assert.equal(resolveReplayString('wait ${WAIT_SHORT:-500}', scope, LOC), 'wait 500');
});

test('resolveReplayString prefers scope value over fallback', () => {
  const scope = buildReplayVarScope({ fileEnv: { WAIT_SHORT: '1000' } });
  assert.equal(resolveReplayString('wait ${WAIT_SHORT:-500}', scope, LOC), 'wait 1000');
});

test('resolveReplayString fallback preserves embedded braces via escapes', () => {
  const scope = buildReplayVarScope({});
  assert.equal(resolveReplayString('x ${A:-one\\}two}', scope, LOC), 'x one}two');
});

test('resolveReplayString throws on unresolved variable with file:line', () => {
  const scope = buildReplayVarScope({ fileEnv: { OTHER: 'x' } });
  assert.throws(
    () => resolveReplayString('open ${MISSING}', scope, { file: 'a.ad', line: 7 }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Unresolved variable \$\{MISSING\} at a\.ad:7/.test(error.message),
  );
});

test('resolveReplayString is case-sensitive', () => {
  const scope = buildReplayVarScope({ fileEnv: { APP: 'settings' } });
  assert.throws(() => resolveReplayString('${app}', scope, LOC), AppError);
});

test('resolveReplayString substitutes multiple vars on one line', () => {
  const scope = buildReplayVarScope({ fileEnv: { A: '1', B: '2' } });
  assert.equal(resolveReplayString('${A}-${B}-${A}', scope, LOC), '1-2-1');
});

test('buildReplayVarScope precedence: cli > shell > file > builtin', () => {
  const scope = buildReplayVarScope({
    builtins: { K: 'builtin' },
    fileEnv: { K: 'file' },
    shellEnv: { K: 'shell' },
    cliEnv: { K: 'cli' },
  });
  assert.equal(scope.values.K, 'cli');

  const shellWinsOverFile = buildReplayVarScope({
    fileEnv: { K: 'file' },
    shellEnv: { K: 'shell' },
  });
  assert.equal(shellWinsOverFile.values.K, 'shell');
});

test('collectReplayShellEnv strips AD_VAR_ prefix and ignores other vars', () => {
  const result = collectReplayShellEnv({
    AD_VAR_APP_ID: 'settings',
    PATH: '/bin',
    AD_VAR_123: 'x',
    AD_VAR_: 'empty',
    OTHER_VAR: 'y',
    AD_APP_ID: 'no-legacy-prefix',
  });
  assert.equal(result.APP_ID, 'settings');
  assert.equal(result.PATH, undefined);
  assert.equal(result['123'], undefined);
  assert.equal(result[''], undefined);
  // legacy AD_* (non AD_VAR_*) is no longer auto-imported.
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'AD_APP_ID'), false);
});

test('collectReplayShellEnv skips keys that land in reserved AD_* namespace after strip', () => {
  const result = collectReplayShellEnv({
    AD_VAR_AD_SESSION: 'evil',
    AD_VAR_AD_FOO: 'evil',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'AD_SESSION'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'AD_FOO'), false);
});

test('parseReplayCliEnvEntries splits KEY=VALUE and rejects invalid keys', () => {
  assert.deepEqual(parseReplayCliEnvEntries(['APP=settings', 'FOO=bar=baz']), {
    APP: 'settings',
    FOO: 'bar=baz',
  });
  assert.throws(() => parseReplayCliEnvEntries(['NOEQUAL']), AppError);
  assert.throws(() => parseReplayCliEnvEntries(['lower=x']), AppError);
  assert.throws(() => parseReplayCliEnvEntries(['=value']), AppError);
});

test('resolveReplayAction walks positionals and string flags', () => {
  const action: SessionAction = {
    ts: 0,
    command: 'snapshot',
    positionals: ['${FOO}'],
    flags: {
      snapshotScope: '${SCOPE}',
      snapshotInteractiveOnly: true,
      snapshotDepth: 3,
    },
  };
  const scope = buildReplayVarScope({ fileEnv: { FOO: 'bar', SCOPE: 'app' } });
  const resolved = resolveReplayAction(action, scope, LOC);
  assert.deepEqual(resolved.positionals, ['bar']);
  assert.equal(resolved.flags?.snapshotScope, 'app');
  assert.equal(resolved.flags?.snapshotInteractiveOnly, true);
  assert.equal(resolved.flags?.snapshotDepth, 3);
});

test('resolveReplayAction walks runtime hints', () => {
  const action: SessionAction = {
    ts: 0,
    command: 'open',
    positionals: [],
    runtime: { platform: 'android', metroHost: '${HOST}' },
    flags: {},
  };
  const scope = buildReplayVarScope({ fileEnv: { HOST: '10.0.0.1' } });
  const resolved = resolveReplayAction(action, scope, LOC);
  assert.equal(resolved.runtime?.metroHost, '10.0.0.1');
});

test('parseReplayScriptDetailed tracks line numbers', () => {
  const script = [
    '# comment',
    'context platform=android',
    'env APP=settings',
    '',
    'open ${APP}',
    'wait 500',
  ].join('\n');
  const parsed = parseReplayScriptDetailed(script);
  assert.equal(parsed.actions.length, 2);
  assert.deepEqual(parsed.actionLines, [5, 6]);
});

test('readReplayScriptMetadata parses env KEY=VALUE directives', () => {
  const metadata = readReplayScriptMetadata(
    'context platform=android\nenv APP=settings\nenv WAIT=500\nopen ${APP}\n',
  );
  assert.equal(metadata.env?.APP, 'settings');
  assert.equal(metadata.env?.WAIT, '500');
});

test('readReplayScriptMetadata accepts env before context', () => {
  const metadata = readReplayScriptMetadata(
    'env APP=settings\ncontext platform=ios target=mobile\n',
  );
  assert.equal(metadata.platform, 'ios');
  assert.equal(metadata.target, 'mobile');
  assert.equal(metadata.env?.APP, 'settings');
});

test('readReplayScriptMetadata parses quoted env values with spaces', () => {
  const metadata = readReplayScriptMetadata(
    'context platform=android\nenv SEL="label=Wait || label=Apps"\n',
  );
  assert.equal(metadata.env?.SEL, 'label=Wait || label=Apps');
});

test('readReplayScriptMetadata rejects invalid env key', () => {
  assert.throws(
    () => readReplayScriptMetadata('context platform=android\nenv lower=settings\n'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Invalid env key "lower"/.test(error.message),
  );
});

test('readReplayScriptMetadata rejects duplicate env key', () => {
  assert.throws(
    () => readReplayScriptMetadata('context platform=android\nenv APP=a\nenv APP=b\n'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Duplicate env directive "APP"/.test(error.message),
  );
});

// ADR 0012 decision 1 / migration step 6: `--update` retirement removed the
// env/interpolation/compat-flow refusal guards below — they existed only to
// protect the now-deleted heal-and-rewrite path, which could not safely
// round-trip `env`/`${VAR}` or serialize Maestro's in-memory flow controls
// back to `.ad`. With no rewrite, `--update` no longer needs to refuse
// anything; it runs exactly like a plain replay.

test('--update no longer rejects scripts with env directives (the guard existed only for rewrite safety)', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'env-heal',
    script: 'context platform=android\nenv APP=settings\nopen ${APP}\n',
    flags: { replayUpdate: true },
  });
  assert.equal(response.ok, true);
  assert.deepEqual(calls[0]?.positionals, ['settings']);
});

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

test('resolveReplayAction produces dispatch-ready literals for a realistic fixture', () => {
  const script = [
    'context platform=android',
    'env APP_ID=settings',
    'env WAIT_SHORT=500',
    'env SETTINGS_ITEMS="label=Wait || label=Apps"',
    '',
    'open ${APP_ID} --relaunch',
    'wait ${WAIT_SHORT}',
    'click "${SETTINGS_ITEMS}"',
    'is exists "${SETTINGS_ITEMS}"',
    'snapshot -s "${SNAPSHOT_SCOPE:-app}"',
  ].join('\n');
  const metadata = readReplayScriptMetadata(script);
  const parsed = parseReplayScriptDetailed(script);
  const scope = buildReplayVarScope({
    builtins: { AD_PLATFORM: 'android' },
    fileEnv: metadata.env,
    shellEnv: { APP_ID: 'shell-wins' },
    cliEnv: { APP_ID: 'cli-wins' },
  });
  const resolved = parsed.actions.map((action, index) =>
    resolveReplayAction(action, scope, {
      file: 'fixture.ad',
      line: parsed.actionLines[index] ?? 0,
    }),
  );
  assert.deepEqual(resolved[0]?.positionals, ['cli-wins']);
  assert.equal(resolved[0]?.flags.relaunch, true);
  assert.deepEqual(resolved[1]?.positionals, ['500']);
  assert.deepEqual(resolved[2]?.positionals, ['label=Wait || label=Apps']);
  assert.deepEqual(resolved[3]?.positionals, ['exists', 'label=Wait || label=Apps']);
  assert.equal(resolved[4]?.flags.snapshotScope, 'app');
});

test.each([
  {
    name: 'file env via parseReplayEnvLine',
    run: () => readReplayScriptMetadata('context platform=android\nenv AD_FOO=bar\n'),
    keyMatch: /AD_FOO/,
  },
  {
    name: 'CLI -e via parseReplayCliEnvEntries',
    run: () => parseReplayCliEnvEntries(['AD_FOO=x']),
    keyMatch: /AD_FOO/,
  },
  {
    name: 'buildReplayVarScope.fileEnv',
    run: () => buildReplayVarScope({ fileEnv: { AD_FOO: 'x' } }),
    keyMatch: /AD_FOO/,
  },
  {
    name: 'buildReplayVarScope.cliEnv',
    run: () => buildReplayVarScope({ cliEnv: { AD_SESSION: 'x' } }),
    keyMatch: /AD_SESSION/,
  },
])('rejects AD_* as reserved namespace in $name', ({ run, keyMatch }) => {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /AD_\* namespace is reserved/.test(error.message) &&
      keyMatch.test(error.message),
  );
});

test('parseReplayCliEnvEntries error wording is user-friendly for invalid keys', () => {
  assert.throws(
    () => parseReplayCliEnvEntries(['lower=x']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /uppercase letters, digits, and underscores/.test(error.message),
  );
});

// fallow-ignore-next-line complexity
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
  // open ${APP} -> CLI override wins.
  assert.equal(calls[0]?.command, 'open');
  assert.deepEqual(calls[0]?.positionals, ['cli-app']);
  // snapshot -s ${SCOPE} -> file env fills in.
  assert.equal(calls[1]?.command, 'snapshot');
  assert.equal(calls[1]?.flags?.snapshotScope, 'file-scope');
  // click with ${AD_FILENAME} resolves to the relative script path.
  assert.equal(calls[2]?.command, 'click');
  assert.deepEqual(calls[2]?.positionals, ['at flow.ad']);
  // And nothing dispatched still contains a literal ${...} token.
  for (const call of calls) {
    for (const pos of call.positionals ?? []) {
      assert.equal(pos.includes('${'), false, `unresolved interpolation leaked: ${pos}`);
    }
  }
});

test('.ad replay normalizes resolved gesture and swipe syntax into structured daemon input', async () => {
  const { response, calls } = await runReplayFixture({
    label: 'structured-gesture-input',
    script: [
      'env X=10',
      'gesture pan ${X} 20 30 40 500 --pointer-count 2',
      'swipe ${X} 20 30 40 300 --count 2 --pause-ms 5 --pattern ping-pong',
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
          durationMs: 300,
          count: 2,
          pauseMs: 5,
          pattern: 'ping-pong',
        },
      },
    ],
  );
});

test('runReplayScriptFile reports snapshot diagnostics from per-action session samples', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-snapshot-samples-'));
  const scriptPath = path.join(root, 'flow.ad');
  fs.writeFileSync(scriptPath, ['snapshot', 'snapshot', ''].join('\n'));
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
  assert.equal(diagnostics?.stats?.count, 2);
  assert.match(String(diagnostics?.warning), /p95 1900ms over 2 captures/);
});

test('runReplayScriptFile reports snapshot diagnostics on replay failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-snapshot-failure-'));
  const scriptPath = path.join(root, 'flow.ad');
  fs.writeFileSync(scriptPath, ['snapshot', 'click "Missing"', ''].join('\n'));
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
      if (captures === 1) return { ok: true, data: {} };
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'button missing' } };
    },
  });

  assert.equal(response.ok, false);
  const diagnostics = response.error.details?.snapshotDiagnostics as
    | { stats?: { count?: number; p95Ms?: number }; warning?: string }
    | undefined;
  assert.equal(diagnostics?.stats?.count, 2);
  assert.equal(diagnostics?.stats?.p95Ms, 2_100);
  assert.match(String(diagnostics?.warning), /p95 2100ms over 2 captures/);
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
  const serverScript = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-runscript-http-')),
    'server.cjs',
  );
  fs.writeFileSync(
    serverScript,
    `
const http = require('node:http');
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({method: req.method, body}));
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port) + '\\n');
});
`,
  );
  const server = runCmdBackground(process.execPath, [serverScript], { allowFailure: true });
  const port = await readFirstStdoutLine(server);

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
    server.child.kill();
    await server.wait.catch(() => undefined);
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
      ['swipe', { from: { x: 110, y: 250 }, to: { x: 110, y: 40 }, durationMs: 400 }],
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
      ['swipe', { from: { x: 100, y: 124 }, to: { x: 100, y: 14 }, durationMs: 400 }],
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
        'swipe',
        {
          from: { x: 340, y: 400 },
          to: { x: 60, y: 400 },
          durationMs: 300,
        },
      ],
      ['snapshot', undefined],
      ['snapshot', undefined],
      ['swipe', { from: { x: 360, y: 400 }, to: { x: 40, y: 400 }, durationMs: 300 }],
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
        'swipe',
        {
          from: { x: 340, y: 400 },
          to: { x: 60, y: 400 },
          durationMs: 300,
        },
      ],
      ['snapshot', undefined],
      ['snapshot', undefined],
      ['swipe', { from: { x: 360, y: 400 }, to: { x: 40, y: 400 }, durationMs: 300 }],
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-trace-'));
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
