import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import path from 'node:path';
import { createHarmonyHostStub, createHarmonyToolchainRoot } from '../toolbox.fixtures.ts';
import { harmonyToolchainCheck } from '../doctor.ts';

test('HarmonyOS doctor reports the HDC version', async () => {
  const stub = createHarmonyHostStub();
  stub.answer({ stdout: 'HDC 3.2.0d\n' });

  const check: DoctorCheck = await harmonyToolchainCheck(stub.toolbox.commands);

  assert.deepEqual(check, {
    id: 'toolchain',
    status: 'pass',
    summary: 'HarmonyOS toolchain: HDC 3.2.0d.',
    evidence: { hdcVersion: 'HDC 3.2.0d' },
  });
  assert.deepEqual(stub.commands[0], {
    executable: 'hdc',
    args: ['-v'],
    env: { PATH: '/usr/bin' },
    timeoutMs: 3_000,
    allowFailure: true,
    signal: undefined,
  });
});

test('HarmonyOS doctor probes the HDC a configured root carries', async () => {
  const root = createHarmonyToolchainRoot();
  const stub = createHarmonyHostStub({ env: { HDC_SDK_PATH: root, PATH: '/usr/bin' } });
  stub.answer({ stdout: 'HDC 3.2.0d\n' });

  const check = await harmonyToolchainCheck(stub.toolbox.commands);

  // A root outside the host PATH still answers its own version, because the probe names it.
  assert.equal(stub.commands[0]?.executable, path.join(root, 'hdc'));
  assert.equal(check.status, 'pass');
});

test('HarmonyOS doctor reports an unusable toolchain as info with the install hint', async () => {
  const stub = createHarmonyHostStub();

  const check = await harmonyToolchainCheck(stub.toolbox.commands);

  assert.equal(check.status, 'info');
  assert.equal(
    check.hint,
    'Install HarmonyOS Command Line Tools, then add sdk/default/openharmony/toolchains to PATH or set HDC_SDK_PATH.',
  );
});
