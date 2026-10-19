import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, test, vi } from 'vitest';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { mkdtempForTestSync } from './tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(), whichCmd: vi.fn() };
});

import { runCmd, whichCmd } from '@agent-device/host-kit/command';
import { createLocalVegaCliAdapter, createLocalVegaToolProvider } from '../tool-provider.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockWhichCmd = vi.mocked(whichCmd);

const scratch = mkdtempForTestSync('vega-host-isolation-');
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A real executable file so the default-install probe answers on the filesystem, not on mocks. */
function makeExecutable(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  chmodSync(filePath, 0o755);
}

const hostAPathDir = path.join(scratch, 'host-a', 'bin');
const hostBHome = path.join(scratch, 'host-b', 'home');
makeExecutable(path.join(hostAPathDir, 'vega'));
makeExecutable(path.join(hostBHome, 'vega', 'bin', 'vega'));

// Two independent hosts. Runtime A carries vega on its PATH; runtime B carries it only under
// its own HOME default install. Neither host sees the other's location, and the process PATH
// and HOME name a third location with no vega at all, so any answer read from the process
// instead of the runtime host is wrong here.
const hostA: HostEnvironment = {
  env: { PATH: hostAPathDir, HOME: path.join(scratch, 'host-a', 'home') },
  cwd: scratch,
};
const hostB: HostEnvironment = {
  env: { PATH: path.join(scratch, 'empty-bin'), HOME: hostBHome },
  cwd: scratch,
};

beforeEach(() => {
  mockRunCmd.mockReset();
  mockWhichCmd.mockReset();
  // PATH lookups answer from the environment passed in, like the real whichCmd: only host A's
  // PATH carries vega.
  mockWhichCmd.mockImplementation(async (cmd: string, env: NodeJS.ProcessEnv) =>
    Boolean(cmd === 'vega' && env?.PATH?.includes(hostAPathDir)),
  );
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

test('two hosts sharing the process resolve the vega executable from their own host', async () => {
  const providerA = createLocalVegaToolProvider(createLocalVegaCliAdapter(hostA));
  const providerB = createLocalVegaToolProvider(createLocalVegaCliAdapter(hostB));

  assert.equal(await providerA.isAvailable(), true);
  assert.equal(await providerB.isAvailable(), true);

  // Resolve B first through a run, then A: each must invoke the executable named by its own
  // host — A the PATH entry, B the HOME default-install path. Under a shared module cache the
  // second resolution would reuse the first host's answer.
  await providerB.version();
  await providerA.version();

  const executables = mockRunCmd.mock.calls.map(([executable]) => executable);
  assert.deepEqual(executables, [path.join(hostBHome, 'vega', 'bin', 'vega'), 'vega']);

  // The memo lives on each adapter instance: a later call never re-probes and never reads the
  // other host's answer.
  mockWhichCmd.mockReset();
  await providerA.version();
  await providerB.version();
  assert.equal(mockWhichCmd.mock.calls.length, 0);
  assert.deepEqual(
    mockRunCmd.mock.calls.slice(2).map(([executable]) => executable),
    ['vega', path.join(hostBHome, 'vega', 'bin', 'vega')],
  );
});

test('a host without the vega executable refuses, and the refusal is not memoized', async () => {
  // Host C names no home at all; host D names a HOME with no default install. Neither PATH
  // carries vega, so both report unavailable — and each later call re-probes, so a tool
  // installed after the miss is still found.
  const hostC: HostEnvironment = { env: { PATH: path.join(scratch, 'empty-bin') }, cwd: scratch };
  const hostD: HostEnvironment = {
    env: { PATH: path.join(scratch, 'empty-bin'), HOME: path.join(scratch, 'host-d', 'home') },
    cwd: scratch,
  };
  const providerC = createLocalVegaToolProvider(createLocalVegaCliAdapter(hostC));
  const providerD = createLocalVegaToolProvider(createLocalVegaCliAdapter(hostD));

  assert.equal(await providerC.isAvailable(), false);
  assert.equal(await providerD.isAvailable(), false);
  assert.equal(await providerD.isAvailable(), false);
  // One PATH probe per call: the second miss on D re-probed instead of trusting a memo.
  assert.equal(mockWhichCmd.mock.calls.length, 3);
});
