import { expect, test, vi } from 'vitest';
import {
  createDoublespeedAppDeploymentOperations,
  doublespeedAppDeploymentFacts,
} from './deployment-runtime.ts';
import { doublespeedIosDevice, unusedDoublespeedHost } from './runtime.fixtures.ts';

test('classifies deployment as unavailable without provider deployment callbacks', () => {
  const facts = doublespeedAppDeploymentFacts(
    { host: unusedDoublespeedHost(), ownsDevice: () => true },
    doublespeedIosDevice,
  );
  for (const operation of [
    facts.deployApp,
    facts.materializeAppSource,
    facts.deployMaterializedApp,
  ]) {
    expect(operation).toMatchObject({ available: false, reason: 'owner-capability-missing' });
  }
  expect(facts.sendPushNotification).toMatchObject({ reason: 'unsupported-provider-mode' });
});

test('uses the admitted provider deployment without a local fallback', async () => {
  const deployApp = vi.fn(async () => ({
    bundleId: 'com.example.app',
    launchTarget: 'com.example.app',
  }));
  const deployMaterializedApp = vi.fn(async () => ({
    bundleId: 'com.example.app',
    launchTarget: 'com.example.app',
  }));
  const materializeApple = vi.fn(async () => ({
    installablePath: '/tmp/App.app',
    cleanup: async () => {},
  }));
  const base = unusedDoublespeedHost();
  const options = {
    host: {
      ...base,
      appleDeployment: { ...base.appleDeployment, prepareArtifact: materializeApple },
    },
    ownsDevice: () => true,
    deployApp,
    deployMaterializedApp,
  };
  const facts = doublespeedAppDeploymentFacts(options, doublespeedIosDevice);
  const operations = createDoublespeedAppDeploymentOperations(
    options,
    doublespeedIosDevice,
    new AbortController().signal,
  );

  for (const fact of [facts.deployApp, facts.materializeAppSource, facts.deployMaterializedApp]) {
    expect(fact).toEqual({ available: true });
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
  expect(materializeApple).toHaveBeenCalledOnce();
});

test('refuses deployment on a device that is not a Doublespeed simulator', () => {
  const facts = doublespeedAppDeploymentFacts(
    {
      host: unusedDoublespeedHost(),
      ownsDevice: () => true,
      deployApp: async () => undefined,
      deployMaterializedApp: async () => undefined,
    },
    { ...doublespeedIosDevice, kind: 'device' },
  );
  expect(facts.deployApp).toMatchObject({ available: false });
});

test('aborts an in-flight deployment with the binding signal', async () => {
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during Doublespeed deployment');
  const deployApp = vi.fn(async (_device, _input, signal: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    return await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const operations = createDoublespeedAppDeploymentOperations(
    {
      host: unusedDoublespeedHost(),
      ownsDevice: () => true,
      deployApp,
      deployMaterializedApp: async () => undefined,
    },
    doublespeedIosDevice,
    controller.signal,
  );
  const pending = operations.deployApp?.({
    app: 'com.example.app',
    appPath: '/tmp/app',
    replaceExisting: false,
  });
  controller.abort(abortReason);
  await expect(pending).rejects.toBe(abortReason);
});
