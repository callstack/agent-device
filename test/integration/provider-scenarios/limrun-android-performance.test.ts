import { expect, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createLimrunRuntime } from '@agent-device/limrun/runtime';
import { limrunRuntimeDependencies } from '../../../src/provider-plugin-host-capabilities.fixtures.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness } from './harness.ts';
import { respondToAndroidSettingsAdbCommand } from './android-world.ts';

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly androidInstances = {
      create: async () => ({
        metadata: { id: 'limrun-perf-instance' },
        status: {
          apiUrl: 'https://limrun.example.test',
          token: 'test-instance-token',
          adbWebSocketUrl: 'wss://limrun.example.test/adb',
        },
      }),
      delete: async () => undefined,
    };
  },
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: async () => ({
    disconnect: async () => undefined,
    startAdbTunnel: async () => ({
      address: { address: '127.0.0.1', port: 62001 },
      close: async () => undefined,
    }),
  }),
}));

vi.mock('@agent-device/host-kit/command', async (original) => ({
  ...(await original<typeof import('@agent-device/host-kit/command')>()),
  runCmd: async () => {
    throw new Error('Unscoped host commands must not run');
  },
}));

test('Limrun Android memory sampling reaches the allocated session ADB through daemon dispatch', async () => {
  const dependencies = await limrunRuntimeDependencies({ env: {}, cwd: process.cwd() });
  // Plain close stops the session app; the fake device then reports it gone.
  let settingsStopped = false;
  const sessionExec = vi.fn<typeof dependencies.host.runAdb>(async (invocation) => {
    const args = [...invocation.command];
    const ok = { exitCode: 0, stdout: '', stderr: '' };
    if (args.join(' ') === 'shell am force-stop com.android.settings') {
      settingsStopped = true;
      return ok;
    }
    if (args[0] === 'disconnect') return ok;
    expect(invocation.target.selector).toEqual({ kind: 'serial', serial: '127.0.0.1:62001' });
    if (args.join(' ') === 'shell dumpsys meminfo com.android.settings') {
      return { ...ok, stdout: 'TOTAL PSS: 52000 TOTAL RSS: 100112 TOTAL SWAP PSS: 0' };
    }
    if (args.join(' ') === 'reverse --list') return ok;
    if (
      args.join(' ') ===
      'shell am start -W -a android.intent.action.MAIN -c android.intent.category.DEFAULT -c android.intent.category.LAUNCHER -p com.android.settings'
    ) {
      return { ...ok, stdout: 'Status: ok\nActivity: com.android.settings/.Settings\n' };
    }
    return respondToAndroidSettingsAdbCommand(args, '', '', {
      ...(settingsStopped ? { dumpsysWindow: () => 'mCurrentFocus=null\n' } : {}),
      pidof: () => (settingsStopped ? { exitCode: 1, stdout: '', stderr: '' } : undefined),
    });
  });
  const registration = createLimrunRuntime(
    { apiKey: 'test-api-key' },
    { ...dependencies, host: { ...dependencies.host, runAdb: sessionExec } },
    { includePlatformModule: true },
  );
  const runtime = registration.runtime;
  const providers = createProviderDeviceRuntimeRequestProviders([runtime]);
  const daemon = await createProviderScenarioHarness({
    ...providers,
    deviceInventorySource: providers.deviceInventorySource!,
    platformRuntime: {
      providerRuntimes: [runtime],
      providerModules: [{ runtime, module: registration.platformModule }],
    },
  });
  try {
    const flags = {
      platform: 'android' as const,
      tenant: 'team-a',
      runId: 'run-a',
      leaseProvider: 'limrun',
    };
    const meta = {
      tenantId: 'team-a',
      runId: 'run-a',
      leaseBackend: 'android-instance' as const,
      leaseProvider: 'limrun',
      deviceKey: 'android-a',
      clientId: 'client-a',
    };
    const { lease } = assertRpcOk<{ lease: DeviceLease }>(
      await daemon.callCommand('lease_allocate', [], flags, { meta }),
    );
    const scope = { ...flags, leaseId: lease.leaseId };
    const options = { meta: { ...meta, leaseId: lease.leaseId } };
    assertRpcOk(await daemon.callCommand('open', ['com.android.settings'], scope, options));
    sessionExec.mockClear();
    const sampled = assertRpcOk(
      await daemon.callCommand('perf', ['memory', 'sample'], scope, options),
    );
    expect(sampled).toMatchObject({
      metrics: { memory: { available: true, totalPssKb: 52000, totalRssKb: 100112 } },
    });
    expect(sessionExec.mock.calls.map(([invocation]) => invocation.command)).toContainEqual([
      'shell',
      'dumpsys',
      'meminfo',
      'com.android.settings',
    ]);
    sessionExec.mockClear();
    assertRpcOk(await daemon.callCommand('close', [], scope, options));
    expect(sessionExec.mock.calls.map(([invocation]) => invocation.command)).toContainEqual([
      'shell',
      'am',
      'force-stop',
      'com.android.settings',
    ]);
  } finally {
    await daemon.close();
    await runtime.shutdown();
  }
});
