import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { mkdtempForTestSync } from './__tests__/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(), whichCmd: vi.fn() };
});

import { runCmd, whichCmd, withCommandHost } from '@agent-device/host-kit/command';
import { vegaPlugin } from './index.ts';

const VEGA_VVD = {
  platform: 'vega',
  id: 'VirtualDevice',
  name: 'Vega Virtual Device',
  kind: 'emulator',
  target: 'tv',
  booted: true,
} satisfies DeviceInfo;

const mockRunCmd = vi.mocked(runCmd);
const mockWhichCmd = vi.mocked(whichCmd);

const scratch = mkdtempForTestSync('vega-plugin-host-binding-');
const hostAPathDir = path.join(scratch, 'host-a', 'bin');
const hostBHome = path.join(scratch, 'host-b', 'home');
const processHome = path.join(scratch, 'process-home');
for (const dir of [hostAPathDir, path.join(hostBHome, 'vega', 'bin'), processHome]) {
  mkdirSync(dir, { recursive: true });
}
for (const file of [path.join(hostAPathDir, 'vega'), path.join(hostBHome, 'vega', 'bin', 'vega')]) {
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
}

const originalEnv = { ...process.env };
// The bound test command host — and with it the process environment — names a third location
// where no vega exists, so an answer read from the process instead of the per-call host is
// wrong here.
process.env['PATH'] = path.join(scratch, 'process-bin');
process.env['HOME'] = processHome;

const hostA: HostEnvironment = {
  env: { PATH: hostAPathDir, HOME: processHome },
  cwd: scratch,
};
const hostB: HostEnvironment = {
  env: { PATH: path.join(scratch, 'empty-bin'), HOME: hostBHome },
  cwd: scratch,
};

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function withProcessCommandHost<T>(run: () => Promise<T>): Promise<T> {
  // The process command host names a third location; the per-call hosts below must win (#3794).
  return withCommandHost(
    { host: { env: process.env, cwd: process.cwd() }, requestEnv: undefined },
    run,
  );
}

beforeEach(() => {
  mockRunCmd.mockReset();
  mockWhichCmd.mockReset();
  mockWhichCmd.mockImplementation(async (cmd: string, env: NodeJS.ProcessEnv) =>
    Boolean(cmd === 'vega' && env?.PATH?.includes(hostAPathDir)),
  );
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

function runExecutables(): string[] {
  return mockRunCmd.mock.calls.map(([executable]) => executable);
}

test('Vega plugin owns the Vega platform', () => {
  assert.deepEqual(vegaPlugin.platforms, ['vega']);
});

test('Vega plugin creates the Vega interactor lazily', async () => {
  const interactor = await vegaPlugin.createInteractor(
    VEGA_VVD,
    {},
    {
      env: process.env,
      cwd: process.cwd(),
    },
  );

  assert.equal(typeof interactor.tvRemote, 'function');
  assert.equal(typeof interactor.back, 'function');
  assert.equal(typeof interactor.home, 'function');
});

test('createInteractor binds each caller host into the interactor it returns', async () => {
  // Removing the host-binding wrap in index.ts makes both calls fall through to the unbound
  // scope default and refuse with `vega-adapter-host-unbound` (#3794).
  await withProcessCommandHost(async () => {
    const interactorA = await vegaPlugin.createInteractor(VEGA_VVD, {}, hostA);
    const interactorB = await vegaPlugin.createInteractor(VEGA_VVD, {}, hostB);

    await interactorA.back();
    assert.deepEqual(runExecutables(), ['vega']);

    mockRunCmd.mockClear();
    await interactorB.back();
    assert.deepEqual(runExecutables(), [path.join(hostBHome, 'vega', 'bin', 'vega')]);
  });
});
