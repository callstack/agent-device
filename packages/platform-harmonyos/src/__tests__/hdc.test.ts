import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { AppError, asAppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  createHarmonyHostStub,
  createHarmonyToolchainRoot,
  harmonyCommandPath,
} from '../toolbox.fixtures.ts';
import { createHarmonyCommandRunner } from '../command-host.ts';
import { DEFAULT_HARMONY_HDC_TIMEOUT_MS } from '../hdc.ts';

const DEVICE = { id: 'target-1' };

test('the HDC route bounds ordinary commands with its default timeout', async () => {
  const stub = createHarmonyHostStub();
  await stub.toolbox.hdc.runShell(DEVICE, ['uitest', 'uiInput', 'click', '10', '20']);

  assert.deepEqual(stub.commands[0], {
    executable: 'hdc',
    args: ['-t', 'target-1', 'shell', 'uitest', 'uiInput', 'click', '10', '20'],
    env: { PATH: '/usr/bin' },
    timeoutMs: DEFAULT_HARMONY_HDC_TIMEOUT_MS,
    allowFailure: undefined,
    signal: undefined,
  });
});

test('the HDC route preserves an operation-specific timeout', async () => {
  const stub = createHarmonyHostStub();
  await stub.toolbox.hdc.run(DEVICE, ['install', '-r', '/tmp/example.hap'], {
    timeoutMs: 180_000,
  });

  assert.equal(stub.commands[0]?.timeoutMs, 180_000);
});

test('the HDC route forwards a binding abort signal to an in-flight command', async () => {
  const controller = new AbortController();
  const stub = createHarmonyHostStub();

  await stub.toolbox.hdc.run(DEVICE, ['install', '-r', '/tmp/example.hap'], {
    signal: controller.signal,
  });

  // The host owns the child, so the plugin's job is to hand the signal over with the request.
  assert.equal(stub.commands[0]?.signal, controller.signal);
});

test('the HDC route escapes shell words for HDC quoting', async () => {
  const stub = createHarmonyHostStub();
  await stub.toolbox.hdc.runShell(DEVICE, ['uitest', 'uiInput', 'text', 'hello; reboot']);
  await stub.toolbox.hdc.runShell(DEVICE, [
    'uitest',
    'uiInput',
    'inputText',
    307,
    1334,
    '$(id) "x" `y`',
  ]);
  await stub.toolbox.hdc.run(DEVICE, ['file', 'recv', '/data/a.png', '/tmp/a.png']);

  assert.deepEqual(
    stub.commands.map((command) => [command.executable, command.args]),
    [
      ['hdc', ['-t', 'target-1', 'shell', 'uitest', 'uiInput', 'text', 'hello; reboot']],
      [
        'hdc',
        [
          '-t',
          'target-1',
          'shell',
          'uitest',
          'uiInput',
          'inputText',
          '307',
          '1334',
          '\\$(id) \\"x\\" \\`y\\`',
        ],
      ],
      ['hdc', ['-t', 'target-1', 'file', 'recv', '/data/a.png', '/tmp/a.png']],
    ],
  );
});

test('the HDC route refuses a raw shell argv before asking the host', async () => {
  const stub = createHarmonyHostStub();

  await assert.rejects(
    stub.toolbox.hdc.run(DEVICE, ['shell', 'uitest', 'uiInput', 'text', 'x']),
    (error: unknown) =>
      error instanceof Error &&
      'details' in error &&
      (error as { details?: { reason?: string } }).details?.reason ===
        'unguarded-device-shell-argv',
  );
  assert.equal(stub.commands.length, 0);
});

test('the HDC route spawns the HDC a documented root carries and puts that root on PATH', async () => {
  const root = createHarmonyToolchainRoot();
  const stub = createHarmonyHostStub({ env: { HDC_SDK_PATH: root, PATH: '/usr/bin' } });

  assert.equal(await stub.toolbox.hdc.executable(), path.join(root, 'hdc'));
  await stub.toolbox.hdc.launch(['list', 'targets']);

  assert.equal(stub.commands[0]?.executable, path.join(root, 'hdc'));
  assert.deepEqual(harmonyCommandPath(stub.commands[0]!), [root, '/usr/bin']);
});

test('the HDC route answers a host spawn refusal with the curated toolchain error', async () => {
  // The host refused a spawn of the bare name it could not resolve from PATH.
  const stub = createHarmonyHostStub({
    reject: () => new AppError('TOOL_MISSING', 'hdc not found in PATH', { cmd: 'hdc' }),
  });

  await assert.rejects(
    // Any command, not only the discovery probe, gets the curated error.
    stub.toolbox.hdc.run(DEVICE, ['bm', 'dump', '-a']),
    (error: unknown) => {
      const failure = asAppError(error);
      assert.equal(failure.code, 'TOOL_MISSING');
      assert.equal(failure.message, 'hdc not found in PATH');
      assert.equal(
        failure.details?.hint,
        'Install HarmonyOS Command Line Tools, then add its sdk/default/openharmony/toolchains directory to PATH or set HDC_SDK_PATH.',
      );
      return true;
    },
  );
});

test('the HDC route names the resolved path when the host refuses an absolute HDC', async () => {
  const root = createHarmonyToolchainRoot();
  const stub = createHarmonyHostStub({
    env: { HDC_SDK_PATH: root, PATH: '/usr/bin' },
    reject: () => new AppError('TOOL_MISSING', 'hdc not found in PATH', { cmd: 'hdc' }),
  });

  await assert.rejects(stub.toolbox.hdc.launch(['list', 'targets']), (error: unknown) => {
    const failure = asAppError(error);
    // The plugin resolved a documented root, so the message names where it looked.
    assert.equal(failure.message, `hdc not found at ${path.join(root, 'hdc')}`);
    return true;
  });
});

test('the HDC route leaves another host rejection as the host reported it', async () => {
  const canceled = createRequestCanceledError({ cmd: 'hdc' });
  const stub = createHarmonyHostStub({ reject: () => canceled });

  await assert.rejects(stub.toolbox.hdc.launch(['list', 'targets']), (error: unknown) =>
    Object.is(error, canceled),
  );
});

test('the command runner prefers the roots in the documented order', async () => {
  const hdcSdk = createHarmonyToolchainRoot();
  const deveco = createHarmonyToolchainRoot();
  const commands = createHarmonyCommandRunner(
    createHarmonyHostStub({ env: { HDC_SDK_PATH: hdcSdk, DEVECO_SDK_HOME: deveco } }).host,
  );

  assert.equal(await commands.resolveHdc(), path.join(hdcSdk, 'hdc'));
});

test('the command runner derives the toolchains directory from the DevEco SDK layout', async () => {
  // The documented layout is <DEVECO_SDK_HOME>/default/openharmony/toolchains/hdc.
  const home = mkdtempForTestSync('harmony-deveco-');
  const toolchains = path.join(home, 'default', 'openharmony', 'toolchains');
  fs.mkdirSync(toolchains, { recursive: true });
  fs.writeFileSync(path.join(toolchains, 'hdc'), '#!/bin/sh\necho stub\n', { mode: 0o755 });
  const commands = createHarmonyCommandRunner(
    createHarmonyHostStub({ env: { DEVECO_SDK_HOME: home } }).host,
  );

  assert.equal(await commands.resolveHdc(), path.join(toolchains, 'hdc'));
});

test('the command runner ignores a root whose hdc is not executable', async () => {
  const root = createHarmonyToolchainRoot();
  const commands = createHarmonyCommandRunner(
    createHarmonyHostStub({ env: { HDC_SDK_PATH: `${root}/missing`, PATH: '/bin' } }).host,
  );

  assert.equal(await commands.toolchainHdc(), undefined);
  assert.equal(await commands.resolveHdc(), 'hdc');
});

test('the command runner dedupes a root already on PATH', async () => {
  const root = createHarmonyToolchainRoot();
  const stub = createHarmonyHostStub({
    env: { HDC_SDK_PATH: root, PATH: ['/usr/bin', root].join(path.delimiter) },
  });

  await stub.toolbox.hdc.launch(['list', 'targets']);

  assert.deepEqual(harmonyCommandPath(stub.commands[0]!), [root, '/usr/bin']);
});
