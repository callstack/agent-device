import { EventEmitter } from 'node:events';
import { createLimrunRuntimeDependencies } from '../../../src/sdk/limrun-runtime-dependencies.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { bindLimrunDeployment } from './limrun-deployment-cancellation.fixtures.ts';

const state = vi.hoisted(() => ({
  simctl: vi.fn((_args: string[]) => ({
    wait: async () => ({ code: 0, stdout: '', stderr: '' }),
  })),
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = {
      create: vi.fn(async () => ({
        metadata: { id: 'limrun-ios-instance' },
        status: { token: 'instance-token', apiUrl: 'https://limrun.example.test' },
      })),
      list: vi.fn(async () => ({ getPaginatedItems: () => [] })),
      delete: vi.fn(async () => undefined),
    };
  },
}));

vi.mock('@limrun/api/ios-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: vi.fn(async () => undefined),
    simctl: (args: string[]) =>
      Object.assign(
        new EventEmitter(),
        args[0] === 'list'
          ? {
              wait: async () => ({
                code: 0,
                stderr: '',
                stdout: JSON.stringify({
                  devices: {
                    runtime: [
                      { udid: 'ios-device', name: 'iPhone', state: 'Booted', isAvailable: true },
                    ],
                  },
                }),
              }),
            }
          : state.simctl(args),
        { stop() {} },
      ),
    listApps: async () => [{ bundleId: 'com.example.ios', name: 'Example', installType: 'User' }],
    deviceInfo: { udid: 'ios-device', screenWidth: 402, screenHeight: 874, model: 'iPhone' },
  })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

test('a Limrun iOS permission the runtime refuses reports the local unsupported verdict', async () => {
  state.simctl.mockImplementation(() => ({
    wait: async () => ({
      code: 1,
      stdout: '',
      stderr:
        'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=1):\nSimulator device failed to complete the requested operation.\nOperation not permitted\nUnderlying error (domain=NSPOSIXErrorDomain, code=1):\n\tFailed to set access\n\tOperation not permitted',
    }),
  }));
  const { binding, dispose } = await bindLimrunDeployment(
    'ios',
    new AbortController().signal,
    createLimrunRuntimeDependencies({ env: {}, cwd: process.cwd() }).ios,
  );
  try {
    const refusal = binding.operations.setSetting!({
      setting: 'permission',
      state: 'grant',
      appBundleId: 'com.example.ios',
      options: { permissionTarget: 'notifications' },
    });

    await expect(refusal).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message:
        'iOS simulator does not support setting notifications permission via simctl privacy on this runtime.',
      details: { appBundleId: 'com.example.ios' },
    });
    expect(state.simctl.mock.calls).toEqual([
      [['privacy', 'booted', 'grant', 'notifications', 'com.example.ios']],
    ]);
  } finally {
    await dispose();
  }
});

test('a Limrun iOS simctl failure that is not a refusal stays a command failure', async () => {
  state.simctl.mockImplementation(() => ({
    wait: async () => ({ code: 2, stdout: '', stderr: 'Invalid device: booted' }),
  }));
  const { binding, dispose } = await bindLimrunDeployment(
    'ios',
    new AbortController().signal,
    createLimrunRuntimeDependencies({ env: {}, cwd: process.cwd() }).ios,
  );
  try {
    await expect(
      binding.operations.setSetting!({
        setting: 'permission',
        state: 'grant',
        appBundleId: 'com.example.ios',
        options: { permissionTarget: 'camera' },
      }),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { exitCode: 2, stderr: 'Invalid device: booted' },
    });
  } finally {
    await dispose();
  }
});
