import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import path from 'node:path';
import {
  createHarmonyHostStub,
  createHarmonyToolchainRoot,
  harmonyCommandPath,
} from './toolbox.fixtures.ts';
import { createHarmonyInventory, parseHarmonyTargetList } from './inventory.ts';

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('Harmony inventory parses targets and applies serial selection', async () => {
  assert.deepEqual(parseHarmonyTargetList('\n127.0.0.1:5555\n[Empty]\n'), ['127.0.0.1:5555']);
  const stub = createHarmonyHostStub({
    respond: (_executable, args) => {
      const key = args.join('\0');
      if (key === 'list\0targets') return { stdout: 'emulator-1\nphysical-1\n' };
      if (key.includes('const.product.name')) {
        return { stdout: key.startsWith('-t\0emulator-1') ? 'emulator\n' : 'Mate 60\n' };
      }
      if (key.includes('const.build.characteristics')) return { stdout: 'tv\n' };
      throw new Error(`Unexpected HDC invocation: ${key}`);
    },
  });

  const devices = await createHarmonyInventory(stub.toolbox).discover(
    { serial: 'physical-1' },
    scope,
  );

  assert.deepEqual(devices, [
    {
      platform: 'harmonyos',
      id: 'physical-1',
      name: 'Mate 60',
      kind: 'device',
      target: 'tv',
      booted: true,
    },
  ]);
  // Discovery is host-owned: every command names the executable and the target selection, never a
  // shell string.
  assert.ok(
    stub.commands.every((command) => command.args[0] === '-t' || command.args[0] === 'list'),
  );
  assert.ok(
    stub.commands
      .filter((command) => command.args[0] === '-t')
      .every((command) => command.args[1] === 'physical-1'),
  );
});

test('Harmony inventory spawns the HDC a documented root carries and puts that root on PATH', async () => {
  const root = createHarmonyToolchainRoot();
  const stub = createHarmonyHostStub({
    env: { HDC_SDK_PATH: root, PATH: '/usr/bin' },
    respond: (_executable, args) =>
      args.join('\0') === 'list\0targets' ? { stdout: '[Empty]\n' } : { stdout: '' },
  });

  assert.deepEqual(await createHarmonyInventory(stub.toolbox).discover({}, scope), []);

  const command = stub.commands[0]!;
  assert.equal(command.executable, path.join(root, 'hdc'));
  assert.deepEqual(command.args, ['list', 'targets']);
  assert.ok(harmonyCommandPath(command).includes(root));
});

test('Harmony inventory hands the host environment plus the toolchain root to every command', async () => {
  const root = createHarmonyToolchainRoot();
  const stub = createHarmonyHostStub({
    env: { HDC_SDK_PATH: root, PATH: '/usr/bin', HOME: '/host-home' },
    respond: (_executable, args) =>
      args.join('\0') === 'list\0targets' ? { stdout: '[Empty]\n' } : { stdout: '' },
  });

  await createHarmonyInventory(stub.toolbox).discover({}, scope);

  // The plugin never reads `process.env`: what the host named is what the spawn gets, with only
  // PATH extended.
  assert.deepEqual(stub.commands[0]!.env, {
    HDC_SDK_PATH: root,
    HOME: '/host-home',
    PATH: [root, '/usr/bin'].join(path.delimiter),
  });
});

test('Harmony inventory preserves the curated HDC failure shape', async () => {
  const stub = createHarmonyHostStub({
    respond: () => ({ stdout: 'ignored', stderr: 'transport failed', exitCode: 7 }),
  });

  await assert.rejects(
    createHarmonyInventory(stub.toolbox).discover({}, scope),
    (error: unknown) => {
      if (!(error instanceof Error) || !('details' in error)) return false;
      assert.deepEqual(error.details, {
        stderr: 'transport failed',
        hint: 'Confirm the HarmonyOS emulator or device is running, then run hdc list targets.',
      });
      return true;
    },
  );
});

test('Harmony inventory names the toolchain roots when no root or PATH carries HDC', async () => {
  // The host rejects a spawn it cannot start with its own typed TOOL_MISSING, so the curated
  // missing-toolchain error has to come from the HDC route rather than from an exit code.
  const stub = createHarmonyHostStub({
    reject: () => new AppError('TOOL_MISSING', 'hdc not found in PATH', { cmd: 'hdc' }),
  });

  await assert.rejects(
    createHarmonyInventory(stub.toolbox).discover({}, scope),
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
