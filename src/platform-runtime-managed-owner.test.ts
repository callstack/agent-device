import {
  type DeviceBindingIntent,
  type ResourceOwnershipFence,
  type RuntimeOwnerRef,
  type RuntimeProviderMode,
  localRuntimeOwner,
  managedBindingFence,
  managedLocalRuntimeOwner,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import {
  appStateUse,
  appsRuntimeUse,
  bootTargetUse,
  shutdownTargetUse,
  type PlatformRuntimeHost,
} from '@agent-device/contracts/platform-runtime-operations';
import { deployAppUse } from '@agent-device/contracts/app-deployment-runtime-plan';
import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runCmd } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import { withAppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import { createRecordingAppleToolProvider } from '../test/integration/provider-scenarios/providers.ts';
import { createDemoIosApp } from '../test/integration/provider-scenarios/fixtures.ts';
import {
  AUTOMATION_APP_ID,
  AUTOMATION_PNG,
  managedAutomationBinding,
  managedAutomationApk,
  withManagedAdbFixture,
} from './platform-runtime-managed-owner.fixtures.ts';
import { createManagedLocalRuntimeOwner } from './platform-runtime-managed-owner.ts';
import {
  gatewayFixtureDevice as device,
  gatewayFixtureScope as ordinaryScope,
  managedGatewayScope,
  localFamilyRuntimeFixture,
  MANAGED_RETAINED_OPERATION,
} from './platform-runtime-gateway.fixtures.ts';

vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(async () => {}),
}));

const managed = managedLocalRuntimeOwner('sim-a');
const fence = managedBindingFence({
  requesterId: 'requester-a',
  requestGeneration: 1,
  identityIncarnationId: 'incarnation-a',
});

test('managed iOS delegates deployment and system operations without local readiness or runner startup', async () => {
  const app = createDemoIosApp('managed-ios-automation-');
  let biometricAttempts = 0;
  const native = createRecordingAppleToolProvider({
    plist: {
      readJson: async () => ({ CFBundleIdentifier: AUTOMATION_APP_ID, CFBundleName: 'Demo' }),
    },
    simctl: async (args) => {
      expect(args.slice(0, 2)).toEqual(['--set', '/managed/set']);
      const command = args[2];
      if (command === 'list')
        return {
          stdout: JSON.stringify({
            devices: { ios: [{ udid: 'managed-ios', state: 'Shutdown' }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      expect(['install', 'uninstall', 'pbpaste', 'pbcopy', 'ui', 'biometric', 'push']).toContain(
        command,
      );
      if (command === 'biometric' && ++biometricAttempts === 1)
        return { stdout: '', stderr: 'unknown command', exitCode: 1 };
      return {
        stdout: command === 'pbpaste' ? 'managed clipboard\n' : '',
        stderr: '',
        exitCode: 0,
      };
    },
  });
  try {
    await withAppleToolProvider(native.provider, async () => {
      const { binding, allocator, admission } = await managedAutomationBinding('ios');
      expect(allocator.calls.map(({ method }) => method)).toEqual(['requestLease']);
      const ops = binding.operations;
      await ops.ensureReady!({});
      await ops.deployApp!({
        app: AUTOMATION_APP_ID,
        appPath: app.appPath,
        replaceExisting: false,
      });
      await ops.deployApp!({ app: AUTOMATION_APP_ID, appPath: app.appPath, replaceExisting: true });
      const artifact = await ops.materializeAppSource!({
        source: { kind: 'path', path: app.appPath },
      });
      try {
        await ops.deployMaterializedApp!({ artifact });
      } finally {
        await artifact.cleanup();
      }
      await ops.sendPushNotification!({ appId: AUTOMATION_APP_ID, payload: {} });
      expect(await ops.readClipboard!({})).toBe('managed clipboard');
      await ops.writeClipboard!({ text: 'managed' });
      await ops.setSetting!({ setting: 'appearance', state: 'dark' });
      await ops.setSetting!({ setting: 'faceid', state: 'match' });
      expect(biometricAttempts).toBe(2);
      expect(native.calls.filter((call) => call[3] === 'install')).toHaveLength(3);
      expect(
        native.calls.some((call) => ['list', 'boot', 'bootstatus', 'shutdown'].includes(call[3]!)),
      ).toBe(false);
      expect(allocator.calls.map(({ method }) => method)).toEqual(['requestLease', 'renewLease']);
      const before = native.calls.length;
      admission.fenceBinding('replaced');
      await expect(ops.readClipboard!({})).rejects.toMatchObject({
        details: { reason: 'teardown-required' },
      });
      await binding[Symbol.asyncDispose]();
      expect(native.calls).toHaveLength(before);
    });
  } finally {
    fs.rmSync(app.tempRoot, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'managed Android contains bind probes, APK deployment, settings, clipboard and screenshot',
  async () => {
    await withManagedAdbFixture(async (native) => {
      const { binding, host, allocator, admission } = await managedAutomationBinding('android');
      expect(native.calls()).toHaveLength(1);
      expect(allocator.calls.map(({ method }) => method)).toEqual(['requestLease']);
      const ops = binding.operations;
      const apkPath = await managedAutomationApk(native.root);
      await ops.ensureReady!({});
      await ops.deployApp!({ app: AUTOMATION_APP_ID, appPath: apkPath, replaceExisting: false });
      await ops.deployApp!({ app: AUTOMATION_APP_ID, appPath: apkPath, replaceExisting: true });
      const artifact = await ops.materializeAppSource!({ source: { kind: 'path', path: apkPath } });
      try {
        await ops.deployMaterializedApp!({ artifact });
      } finally {
        await artifact.cleanup();
      }
      await ops.sendPushNotification!({ appId: AUTOMATION_APP_ID, payload: {} });
      expect(await ops.readClipboard!({})).toBe('managed clipboard');
      await ops.writeClipboard!({ text: 'managed' });
      await ops.setSetting!({ setting: 'fingerprint', state: 'match' });
      await ops.setSetting!({
        setting: 'clear-app-state',
        state: 'clear',
        appBundleId: AUTOMATION_APP_ID,
      });
      const outPath = path.join(native.root, 'capture.png');
      await ops.captureScreenshot!({ outPath, options: { stabilize: false } });
      expect(fs.readFileSync(outPath)).toEqual(AUTOMATION_PNG);
      const calls = native.calls();
      expect(calls.filter((args) => args[4] === 'install')).toHaveLength(3);
      expect(calls.some((args) => args.slice(4).join(' ') === 'emu finger touch 1')).toBe(true);
      for (const args of calls)
        expect(args.slice(0, 4)).toEqual(['-P', '15037', '-s', 'emulator-15037']);
      const bundle = path.join(native.root, 'App.aab');
      fs.writeFileSync(bundle, 'bundle');
      const archive = path.join(native.root, 'bundle.zip');
      await runCmd('zip', ['-q', archive, 'App.aab'], { cwd: native.root });
      const commands = vi.spyOn(host.commands, 'run');
      for (const replaceExisting of [false, true]) {
        await expect(
          ops.deployApp!({ app: AUTOMATION_APP_ID, appPath: bundle, replaceExisting }),
        ).rejects.toMatchObject({ details: { reason: 'managed-bundle-install-unavailable' } });
      }
      await expect(
        ops.deployApp!({ app: AUTOMATION_APP_ID, appPath: archive, replaceExisting: true }),
      ).rejects.toMatchObject({ details: { reason: 'managed-bundle-install-unavailable' } });
      await expect(
        ops.deployMaterializedApp!({
          artifact: { installablePath: bundle, cleanup: async () => {} },
        }),
      ).rejects.toMatchObject({ details: { reason: 'managed-bundle-install-unavailable' } });
      expect(commands).not.toHaveBeenCalled();
      expect(native.calls()).toEqual(calls);
      admission.fenceBinding('released');
      await expect(ops.readClipboard!({})).rejects.toMatchObject({
        details: { reason: 'teardown-required' },
      });
      await binding[Symbol.asyncDispose]();
      expect(native.calls()).toEqual(calls);
    });
  },
);
const scope = managedGatewayScope(device, managed, fence);

function exactly(
  owner: RuntimeOwnerRef = managed,
  withFence: ResourceOwnershipFence = fence,
): DeviceBindingIntent {
  return { kind: 'exact-owner', owner, fence: withFence };
}

function managedOwnerFixture(providerMode?: RuntimeProviderMode) {
  const family = localFamilyRuntimeFixture({ family: 'apple', device, providerMode });
  const owner = createManagedLocalRuntimeOwner({
    owner: managed,
    loadLocal: async () => await family.module.loadRuntime({} as PlatformRuntimeHost),
  });
  return { family, owner };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the runtime use to be refused');
}

test.skipIf(process.platform === 'win32')(
  'managed screenshot failure keeps demo-mode cleanup on its private transport',
  async () => {
    await withManagedAdbFixture(async (native) => {
      const { binding } = await managedAutomationBinding('android');
      vi.mocked(sleep).mockClear();
      fs.writeFileSync(path.join(native.root, 'corrupt-screenshot'), '');
      await expect(
        binding.operations.captureScreenshot!({ outPath: path.join(native.root, 'bad.png') }),
      ).rejects.toThrow('valid PNG header');
      expect(sleep).toHaveBeenCalledOnce();
      const calls = native.calls();
      expect(calls.at(-1)?.at(-1)).toBe(
        'am broadcast -a com.android.systemui.demo -e command exit',
      );
      for (const args of calls)
        expect(args.slice(0, 4)).toEqual(['-P', '15037', '-s', 'emulator-15037']);
      await binding[Symbol.asyncDispose]();
    });
  },
);

describe('managed local runtime owner', () => {
  test('exposes only reviewed operations even when the local family offers every cell', async () => {
    const { owner } = managedOwnerFixture();

    const binding = await owner.bind({ device, intent: exactly(), scope });

    const enabled = [
      'ensureReady',
      'deployApp',
      'materializeAppSource',
      'deployMaterializedApp',
      'sendPushNotification',
      'setSetting',
      'readClipboard',
      'writeClipboard',
    ];
    expect(Object.keys(binding.operations).sort()).toEqual(enabled.sort());
    for (const key of Object.keys(binding.facts.operations) as Array<
      keyof typeof binding.facts.operations
    >) {
      if (enabled.includes(key)) continue;
      expect(binding.facts.operations[key]).toMatchObject({
        available: false,
        reason: 'owner-capability-missing',
      });
      expect(binding.operations[key]).toBeUndefined();
    }
    expect(binding.facts.operations[MANAGED_RETAINED_OPERATION]).toEqual({ available: true });
    expect(binding.operations[MANAGED_RETAINED_OPERATION]).toBeTypeOf('function');
  });

  // The exclusion covers binding cells; request-runtime binding owns the separate pre-binding
  // readiness fence.
  test('refuses every runtime use that needs a withheld cell', async () => {
    const { owner } = managedOwnerFixture();
    const binding = await owner.bind({ device, intent: exactly(), scope });
    const refused = {
      code: 'UNSUPPORTED_OPERATION',
      details: { reason: 'owner-capability-missing' },
    };

    expect(thrownBy(() => narrowDeviceBinding(binding, appsRuntimeUse))).toMatchObject(refused);
    expect(thrownBy(() => narrowDeviceBinding(binding, appStateUse))).toMatchObject(refused);
    expect(thrownBy(() => narrowDeviceBinding(binding, bootTargetUse))).toMatchObject(refused);
    expect(thrownBy(() => narrowDeviceBinding(binding, shutdownTargetUse))).toMatchObject(refused);
    expect(narrowDeviceBinding(binding, deployAppUse).owner).toEqual(managed);
  });

  test('rewrites the owner, delegates under an ordinary intent, and forwards disposal', async () => {
    const { family, owner } = managedOwnerFixture();

    const binding = await owner.bind({ device, intent: exactly(), scope });

    expect(binding.owner).toEqual(managed);
    expect(binding.device).toEqual(device);
    expect(family.requests).toHaveLength(1);
    expect(family.requests[0]?.intent).toEqual({ kind: 'ordinary' });
    expect(family.requests[0]?.scope).toBe(scope);
    await binding[Symbol.asyncDispose]();
    expect(family.calls.disposals).toBe(1);
  });

  test('binds only under an exact-owner intent that names this owner', async () => {
    const { family, owner } = managedOwnerFixture();
    const refusal = {
      code: 'COMMAND_FAILED',
      details: { reason: 'runtime-contract-invalid' },
    };

    await expect(owner.bind({ device, intent: { kind: 'ordinary' }, scope })).rejects.toMatchObject(
      refusal,
    );
    await expect(
      owner.bind({ device, intent: exactly(localRuntimeOwner('apple')), scope }),
    ).rejects.toMatchObject(refusal);
    await expect(
      owner.bind({ device, intent: exactly(managedLocalRuntimeOwner('sim-b')), scope }),
    ).rejects.toMatchObject(refusal);
    expect(family.requests).toEqual([]);
  });

  test('compares the opaque fence exactly while its meaning stays with the claim gate', async () => {
    const { owner } = managedOwnerFixture();

    const binding = await owner.bind({
      device,
      intent: exactly(managed, { token: 'an-opaque-capture-token', generation: 7 }),
      scope: managedGatewayScope(device, managed, {
        token: 'an-opaque-capture-token',
        generation: 7,
      }),
    });

    expect(binding.owner).toEqual(managed);
  });

  test('never claims a device and projects the same withholding onto inspected facts', async () => {
    const { owner } = managedOwnerFixture();

    expect(owner.ownsDevice(device)).toBe(false);
    const facts = await owner.inspectFacts(device);
    expect(facts.operations.bootTarget).toMatchObject({
      available: false,
      reason: 'owner-capability-missing',
    });
    expect(facts.operations[MANAGED_RETAINED_OPERATION].available).toBe(false);
  });

  test('reports the family owner provider mode it was given, unlaundered', async () => {
    const { owner } = managedOwnerFixture('transport-composed');

    const binding = await owner.bind({ device, intent: exactly(), scope });

    expect(binding.facts.device.providerMode).toBe('transport-composed');
  });

  test('refuses absent or mismatched managed authority before loading local mechanics', async () => {
    const { family, owner } = managedOwnerFixture();
    for (const candidate of [
      ordinaryScope,
      managedGatewayScope({ ...device, simulatorSetPath: '/foreign' }, managed, fence),
      managedGatewayScope(device, managedLocalRuntimeOwner('foreign'), fence),
      managedGatewayScope(device, managed, { ...fence, generation: 2 }),
    ]) {
      await expect(
        owner.bind({ device, intent: exactly(), scope: candidate }),
      ).rejects.toBeDefined();
    }
    expect(family.calls.loads).toBe(0);
  });
});
