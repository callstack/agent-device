import { expect, test, vi } from 'vitest';
import {
  createLimrunAppDeploymentOperations,
  limrunAppDeploymentFacts,
} from './deployment-runtime.ts';
import { limrunIosDevice, unusedLimrunRuntimeHost } from './runtime.fixtures.ts';

const androidDevice = {
  platform: 'android' as const,
  id: 'limrun:android:lease-a',
  name: 'Limrun Android',
  kind: 'emulator' as const,
  target: 'mobile' as const,
  booted: true,
};

test.each([
  ['iOS simulator', limrunIosDevice],
  ['Android emulator', androidDevice],
] as const)('classifies a direct Limrun deployment fact for %s', (_name, device) => {
  const facts = limrunAppDeploymentFacts(
    { host: unusedLimrunRuntimeHost(), ownsDevice: () => true },
    device,
  );
  for (const operation of [
    facts.deployApp,
    facts.materializeAppSource,
    facts.deployMaterializedApp,
    facts.sendPushNotification,
  ]) {
    expect(operation).toMatchObject({ available: false });
  }
  expect(facts.deployApp).toMatchObject({ reason: 'owner-capability-missing' });
  expect(facts.sendPushNotification).toMatchObject({
    reason: device.platform === 'apple' ? 'owner-capability-missing' : 'unsupported-provider-mode',
  });
});

test.each([
  ['iOS simulator', limrunIosDevice],
  ['Android emulator', androidDevice],
] as const)(
  'uses an admitted direct Limrun deployment runtime for %s without a local fallback',
  async (_name, device) => {
    const deployApp = vi.fn(async () =>
      device.platform === 'apple'
        ? { bundleId: 'com.example.app', launchTarget: 'com.example.app' }
        : { packageName: 'com.example.app', launchTarget: 'com.example.app' },
    );
    const deployMaterializedApp = vi.fn(async () =>
      device.platform === 'apple'
        ? { bundleId: 'com.example.app', launchTarget: 'com.example.app' }
        : { packageName: 'com.example.app', launchTarget: 'com.example.app' },
    );
    const materializeApple = vi.fn(async () => ({
      installablePath: '/tmp/App.app',
      cleanup: async () => {},
    }));
    const materializeAndroid = vi.fn(async () => ({
      installablePath: '/tmp/app.apk',
      cleanup: async () => {},
    }));
    const base = unusedLimrunRuntimeHost();
    const hostMaterializeApple = vi.fn(base.appleDeployment.prepareArtifact);
    const hostMaterializeAndroid = vi.fn(base.androidDeployment.prepareArtifact);
    const push = vi.fn(async () => ({}));
    const options = {
      host: {
        ...base,
        appleDeployment: { ...base.appleDeployment, prepareArtifact: hostMaterializeApple },
        androidDeployment: { ...base.androidDeployment, prepareArtifact: hostMaterializeAndroid },
      },
      ownsDevice: () => true,
      bindDeployment: async () => ({
        deployApp,
        deployMaterializedApp,
        materializeAppSource: device.platform === 'apple' ? materializeApple : materializeAndroid,
        uninstallApp: async () => ({ wasInstalled: false as const }),
        ...(device.platform === 'apple' ? { sendPushNotification: push } : {}),
      }),
    };
    const facts = limrunAppDeploymentFacts(options, device);
    const operations = createLimrunAppDeploymentOperations(
      options,
      device,
      new AbortController().signal,
    );

    for (const fact of [facts.deployApp, facts.materializeAppSource, facts.deployMaterializedApp]) {
      expect(fact).toEqual({ available: true });
    }
    expect(facts.sendPushNotification).toMatchObject({ available: device.platform === 'apple' });
    if (device.platform === 'apple') {
      await operations.sendPushNotification!({ appId: 'com.example.app', payload: {} });
      expect(push).toHaveBeenCalledOnce();
    }
    await operations.deployApp?.({
      app: 'com.example.app',
      appPath: '/tmp/app',
      replaceExisting: false,
    });
    const artifact = await operations.materializeAppSource?.({
      source: { kind: 'path', path: '/tmp/app' },
    });
    await operations.deployMaterializedApp?.({ artifact: artifact! });
    expect(deployApp).toHaveBeenCalledOnce();
    expect(deployMaterializedApp).toHaveBeenCalledOnce();
    expect(materializeApple).toHaveBeenCalledTimes(device.platform === 'apple' ? 1 : 0);
    expect(materializeAndroid).toHaveBeenCalledTimes(device.platform === 'android' ? 1 : 0);
    expect(hostMaterializeApple).not.toHaveBeenCalled();
    expect(hostMaterializeAndroid).not.toHaveBeenCalled();
  },
);

test.each([
  [
    'deployApp',
    (operations: ReturnType<typeof createLimrunAppDeploymentOperations>) =>
      operations.deployApp?.({
        app: 'com.example.app',
        appPath: '/tmp/app',
        replaceExisting: false,
      }),
  ],
  [
    'deployMaterializedApp',
    (operations: ReturnType<typeof createLimrunAppDeploymentOperations>) =>
      operations.deployMaterializedApp?.({
        artifact: { installablePath: '/tmp/app.apk', cleanup: async () => {} },
      }),
  ],
] as const)(
  'aborts an in-flight Limrun %s callback with the binding signal',
  async (_name, invoke) => {
    const controller = new AbortController();
    const abortReason = new Error('request cancelled during Limrun deployment');
    const deployApp = vi.fn(async (_device, _input, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return await rejectWhenAborted(signal);
    });
    const deployMaterializedApp = vi.fn(async (_device, _input, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return await rejectWhenAborted(signal);
    });
    const operations = createLimrunAppDeploymentOperations(
      {
        host: unusedLimrunRuntimeHost(),
        ownsDevice: () => true,
        bindDeployment: async (_device, signal) => ({
          uninstallApp: async () => ({ wasInstalled: false as const }),
          materializeAppSource: async () => ({
            installablePath: '/tmp/app',
            cleanup: async () => {},
          }),
          deployApp: (input) => deployApp(_device, input, signal),
          deployMaterializedApp: (input) => deployMaterializedApp(_device, input, signal),
        }),
      },
      limrunIosDevice,
      controller.signal,
    );

    const pending = invoke(operations);
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
  },
);

async function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    if (!signal) {
      reject(new Error('provider deployment callback was not given the binding signal'));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
