import { beforeEach, expect, test, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  createLiveTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import { createHostDiagnostics } from './platform-runtime-host-diagnostics.ts';
import { composePlatformPlugins } from './platform-runtime/platform-plugins.ts';
import { vegaSelectionFixture } from './platform-runtime-vega-provider.fixtures.ts';
import { linuxPlatformCompositionFixture } from './platform-runtime-linux-provider.fixtures.ts';

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
  const vegaCli = path.join(hostHome, 'vega', 'bin', 'vega');
  writeFileSync(
    vegaCli,
    '#!/bin/sh\ncase "$*" in\n  *--version*) echo "Vega CLI 9.9.9" ;;\n  *) echo "VirtualDevice : running" ;;\nesac\n',
  );
  chmodSync(vegaCli, 0o755);

  const host: HostEnvironment = {
    env: { PATH: path.join(scratch, 'empty-path'), HOME: hostHome },
    cwd: scratch,
  };
  // Vega is a platform plugin, so the scenario supplies it: the assertion covers which host the
  // plugin's doctor binds, not the builtin family set.
  const check = await createHostDiagnostics(
    host,
    undefined,
    vegaSelectionFixture(host),
  ).toolchainCheck('vega', context);

  expect(check?.status).toBe('pass');
  expect(check?.summary).toContain('Vega CLI 9.9.9');
});

test('doctor targeted at Vega reports the absent plugin with its install command', async () => {
  // `--platform vega` is the explicit signal: an unfiltered doctor passes no selector and stays
  // silent about an absent optional family. The row comes from the composition's own absence
  // report, so the hint names the same package and command every other Vega lookup answers with.
  const { vega } = composePlatformPlugins([], []);
  const check = await createHostDiagnostics(
    createLiveTestHostEnvironment(),
    undefined,
    vega,
  ).toolchainCheck('vega', context);

  expect(check?.id).toBe('toolchain');
  expect(check?.status).toBe('fail');
  expect(check?.summary).toContain('@agent-device/vega');
  expect(check?.hint).toContain('agent-device plugins add @agent-device/vega');
  expect(check?.command).toMatch(/^agent-device plugins add @agent-device\/vega/);
  expect(check?.evidence).toMatchObject({
    code: 'UNSUPPORTED_PLATFORM',
    reason: 'plugin-not-installed',
    family: 'vega',
    package: '@agent-device/vega',
  });
});

test('doctor targeted at Vega reports a failed plugin load as that plugin reports it', async () => {
  // A store plugin whose load threw owns its answer: the row carries the plugin's own code and
  // message rather than the installation hint a host without the plugin needs.
  const { vega } = composePlatformPlugins([], [
    {
      platform: 'vega',
      source: 'store',
      package: '@agent-device/vega',
      version: '0.22.0-dev',
      state: 'failed',
      credentials: { variables: [], byBackend: {} },
      error: {
        code: 'COMMAND_FAILED',
        message: 'Plugin exited during setup',
        reason: 'setup-threw',
      },
    },
  ] satisfies readonly PluginInventoryEntry[]);
  const check = await createHostDiagnostics(
    createLiveTestHostEnvironment(),
    undefined,
    vega,
  ).toolchainCheck('vega', context);

  expect(check?.status).toBe('fail');
  expect(check?.summary).toContain('Plugin exited during setup');
  expect(check?.evidence).toMatchObject({
    code: 'COMMAND_FAILED',
    reason: 'setup-threw',
    family: 'vega',
    package: '@agent-device/vega',
  });
});

test('doctor without a Vega selector reports no Vega row when the plugin is absent', async () => {
  // An unfiltered doctor runs the toolchain check for the resolved device or selector platform only,
  // so an absent optional family stays out of the report instead of failing every host without it.
  const { vega } = composePlatformPlugins([], []);
  expect(
    await createHostDiagnostics(createLiveTestHostEnvironment(), undefined, vega).toolchainCheck(
      undefined,
      context,
    ),
  ).toBeUndefined();
});

test('doctor targeted at HarmonyOS reports the absent plugin with its install command', async () => {
  // Same contract as Vega: the row is the composition's own absence report, so it names the same
  // package and command a HarmonyOS discovery request answers with.
  const { harmony } = composePlatformPlugins([], []);
  const check = await createHostDiagnostics(
    createLiveTestHostEnvironment(),
    undefined,
    undefined,
    harmony,
  ).toolchainCheck('harmonyos', context);

  expect(check?.id).toBe('toolchain');
  expect(check?.status).toBe('fail');
  expect(check?.summary).toContain('@agent-device/harmonyos');
  expect(check?.hint).toContain('agent-device plugins add @agent-device/harmonyos');
  expect(check?.command).toMatch(/^agent-device plugins add @agent-device\/harmonyos/);
  expect(check?.evidence).toMatchObject({
    code: 'UNSUPPORTED_PLATFORM',
    reason: 'plugin-not-installed',
    family: 'harmonyos',
    package: '@agent-device/harmonyos',
  });
});

test('doctor targeted at a HarmonyOS plugin that failed to load reports what the plugin said', async () => {
  const { harmony } = composePlatformPlugins([], [
    {
      platform: 'harmonyos',
      source: 'store',
      package: '@agent-device/harmonyos',
      version: '0.22.0-dev',
      state: 'failed',
      credentials: { variables: [], byBackend: {} },
      error: {
        code: 'COMMAND_FAILED',
        message: 'Plugin exited during setup',
        reason: 'setup-threw',
      },
    },
  ] satisfies readonly PluginInventoryEntry[]);
  const check = await createHostDiagnostics(
    createLiveTestHostEnvironment(),
    undefined,
    undefined,
    harmony,
  ).toolchainCheck('harmonyos', context);

  expect(check?.status).toBe('fail');
  expect(check?.summary).toContain('Plugin exited during setup');
  expect(check?.evidence).toMatchObject({
    code: 'COMMAND_FAILED',
    reason: 'setup-threw',
    family: 'harmonyos',
    package: '@agent-device/harmonyos',
  });
});

test('doctor targeted at Linux reports the absent plugin with its install command', async () => {
  // Same contract as HarmonyOS: the row is the composition's own absence report, so it names the same
  // package and command a Linux discovery request answers with.
  const { linux } = composePlatformPlugins([], []);
  const check = await createHostDiagnostics(
    createLiveTestHostEnvironment(),
    undefined,
    undefined,
    undefined,
    linux,
  ).toolchainCheck('linux', context);

  expect(check?.id).toBe('toolchain');
  expect(check?.status).toBe('fail');
  expect(check?.summary).toContain('@agent-device/linux');
  expect(check?.hint).toContain('agent-device plugins add @agent-device/linux');
  expect(check?.command).toMatch(/^agent-device plugins add @agent-device\/linux/);
  expect(check?.evidence).toMatchObject({
    code: 'UNSUPPORTED_PLATFORM',
    reason: 'plugin-not-installed',
    family: 'linux',
    package: '@agent-device/linux',
  });
});

test('doctor targeted at a Linux plugin that failed to load reports what the plugin said', async () => {
  const { linux } = composePlatformPlugins([], [
    {
      platform: 'linux',
      source: 'store',
      package: '@agent-device/linux',
      version: '0.22.0-dev',
      state: 'failed',
      credentials: { variables: [], byBackend: {} },
      error: {
        code: 'COMMAND_FAILED',
        message: 'Plugin exited during setup',
        reason: 'setup-threw',
      },
    },
  ] satisfies readonly PluginInventoryEntry[]);
  const check = await createHostDiagnostics(
    createLiveTestHostEnvironment(),
    undefined,
    undefined,
    undefined,
    linux,
  ).toolchainCheck('linux', context);

  expect(check?.status).toBe('fail');
  expect(check?.summary).toContain('Plugin exited during setup');
  expect(check?.evidence).toMatchObject({
    code: 'COMMAND_FAILED',
    reason: 'setup-threw',
    family: 'linux',
    package: '@agent-device/linux',
  });
});

test('doctor targeted at an installed Linux plugin prints the row the plugin computed', async () => {
  // The toolchain probe is the plugin's: the core hands it nothing but the selection, so the tools
  // it names are the ones the plugin resolved from the host it was set up with.
  const { linux } = linuxPlatformCompositionFixture();
  const check = await createHostDiagnostics(
    createLiveTestHostEnvironment(),
    undefined,
    undefined,
    undefined,
    linux,
  ).toolchainCheck('linux', context);

  expect(check?.id).toBe('toolchain');
  expect(['pass', 'warn', 'fail']).toContain(check?.status);
  expect(check?.summary).toContain('Linux desktop tools');
});

test('doctor without a Linux selector reports no Linux row when the plugin is absent', async () => {
  const { linux } = composePlatformPlugins([], []);
  expect(
    await createHostDiagnostics(
      createLiveTestHostEnvironment(),
      undefined,
      undefined,
      undefined,
      linux,
    ).toolchainCheck(undefined, context),
  ).toBeUndefined();
});

test('doctor without a HarmonyOS selector reports no HarmonyOS row when the plugin is absent', async () => {
  const { harmony } = composePlatformPlugins([], []);
  expect(
    await createHostDiagnostics(
      createLiveTestHostEnvironment(),
      undefined,
      undefined,
      harmony,
    ).toolchainCheck(undefined, context),
  ).toBeUndefined();
});
