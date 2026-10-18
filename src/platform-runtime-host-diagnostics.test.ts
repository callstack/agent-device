import { beforeEach, expect, test, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  createLiveTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createHostDiagnostics } from './platform-runtime-host-diagnostics.ts';

const { mockAppleRunnerWarmupCheck } = vi.hoisted(() => ({
  mockAppleRunnerWarmupCheck: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/doctor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/doctor')>()),
  appleRunnerWarmupCheck: mockAppleRunnerWarmupCheck,
}));

const context: HostDiagnosticsContext = Object.freeze({
  stateDir: '/tmp/state',
  metroPort: 8081,
  shouldProbeMetro: false,
  isProviderDevice: () => false,
  emitProgress: vi.fn(),
  listLocalDeviceInventory: async () => [],
  shouldPropagateInventoryProbeError: () => false,
  transportOverrides: Object.freeze({}),
});

beforeEach(() => {
  mockAppleRunnerWarmupCheck.mockReset();
});

test('warmup hands an Apple device to the Apple runner warmup and returns its check', async () => {
  const check = {
    id: 'ios-runner-cache',
    status: 'pass',
    summary: 'iOS runner build started in the background',
  };
  mockAppleRunnerWarmupCheck.mockResolvedValue(check);

  const result = await createHostDiagnostics(createLiveTestHostEnvironment()).warmupCheck(
    IOS_SIMULATOR,
    context,
  );

  expect(result).toEqual(check);
  expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledWith(IOS_SIMULATOR, context);
});

test('warmup runs no probe for a non-Apple device', async () => {
  expect(
    await createHostDiagnostics(createLiveTestHostEnvironment()).warmupCheck(
      ANDROID_EMULATOR,
      context,
    ),
  ).toBeUndefined();
  expect(mockAppleRunnerWarmupCheck).not.toHaveBeenCalled();
});

test('vega toolchain check finds the CLI through the host it was composed with', async () => {
  // Doctor must answer for the host createHostDiagnostics holds, with no request-scoped
  // provider: this host's HOME differs from the process HOME and names a default-install vega
  // the process home does not have (#3794). Reverting vegaToolchainCheck to a bare
  // resolveVegaToolProvider() hits the `vega-adapter-host-unbound` refusal and goes red.
  const scratch = mkdtempForTestSync('vega-doctor-host-home-');
  const hostHome = path.join(scratch, 'host-home');
  mkdirSync(path.join(hostHome, 'vega', 'bin'), { recursive: true });
  const vega = path.join(hostHome, 'vega', 'bin', 'vega');
  writeFileSync(
    vega,
    '#!/bin/sh\ncase "$*" in\n  *--version*) echo "Vega CLI 9.9.9" ;;\n  *) echo "VirtualDevice : running" ;;\nesac\n',
  );
  chmodSync(vega, 0o755);

  const check = await createHostDiagnostics({
    env: { PATH: path.join(scratch, 'empty-path'), HOME: hostHome },
    cwd: scratch,
  }).toolchainCheck('vega', context);

  expect(check?.status).toBe('pass');
  expect(check?.summary).toContain('Vega CLI 9.9.9');
});
