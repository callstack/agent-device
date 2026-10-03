import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DoctorCheck } from '@agent-device/contracts/observability';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});

import { runCmd } from '@agent-device/host-kit/command';
import { harmonyToolchainCheck } from '../doctor.ts';

const mockRunCmd = vi.mocked(runCmd);

beforeEach(() => {
  mockRunCmd.mockReset();
});

test('HarmonyOS doctor reports the HDC version', async () => {
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: 'HDC 3.2.0d\n', stderr: '' } as never);
  const check: DoctorCheck = await harmonyToolchainCheck();

  assert.deepEqual(check, {
    id: 'toolchain',
    status: 'pass',
    summary: 'HarmonyOS toolchain: HDC 3.2.0d.',
    evidence: { hdcVersion: 'HDC 3.2.0d' },
  });
  assert.deepEqual(mockRunCmd.mock.calls[0]?.slice(0, 2), ['hdc', ['-v']]);
});
