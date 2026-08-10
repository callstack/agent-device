import { describe, expect, test } from 'vitest';
import { createAppleAppLogEnvelope } from './descriptor.ts';
import { createAppleAppLogRuntime } from './runtime.ts';
import { appleDevice, hostFixture, scope } from './runtime.fixtures.ts';

describe('Apple app-log runtime', () => {
  test.each([
    {
      name: 'iOS simulator',
      device: appleDevice(),
      available: true,
      hint: undefined,
    },
    {
      name: 'iOS physical CoreDevice',
      device: appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
      available: true,
      hint: undefined,
    },
    {
      name: 'iOS physical XCTest',
      device: appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'xctest' }),
      available: false,
      hint: 'CoreDevice-backed physical iOS device',
    },
    {
      name: 'iPadOS simulator',
      device: appleDevice({ appleOs: 'ipados' }),
      available: true,
      hint: undefined,
    },
    {
      name: 'tvOS simulator',
      device: appleDevice({ appleOs: 'tvos', target: 'tv' }),
      available: true,
      hint: undefined,
    },
    {
      name: 'macOS host',
      device: appleDevice({ appleOs: 'macos', kind: 'device', target: 'desktop' }),
      available: true,
      hint: undefined,
    },
    {
      name: 'visionOS simulator',
      device: appleDevice({ appleOs: 'visionos' }),
      available: true,
      hint: undefined,
    },
    {
      name: 'watchOS sentinel',
      device: appleDevice({ appleOs: 'watchos' }),
      available: false,
      hint: 'watchOS app logs are not supported',
    },
  ])('classifies the $name leaf explicitly', async ({ device, available, hint }) => {
    const binding = await createAppleAppLogRuntime(hostFixture().host).bind({
      device,
      intent: { kind: 'ordinary' },
      scope,
    });
    expect(binding.facts.device.providerMode).toBe('local');
    for (const operation of ['appLogInspect', 'appLogDoctor', 'appLogStart'] as const) {
      const fact = binding.facts.operations[operation];
      expect(fact.available).toBe(available);
      if (!available && hint) expect(fact).toHaveProperty('hint', expect.stringContaining(hint));
    }
  });

  test('rejects the XCTest physical backend with the established CoreDevice hint', async () => {
    const binding = await createAppleAppLogRuntime(hostFixture().host).bind({
      device: appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'xctest' }),
      intent: { kind: 'ordinary' },
      scope,
    });
    expect(binding.facts.operations.appLogStart).toMatchObject({
      available: false,
      reason: 'unsupported-device-backend',
    });
    expect(binding.facts.operations.appLogInspect).toEqual(binding.facts.operations.appLogStart);
    expect(binding.facts.operations.appLogStart).toHaveProperty(
      'hint',
      expect.stringContaining('CoreDevice-backed physical iOS device'),
    );
  });

  test('fails closed for the reserved watchOS leaf', async () => {
    const binding = await createAppleAppLogRuntime(hostFixture().host).bind({
      device: appleDevice({ appleOs: 'watchos' }),
      intent: { kind: 'ordinary' },
      scope,
    });
    expect(binding.facts.operations.appLogInspect).toMatchObject({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    await expect(
      binding.operations.appLogStart?.({
        sessionId: 'session',
        appBundleId: 'com.example.app',
        outputPath: '/tmp/app.log',
        fence: { token: 'fence', generation: 1 },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  });

  test('rolls back the output sink if simulator process startup fails', async () => {
    const fixture = hostFixture({ failProcessStart: true });
    const binding = await createAppleAppLogRuntime(fixture.host).bind({
      device: appleDevice(),
      intent: { kind: 'ordinary' },
      scope,
    });
    await expect(
      binding.operations.appLogStart?.({
        sessionId: 'session',
        appBundleId: 'com.example.app',
        outputPath: '/tmp/app.log',
        fence: { token: 'fence', generation: 1 },
      }),
    ).rejects.toThrow('start failed');
    expect(fixture.outputDisposed()).toBe(true);
    expect(fixture.backgroundCommands[0]).toEqual([
      'xcrun',
      'simctl',
      'spawn',
      'apple-1',
      'log',
      'stream',
      '--style',
      'compact',
      '--level',
      'info',
      '--predicate',
      expect.stringContaining('com.example.app'),
    ]);
  });

  test('rejects cross-session start and recovery paths before host authority is used', async () => {
    const fixture = hostFixture();
    const runtimeOwner = createAppleAppLogRuntime(fixture.host);
    const binding = await runtimeOwner.bind({
      device: appleDevice(),
      intent: { kind: 'ordinary' },
      scope,
    });
    const envelope = createAppleAppLogEnvelope({
      sessionId: 'session',
      device: appleDevice(),
      owner: runtimeOwner.owner,
      fence: { token: 'fence', generation: 1 },
      descriptor: {
        transport: 'apple-log-stream',
        backend: 'ios-simulator',
        outputPath: '/tmp/app.log',
        pidPath: '/tmp/other/app-log.pid',
      },
    });

    await expect(binding.operations.appLogReattach?.({ envelope })).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'descriptor-invalid',
    });
    await expect(binding.operations.appLogCleanup?.({ envelope })).resolves.toMatchObject({
      status: 'cleanup-pending',
      reason: 'ownership-fence-lost',
    });
    await expect(
      binding.operations.appLogStart?.({
        sessionId: 'session',
        appBundleId: 'com.example.app',
        outputPath: '/tmp/other/app.log',
        fence: { token: 'fence', generation: 1 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(fixture.markerReads()).toBe(0);
    expect(fixture.outputOpens()).toBe(0);
  });

  test.each([
    { name: 'simulator doctor', device: appleDevice(), operation: 'doctor' as const },
    {
      name: 'CoreDevice start probe',
      device: appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
      operation: 'start' as const,
    },
  ])('preserves the exact cancellation reason for $name', async ({ device, operation }) => {
    const controller = new AbortController();
    const reason = new Error('request cancelled');
    const fixture = hostFixture({
      appleToolRun: async () => {
        controller.abort(reason);
        throw reason;
      },
    });
    const binding = await createAppleAppLogRuntime(fixture.host).bind({
      device,
      intent: { kind: 'ordinary' },
      scope: { ...scope, signal: controller.signal },
    });
    const request =
      operation === 'doctor'
        ? binding.operations.appLogDoctor?.({ appBundleId: 'com.example.app' })
        : binding.operations.appLogStart?.({
            sessionId: 'session',
            appBundleId: 'com.example.app',
            outputPath: '/tmp/app.log',
            fence: { token: 'fence', generation: 1 },
          });
    await expect(request).rejects.toBe(reason);
  });
});
