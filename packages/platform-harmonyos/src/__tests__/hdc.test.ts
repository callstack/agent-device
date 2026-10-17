import { bindTestCommandHost } from '@agent-device/test-kit';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});

import { runCmd } from '@agent-device/host-kit/command';
import {
  DEFAULT_HARMONY_HDC_TIMEOUT_MS,
  ensureHarmonyToolchainPathConfigured,
  runHarmonyHdc,
  runHarmonyShell,
} from '../hdc.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

bindTestCommandHost();

const mockRunCmd = vi.mocked(runCmd);
const device = { id: '127.0.0.1:5555' };

beforeEach(() => {
  mockRunCmd.mockReset();
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

test('runHarmonyHdc bounds ordinary HDC commands by a default timeout', async () => {
  await runHarmonyShell(device, ['uitest', 'uiInput', 'click', '10', '20']);

  assert.deepEqual(mockRunCmd.mock.calls[0], [
    'hdc',
    ['-t', '127.0.0.1:5555', 'shell', 'uitest', 'uiInput', 'click', '10', '20'],
    { timeoutMs: DEFAULT_HARMONY_HDC_TIMEOUT_MS },
  ]);
});

test('runHarmonyHdc preserves an operation-specific timeout', async () => {
  await runHarmonyHdc(device, ['install', '-r', '/tmp/example.hap'], { timeoutMs: 180_000 });

  assert.deepEqual(mockRunCmd.mock.calls[0]?.[2], { timeoutMs: 180_000 });
});

test('runHarmonyHdc forwards a binding abort signal to an in-flight HDC command', async () => {
  const controller = new AbortController();
  const aborted = new Error('request aborted');
  mockRunCmd.mockImplementation(
    async (_cmd, _args, options) =>
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      }),
  );

  const pending = runHarmonyHdc(device, ['install', '-r', '/tmp/example.hap'], {
    signal: controller.signal,
  });
  controller.abort(aborted);

  await assert.rejects(pending, (error: unknown) => error === aborted);
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.signal, controller.signal);
});

/** HDC_SDK_PATH names the toolchains directory itself, so `HDC_SDK_PATH/hdc` must exist. */
async function seedDirectToolchain(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const hdc = path.join(root, 'hdc');
  await fs.writeFile(hdc, '#!/bin/sh\nexit 0\n', 'utf8');
  await fs.chmod(hdc, 0o755);
  return root;
}

/** DevEco's home joins `default/openharmony/toolchains`; the command-line-tools root adds `sdk` first. */
async function seedNestedToolchain(root: string, ...segments: string[]): Promise<string> {
  const toolchains = path.join(root, ...segments, 'default', 'openharmony', 'toolchains');
  await fs.mkdir(toolchains, { recursive: true });
  const hdc = path.join(toolchains, 'hdc');
  await fs.writeFile(hdc, '#!/bin/sh\nexit 0\n', 'utf8');
  await fs.chmod(hdc, 0o755);
  return root;
}

test('ensureHarmonyToolchainPathConfigured prepends every root holding an hdc binary', async () => {
  const hdcSdkRoot = await seedDirectToolchain(mkdtempForTestSync('agent-device-hdc-sdk-'));
  const devecoRoot = await seedNestedToolchain(mkdtempForTestSync('agent-device-hdc-deveco-'));
  const cmdlineRoot = await seedNestedToolchain(
    mkdtempForTestSync('agent-device-hdc-cmdline-'),
    'sdk',
  );

  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HDC_SDK_PATH: hdcSdkRoot,
    DEVECO_SDK_HOME: devecoRoot,
    HARMONYOS_COMMAND_LINE_TOOLS: cmdlineRoot,
  };

  await ensureHarmonyToolchainPathConfigured(env);

  assert.deepEqual((env.PATH ?? '').split(path.delimiter), [
    hdcSdkRoot,
    path.join(devecoRoot, 'default', 'openharmony', 'toolchains'),
    path.join(cmdlineRoot, 'sdk', 'default', 'openharmony', 'toolchains'),
    '/usr/bin',
  ]);
});

test('ensureHarmonyToolchainPathConfigured leaves PATH untouched when no root holds hdc', async () => {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HDC_SDK_PATH: '   ',
    DEVECO_SDK_HOME: mkdtempForTestSync('agent-device-hdc-none-'),
    HARMONYOS_COMMAND_LINE_TOOLS: mkdtempForTestSync('agent-device-hdc-none-'),
  };

  await ensureHarmonyToolchainPathConfigured(env);

  assert.equal(env.PATH, '/usr/bin');
});

test('ensureHarmonyToolchainPathConfigured creates PATH and dedupes a root already on it', async () => {
  const toolchains = await seedDirectToolchain(mkdtempForTestSync('agent-device-hdc-dup-'));

  const env: NodeJS.ProcessEnv = {
    PATH: `/usr/bin${path.delimiter}${toolchains}`,
    HDC_SDK_PATH: toolchains,
  };
  await ensureHarmonyToolchainPathConfigured(env);

  // The toolchain root moves to the front instead of appearing twice.
  assert.equal(env.PATH, [toolchains, '/usr/bin'].join(path.delimiter));

  const missingPath: NodeJS.ProcessEnv = { HDC_SDK_PATH: toolchains };
  await ensureHarmonyToolchainPathConfigured(missingPath);
  assert.equal(missingPath.PATH, toolchains);
});

test('ensureHarmonyToolchainPathConfigured defaults to the host environment', async () => {
  const toolchains = await seedDirectToolchain(mkdtempForTestSync('agent-device-hdc-host-'));
  vi.stubEnv('PATH', '/usr/bin');
  vi.stubEnv('HDC_SDK_PATH', toolchains);

  await ensureHarmonyToolchainPathConfigured();

  assert.equal(process.env.PATH, [toolchains, '/usr/bin'].join(path.delimiter));
});
