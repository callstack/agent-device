import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { VegaPlatformRegistration } from '@agent-device/contracts/platform-plugin';
import type { PlatformHost } from 'agent-device/plugins';
import { mkdtempForTestSync } from './__tests__/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(), whichCmd: vi.fn() };
});

import {
  runCmd,
  whichCmd,
  withCommandHost,
  isExecutablePath,
} from '@agent-device/host-kit/command';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import vegaPlatformPlugin from './index.ts';

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

beforeEach(() => {
  mockRunCmd.mockReset();
  mockWhichCmd.mockReset();
  mockWhichCmd.mockImplementation(async (cmd: string, env: NodeJS.ProcessEnv) =>
    Boolean(cmd === 'vega' && env?.PATH?.includes(hostAPathDir)),
  );
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

function createPluginHost(): PlatformHost {
  return {
    env: process.env,
    cwd: scratch,
    stateDir: path.join(scratch, 'state'),
    runCommand: runCmd,
    isFileExecutable: isExecutablePath,
    emitDiagnostic,
    withDiagnosticTimer,
  };
}

/** `setup` answers the platform family's registration; the cast names what the host stores. */
function setupVegaPlatform(): VegaPlatformRegistration {
  return vegaPlatformPlugin().contributes[0].setup(createPluginHost()) as VegaPlatformRegistration;
}

function runExecutables(): string[] {
  return mockRunCmd.mock.calls.map(([executable]) => executable);
}

function withProcessCommandHost<T>(run: () => Promise<T>): Promise<T> {
  // The process command host names a third location; the per-call hosts below must win (#3794).
  return withCommandHost(
    { host: { env: process.env, cwd: process.cwd() }, requestEnv: undefined },
    run,
  );
}

test('the Vega package contributes the Vega platform family', () => {
  const plugin = vegaPlatformPlugin();
  const [contribution] = plugin.contributes;

  assert.equal(plugin.apiVersion, 3);
  assert.equal(plugin.contributes.length, 1);
  assert.equal(contribution.kind, 'platform');
  assert.equal(contribution.family, 'vega');
});

test('setup registers the Vega modules, request scoping and operations', () => {
  const registration = setupVegaPlatform();

  assert.equal(registration.family, 'vega');
  assert.equal(registration.inventoryModule.family, 'vega');
  assert.equal(registration.runtimeModule.family, 'vega');
  assert.equal(typeof registration.inventoryModule.loadInventory, 'function');
  assert.equal(typeof registration.runtimeModule.loadRuntime, 'function');
  assert.equal(typeof registration.withRequestProvider, 'function');
  assert.equal(typeof registration.operations.toolchainCheck, 'function');
});

test('setup creates the Vega interactor lazily', async () => {
  const registration = setupVegaPlatform();

  const interactor = await registration.createInteractor(
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

test('setup binds each caller host into the interactor it returns', async () => {
  // Removing the host-binding wrap in the contribution's createInteractor makes both calls fall
  // through to the unbound scope default and refuse with `vega-adapter-host-unbound` (#3794).
  await withProcessCommandHost(async () => {
    const registration = setupVegaPlatform();

    const interactorA = await registration.createInteractor(VEGA_VVD, {}, hostA);
    const interactorB = await registration.createInteractor(VEGA_VVD, {}, hostB);

    await interactorA.back();
    assert.deepEqual(runExecutables(), ['vega']);

    mockRunCmd.mockClear();
    await interactorB.back();
    assert.deepEqual(runExecutables(), [path.join(hostBHome, 'vega', 'bin', 'vega')]);
  });
});
